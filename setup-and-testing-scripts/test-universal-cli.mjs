import assert from "node:assert/strict";
import { test, before, after, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUniversalCli, UNIVERSAL_CLI_VERSION } from "../fastify-app/universal-cli.mjs";
import { CLI_COMMAND_CATALOG } from "../shared/cli-command-catalog.mjs";
import { commandAdapters } from "../fastify-app/cli-adapters.mjs";
import { universalCliTool, universalPrompt } from "../shared/universal-cli-agent.mjs";
import { UNIVERSAL_SMOKE_SCENARIOS, smokeRequest, matchesSmokeCall, validateSmokeResult } from "../shared/universal-cli-smoke-scenarios.mjs";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-universal-")));
const fixture = join(root, "fixture-cli");
const configPath = join(root, "programs.json");
const secret = "synthetic-only-provider-secret-106";
const run = options => runUniversalCli({ cwd: root, ...options });
const builtin = (name, options = {}, outer = {}) => run({ command: "phoneclaw", args: [...name.split(" "), "--json", JSON.stringify(options)], ...outer });
function config(overrides = {}) {
  writeFileSync(configPath, JSON.stringify({ fixture: { executable: fixture, env: ["EXAMPLE_API_KEY"], readOnlyArgs: [["version"]], ...overrides } }));
}
before(() => {
  process.env.GENERIC_CLI_ALLOWED_DIRS = root;
  process.env.GENERIC_CLI_PROGRAMS_PATH = configPath;
  process.env.EXAMPLE_API_KEY = secret;
  process.env.ELEVENLABS_API_KEY = "synthetic-only-elevenlabs-secret-106";
  process.env.SENDGRID_API_KEY = "synthetic-only-sendgrid-secret-106";
  process.env.HOME = root;
  delete process.env.RSS_FEEDS_JSON;
  delete process.env.RSS_FEEDS_CONFIG_PATH;
  delete process.env.CONVERSATION_DATABASE_URL;
  config();
  writeFileSync(fixture, `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==="big") process.stdout.write("é".repeat(900000));\nelse if(args[0]==="sleep") setTimeout(()=>console.log("late"),10000);\nelse if(args[0]==="fork") {const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setTimeout(()=>{},10000)"],{stdio:"inherit"});require("node:fs").writeFileSync(args[1],String(child.pid));}\nelse if(args[0]==="secret") console.log(process.env.EXAMPLE_API_KEY);\nelse console.log(JSON.stringify({args,own_credential:!!process.env.EXAMPLE_API_KEY,unrelated_credential:!!process.env.ELEVENLABS_API_KEY,node_hook:!!process.env.NODE_OPTIONS}));\n`, { mode: 0o700 });
});
afterEach(() => { globalThis.fetch = originalFetch; config(); });
after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

