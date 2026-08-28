import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "phoneclaw-claude-auth-"));
const fakeClaude = join(tempDir, "claude");

await writeFile(
  fakeClaude,
  [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args.join(' ') === 'auth status --json') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));",
    "  process.exit(0);",
    "}",
    "if (args.includes('-p')) {",
    "  console.log('Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.');",
    "  process.exit(1);",
    "}",
    "process.exit(2);",
    "",
  ].join("\n"),
  "utf8"
);
await chmod(fakeClaude, 0o755);

process.env.CLAUDE_BIN = fakeClaude;
process.env.CLAUDE_CODE_AUTH_PROBE = "true";

const { claudeCodeTool } = await import("../fastify-app/claude-code-tools.mjs");

try {
  const expired = await claudeCodeTool({ action: "auth_status" });
  const startWithExpiredAuth = await claudeCodeTool({ action: "start_session" });
  const submitWithExpiredAuth = await claudeCodeTool({
    action: "submit_task",
    task: "Validation only. Do not run.",
    confirmed: true,
  });

  process.env.CLAUDE_CODE_AUTH_PROBE = "false";
  const skipped = await claudeCodeTool({ action: "auth_status" });

  const checks = {
    expired_detected: expired.status === "claude_auth_expired",
    expired_not_authenticated: expired.authenticated === false,
    expired_probe_failed: expired.auth_probe?.status === "claude_auth_expired",
    expired_answer_mentions_reauth: /Re-authenticate Claude Code/i.test(expired.answer_text),
    start_session_blocks_expired_auth:
      startWithExpiredAuth.status === "claude_auth_expired" &&
      startWithExpiredAuth.authenticated === false,
    submit_task_blocks_expired_auth:
      submitWithExpiredAuth.status === "claude_auth_expired" &&
      submitWithExpiredAuth.authenticated === false,
    probe_can_be_skipped: skipped.status === "ok" && skipped.authenticated === true,
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(
    JSON.stringify(
      {
        ok,
        checks,
        expired: {
          status: expired.status,
          authenticated: expired.authenticated,
          auth_probe_status: expired.auth_probe?.status,
        },
        start_with_expired_auth: {
          status: startWithExpiredAuth.status,
          authenticated: startWithExpiredAuth.authenticated,
        },
        submit_with_expired_auth: {
          status: submitWithExpiredAuth.status,
          authenticated: submitWithExpiredAuth.authenticated,
        },
        skipped: {
          status: skipped.status,
          authenticated: skipped.authenticated,
          auth_probe_status: skipped.auth_probe?.status,
        },
      },
      null,
      2
    )
  );

  process.exit(ok ? 0 : 1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
