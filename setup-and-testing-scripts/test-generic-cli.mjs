import {
  classifyGenericCliCommand,
  findBlockedReason,
  runGenericCli,
} from "../fastify-app/generic-cli.mjs";

const previousAllowed = process.env.GENERIC_CLI_ALLOWED_DIRS;
process.env.GENERIC_CLI_ALLOWED_DIRS = process.cwd();

const success = await runGenericCli({
  command: "printf 'hello-phoneclaw\\n'",
});

const failure = await runGenericCli({
  command: "bash -lc 'exit 7'",
});

const confirmation = await runGenericCli({
  command: "git commit --allow-empty -m probe",
});

const confirmedDangerous = classifyGenericCliCommand("git commit --allow-empty -m probe");

const blocked = await runGenericCli({
  command: "printenv",
});

const blockedPath = await runGenericCli({
  command: "cat ~/.config/gh/hosts.yml",
});

const missing = await runGenericCli({
  command: "   ",
});

const timeout = await runGenericCli({
  command: "sleep 2",
  timeoutMs: 200,
});

const cwdDenied = await runGenericCli({
  command: "pwd",
  cwd: "/tmp/phoneclaw-not-allowed-cwd",
});

process.env.GENERIC_CLI_ALLOWED_DIRS = previousAllowed;

const checks = {
  success_ok: success.ok === true && success.exit_code === 0,
  success_stdout: String(success.stdout || "").includes("hello-phoneclaw"),
  success_status: success.status === "ok",
  failure_not_ok: failure.ok === false && failure.status === "cli_failed",
  failure_exit_code: failure.exit_code === 7,
  confirmation_required: confirmation.status === "confirmation_required",
  confirmation_classifies_dangerous: confirmedDangerous.kind === "dangerous",
  blocked_printenv: blocked.status === "command_blocked",
  blocked_secret_path: blockedPath.status === "command_blocked",
  blocked_reason_helper: Boolean(findBlockedReason("printenv")),
  missing_field: missing.status === "missing_field",
  timeout_status: timeout.status === "cli_timeout",
  cwd_not_allowed: cwdDenied.status === "working_directory_not_allowed",
  success_has_answer_text: Boolean(success.answer_text),
};

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      checks,
      samples: {
        success_status: success.status,
        failure_status: failure.status,
        confirmation_status: confirmation.status,
        blocked_status: blocked.status,
        timeout_status: timeout.status,
        cwd_status: cwdDenied.status,
      },
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);
