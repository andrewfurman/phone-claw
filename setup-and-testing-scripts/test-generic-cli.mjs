import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGenericCliCommand, findBlockedReason, runGenericCli, GENERIC_CLI_POLICY_VERSION } from "../fastify-app/generic-cli.mjs";

const originalEnv = { ...process.env };
const directory = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-cli-test-")));
const root = join(directory, "allowed");
const child = join(root, "child");
const outside = join(directory, "allowed-sibling");
for (const dir of [root, child, outside, join(root, "..cache")]) mkdirSync(dir, { recursive: true });
symlinkSync(outside, join(root, "escape"));
symlinkSync(child, join(root, "inside-link"));
process.env.GENERIC_CLI_ALLOWED_DIRS = root;
delete process.env.GENERIC_CLI_SHELL;
delete process.env.GENERIC_CLI_ENV_ALLOWLIST;

after(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
});

test("allowed roots, descendants, dot-prefixed names and internal symlinks work", async () => {
  for (const cwd of [root, child, join(root, "..cache"), join(root, "inside-link")]) {
    const result = await runGenericCli({ command: "pwd", cwd });
    assert.equal(result.status, "ok");
    assert.equal(result.stdout.trim(), realpathSync(cwd));
    assert.equal(result.policy_version, GENERIC_CLI_POLICY_VERSION);
  }
  assert.equal((await runGenericCli({ command: "ls -la", cwd: root })).status, "ok");
});

test("rejects traversal, sibling prefixes, outside symlinks, files and missing paths", async () => {
  const file = join(root, "plain-file");
  writeFileSync(file, "fixture");
  for (const cwd of [directory, outside, join(child, "../.."), join(root, "escape"), file, join(root, "missing")]) {
    assert.equal((await runGenericCli({ command: "pwd", cwd })).status, "working_directory_not_allowed");
  }
});

test("shell syntax, interpreters, writes and unknown commands require confirmation", async () => {
  const commands = [
    "printf 'probe' > probe.txt", "touch probe.txt", "cp plain-file probe.txt",
    "gh issue create --title probe --body probe", "curl -X POST https://example.invalid",
    "git commit --allow-empty -m probe", "git status", "bash -c 'touch probe.txt'",
    "python3 -c 'open(\"probe.txt\",\"w\").close()'", "ls; touch probe.txt",
    "ls && touch probe.txt", "ls | tee probe.txt", "ls\ntouch probe.txt",
    "ls $(touch probe.txt)", "ls `touch probe.txt`", "ls > probe.txt",
    "ls /", "pwd --help", "PATH=/tmp ls", "/bin/ls", "ls -I anything", "ls\t-la",
  ];
  for (const command of commands) {
    assert.equal(classifyGenericCliCommand(command).needs_confirmation, true, command);
    const result = await runGenericCli({ command, cwd: root });
    assert.equal(result.status, "confirmation_required", command);
  }
  assert.equal(existsSync(join(root, "probe.txt")), false);
});

test("only explicit true authorizes a shell command", async () => {
  for (const confirmed of [false, "false", "yes", 1, [], {}, null]) {
    assert.equal((await runGenericCli({ command: "touch probe.txt", cwd: root, confirmed })).status, "confirmation_required");
  }
  for (const confirmed of [true, "true"]) {
    const result = await runGenericCli({ command: "printf 'authorized' > probe.txt", cwd: root, confirmed });
    assert.equal(result.status, "ok");
    assert.equal(readFileSync(join(root, "probe.txt"), "utf8"), "authorized");
  }
});

test("child environment excludes secrets and shell startup hooks", async () => {
  process.env.PHONECLAW_TEST_MARKER = "synthetic-private-marker";
  process.env.SENDGRID_API_KEY = "synthetic-sendgrid-key";
  const startup = join(root, "startup.sh");
  writeFileSync(startup, `touch '${join(root, "startup-ran")}'\n`);
  process.env.BASH_ENV = startup;
  process.env.ENV = startup;
  process.env.GENERIC_CLI_ENV_ALLOWLIST = "PATH,HOME,LANG,NO_COLOR,SENDGRID_API_KEY,BASH_ENV,ENV,NODE_OPTIONS";
  const command = 'printf "%s|%s|%s|%s" "$PHONECLAW_TEST_MARKER" "$SENDGRID_API_KEY" "$BASH_ENV" "$LANG"';
  const result = await runGenericCli({ command, cwd: root, confirmed: true, env: {
    LANG: "C", SENDGRID_API_KEY: "override-secret", BASH_ENV: startup,
    PATH: outside, HOME: outside, NODE_OPTIONS: "--require=probe",
  } });
  assert.equal(result.status, "ok");
  assert.equal(result.stdout, "|||C");
  assert.equal(existsSync(join(root, "startup-ran")), false);
  const pathResult = await runGenericCli({ command: 'printf "%s" "$PATH"', cwd: root, confirmed: true, env: { PATH: outside } });
  assert.notEqual(pathResult.stdout, outside);
  delete process.env.GENERIC_CLI_ENV_ALLOWLIST;
});

test("blocked secret commands stay blocked even when confirmed", async () => {
  for (const command of ["printenv", "env", "export", "cat ~/.config/gh/hosts.yml", "cat bridge.env"]) {
    assert.ok(findBlockedReason(command));
    assert.equal((await runGenericCli({ command, cwd: root, confirmed: true })).status, "command_blocked");
  }
});

test("success, errors, limits and redaction keep the tool response contract", async () => {
  assert.equal((await runGenericCli({ command: " ", cwd: root })).status, "missing_field");
  assert.equal((await runGenericCli({ command: "x".repeat(8001), cwd: root })).status, "command_too_long");
  const failure = await runGenericCli({ command: "exit 7", cwd: root, confirmed: true });
  assert.equal(failure.status, "cli_failed");
  assert.equal(failure.exit_code, 7);
  const timeout = await runGenericCli({ command: "sleep 2", timeoutMs: 1000, cwd: root, confirmed: true });
  assert.equal(timeout.status, "cli_timeout");
  const redacted = await runGenericCli({ command: "printf 'ghp_syntheticOnly123\\n' >&2; exit 1", cwd: root, confirmed: true });
  assert.ok(!JSON.stringify(redacted).includes("ghp_syntheticOnly123"));
  const truncated = await runGenericCli({ command: "printf '%2000s' x", maxRawBytes: 1000, cwd: root, confirmed: true });
  assert.equal(truncated.stdout_truncated, true);
  assert.equal(Buffer.byteLength(truncated.stdout), 1000);
});