test("a new installed CLI works without a registry entry or a new tool schema", async () => {
  const r = await run({ command: fixture, args: ["literal", "hello world"], confirmed: true });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.stdout).args, ["literal", "hello world"]);
  assert.equal(JSON.parse(r.stdout).own_credential, false);
  assert.equal(r.runner_version, UNIVERSAL_CLI_VERSION);
});
test("argv is literal even when it contains shell syntax and substitutions", async () => {
  const marker = join(root, "should-not-exist");
  const args = ["literal", `$(touch ${marker})`, `x; touch ${marker}`, "a && b", "'quoted'"];
  const r = await run({ command: "fixture", args, confirmed: true });
  assert.equal(r.ok, true);assert.deepEqual(JSON.parse(r.stdout).args, args);assert.equal(existsSync(marker), false);
});
test("confirmation accepts only exact true and cannot be put inside --json", async () => {
  for (const confirmed of [undefined, false, "false", "yes", 1]) {
    assert.equal((await run({ command: "fixture", args: [], confirmed })).status, "confirmation_required");
    const result = await builtin("github issue-create", { repo: "owner/repo", title: "Synthetic", confirmed: true }, { confirmed });
    assert.equal(result.status, "confirmation_required");
  }
  assert.equal((await run({ command: "fixture", args: [], confirmed: "true" })).ok, true);
});
test("operator-approved argv matches the entire command, never an unsafe prefix", async () => {
  assert.equal((await run({ command: "fixture", args: ["version"] })).ok, true);
  assert.equal((await run({ command: "fixture", args: ["version", "--execute", "bad"] })).status, "confirmation_required");
  assert.equal((await run({ command: "fixture", args: ["version; bad"] })).status, "confirmation_required");
});
test("native programs receive only scoped credentials and cannot override HOME or hooks", async () => {
  const r = await run({ command: "fixture", args: ["version"], env: { EXAMPLE_API_KEY: "caller", ELEVENLABS_API_KEY: "caller", NODE_OPTIONS: "--require bad", HOME: "/elsewhere" } });
  const output = JSON.parse(r.stdout);
  assert.equal(output.own_credential, true);assert.equal(output.unrelated_credential, false);assert.equal(output.node_hook, false);
  const raw = await run({ command: 'printf "%s" "$EXAMPLE_API_KEY"', confirmed: true });
  assert.equal(raw.stdout, "");
});
test("invalid policy cannot pass bridge credentials or runtime injection variables", async () => {
  for (const env of [["ELEVENLABS_API_KEY"], ["NODE_OPTIONS"], ["BASH_ENV"], ["CLI_BRIDGE_TOKEN"]]) {
    config({ env });assert.equal((await run({ command: "fixture", args: ["version"] })).status, "cli_execution_error");
  }
});
test("provider tokens are redacted even when they lack a recognizable prefix", async () => {
  const r = await run({ command: "fixture", args: ["secret"], confirmed: true });
  assert.equal(r.ok, true);assert.equal(r.stdout.trim(), "[redacted]");assert.equal(JSON.stringify(r).includes(secret), false);
});
test("native timeouts terminate descendant processes", async () => {
  const pidPath = join(root, "child.pid");
  const start = Date.now();
  const r = await run({ command: "fixture", args: ["fork", pidPath], confirmed: true, timeoutMs: 1000 });
  assert.equal(r.status, "cli_timeout");assert.ok(Date.now() - start < 5000);
  const pid = Number(readFileSync(pidPath, "utf8"));
  // Linux may briefly retain a killed orphan as a zombie; it cannot execute.
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive && process.platform === "linux") assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /\) Z /);
  else assert.equal(alive, false);
});
test("output is bounded before retention and missing executables are explicit", async () => {
  const r = await run({ command: "fixture", args: ["big"], confirmed: true, maxRawBytes: 1000 });
  assert.equal(r.status, "output_limit_exceeded");assert.ok(Buffer.byteLength(r.stdout) <= 1003);assert.equal(r.stdout_truncated, true);
  assert.equal((await run({ command: join(root, "missing"), args: [], confirmed: true })).status, "cli_not_installed");
});
test("all prior application tools are discoverable behind one command and output schema", async () => {
  assert.equal(CLI_COMMAND_CATALOG.length, 34);
  assert.deepEqual(Object.keys(commandAdapters), CLI_COMMAND_CATALOG.map(x => x.command));
  const help = await run({ command: "phoneclaw", args: ["help"] });
  assert.equal(help.ok, true);assert.equal(help.data.length, 34);
  for (const command of CLI_COMMAND_CATALOG) {
    const r = await run({ command: "phoneclaw", args: [...command.command.split(" "), "--help"] });
    assert.equal(r.ok, true);assert.equal(r.data.command, command.command);
  }
});
test("JSON arguments are validated without executing a shell or unknown command", async () => {
  for (const args of [["rss", "feeds", "--json", "null"], ["rss", "feeds", "--json", "[]"], ["rss", "feeds", "--json", "bad"], ["rss", "feeds", ";", "touch x"], ["constructor", "prototype"]]) {
    assert.equal((await run({ command: "phoneclaw", args })).ok, false);
  }
  assert.equal((await run({ command: "fixture", args: [1] })).status, "invalid_arguments");
  assert.equal((await run({ command: "fixture", args: ["\0"] })).status, "invalid_arguments");
  assert.equal((await run({ command: "fixture", args: [], confirmed: true, cwd: "/etc" })).status, "working_directory_not_allowed");
});
test("mail writes preserve preview/emergency gates and mark-seen is a write", async () => {
  for (const mark_seen of [true, "true", 1, "yes", "0"]) assert.equal((await builtin("himalaya email-read", { id: "123", mark_seen })).status, "confirmation_required");
  const options = { to: "someone@example.com", subject: "Synthetic test", body: "Not sent", confirmed: true };
  assert.equal((await builtin("himalaya email-send", options, { confirmed: true })).status, "confirmation_required");
  const preview = await builtin("sendgrid email-send", options, { confirmed: true });
  assert.equal(preview.data.requires_preview, true);
  const confirm = await builtin("sendgrid email-send", { ...options, previewed: true });
  assert.equal(confirm.status, "confirmation_required");
  assert.equal(confirm.data.action, "sendgrid_email_send_confirmation_required");
});
test("confirmed SendGrid keeps recipient policy through the universal interface", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) });return { ok: true, status: 202, headers: new Headers({ "x-message-id": "synthetic-id" }), text: async () => "" }; };
  const r = await builtin("sendgrid email-send", { to: "recipient@example.com", subject: "Fixture", body: "Synthetic", previewed: true }, { confirmed: true });
  assert.equal(r.ok, true);assert.equal(r.data.action, "sendgrid_email_sent");assert.equal(requests.length, 1);
  assert.ok(requests[0].body.personalizations[0].cc.some(x => x.email === "aifurman@gmail.com"));
});
test("RSS/history remain explicit about missing configuration and web fetch blocks private hosts", async () => {
  assert.equal((await builtin("rss feeds")).status, "rss_feeds_not_configured");
  assert.equal((await builtin("history search", { query: "synthetic" })).status, "conversation_history_not_configured");
  const blocked = await builtin("web fetch", { url: "http://127.0.0.1/" });
  assert.equal(blocked.ok, false);
  assert.equal((await builtin("claude code", { action: "submit_task", task: "Synthetic", confirmed: true })).status, "confirmation_required");
});
test("large domain results are capped and no truncated object masquerades as complete JSON", async () => {
  const r = await run({ command: "phoneclaw", args: ["help"], maxRawBytes: 1000 });
  assert.equal(r.data_truncated, true);assert.equal(r.stdout_truncated, true);assert.equal(r.data, undefined);assert.ok(Buffer.byteLength(r.stdout) <= 1003);
});
test("structured redaction preserves JSON when provider secrets contain quotes and newlines", async () => {
  const previous = commandAdapters["rss feeds"];
  const secret = 'synthetic-secret-"quoted"\nwith-newline';
  process.env.EXAMPLE_ESCAPED_SECRET = secret;
  commandAdapters["rss feeds"] = async () => ({ ok: true, text: `before ${secret} after`, token: "synthetic-token-value", nested: { text: 'literal "quotes"' } });
  try {
    const r = await builtin("rss feeds");
    assert.equal(r.ok, true);assert.equal(r.data.text, "before [redacted] after");
    assert.equal(r.data.token, "[redacted]");assert.equal(r.data.nested.text, 'literal "quotes"');
  } finally { commandAdapters["rss feeds"] = previous;delete process.env.EXAMPLE_ESCAPED_SECRET; }
});
test("agent provisioning exposes one schema and replaces obsolete tool instructions idempotently", () => {
  const guide = readFileSync(new URL("../elevenlabs-setup/prompt-templates/universal-cli.md", import.meta.url), "utf8");
  const next = universalPrompt("Personal instruction.\n\nWeb search capability:\nOld many-tool instructions", guide);
  assert.ok(next.startsWith("Personal instruction."));assert.equal(next.includes("Old many-tool instructions"), false);
  assert.equal(universalPrompt(next, guide), next);
  for (const { command } of CLI_COMMAND_CATALOG) assert.ok(guide.includes(`phoneclaw ${command}`));
  const tool = universalCliTool({ url: "https://example.com/cli/run", token: "synthetic" });
  assert.equal(tool.name, "run_cli");assert.equal(tool.api_schema.request_body_schema.properties.args.type, "array");
  assert.equal(tool.api_schema.response_body_schema, null);
});
test("live call assertions require the requested operation and successful structured data", () => {
  for (const scenario of UNIVERSAL_SMOKE_SCENARIOS) {
    const request = smokeRequest(scenario);
    assert.equal(matchesSmokeCall(scenario, request), true);
    assert.equal(matchesSmokeCall(scenario, { ...request, confirmed: true }), false);
    assert.equal(matchesSmokeCall(scenario, { command: "pwd" }), false);
    // Native allowlisted reads (gws agenda / notes) may accept answer_text-only success.
    const answerOnlyOk = scenario.id === "gws_agenda" || scenario.id === "notes_recent";
    assert.equal(validateSmokeResult(scenario, { ok: true, answer_text: "It worked" }), answerOnlyOk);
    assert.equal(validateSmokeResult(scenario, { ok: false, data: { ok: true } }), false);
  }
  const github = UNIVERSAL_SMOKE_SCENARIOS.find(s => s.id === "github");
  const result = { ok: true, data: { ok: true, action: "issue_list", parsed_json: [] } };
  assert.equal(validateSmokeResult(github, result), true);
  assert.equal(validateSmokeResult(github, { ...result, data_truncated: true }), false);
  assert.equal(matchesSmokeCall(github, { command: "phoneclaw", args: ["github", "common", "--json", '{"action":"issue_list","repo":"someone/else"}'] }), false);
});
