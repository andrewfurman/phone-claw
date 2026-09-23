import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCodeTool,
  codingEngine,
  opencodeFailureStatus,
  summarizeOpencodeEvents,
} from "../fastify-app/claude-code-tools.mjs";

const event = (type, extra) => JSON.stringify({ type, sessionID: "ses_abc123", ...extra });

test("codingEngine defaults to Claude Code and switches only on opencode (#127)", () => {
  assert.equal(codingEngine({}), "claude");
  assert.equal(codingEngine({ PHONECLAW_CODING_ENGINE: "OpenCode" }), "opencode");
  assert.equal(codingEngine({ PHONECLAW_CODING_ENGINE: "other" }), "claude");
});

test("summarizeOpencodeEvents keeps the final message text, session id, cost and errors", () => {
  const out = [
    event("step_start", { part: { messageID: "m1" } }),
    event("text", { part: { messageID: "m1", text: "thinking out loud" } }),
    event("step_finish", { part: { cost: 0.001 } }),
    "not json",
    event("text", { part: { messageID: "m2", text: "Final answer" } }),
    event("step_finish", { part: { cost: 0.002 } }),
  ].join("\n");
  const s = summarizeOpencodeEvents(out);
  assert.equal(s.sessionId, "ses_abc123");
  assert.equal(s.finalText, "Final answer");
  assert.equal(Math.round(s.cost * 1000), 3);
  assert.equal(s.error, null);
  assert.ok(summarizeOpencodeEvents(event("error", { error: { data: { statusCode: 401 } } })).error);
});

test("OpenRouter failures map to clear statuses instead of retry loops", () => {
  assert.equal(opencodeFailureStatus({ data: { statusCode: 401 } }), "opencode_auth_failed");
  assert.equal(opencodeFailureStatus({ data: { statusCode: 402 } }), "opencode_out_of_credit");
  assert.equal(opencodeFailureStatus({ data: { statusCode: 429 } }), "opencode_rate_limited");
  assert.equal(opencodeFailureStatus({ data: { statusCode: 500 } }), "failed");
});

function withFakeOpencode(fn) {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-opencode-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    const fake = join(root, "opencode");
    const record = join(root, "argv.json");
    // Records argv/PWD/cwd; emits a failure when the task mentions FAIL_402.
    writeFileSync(fake, `#!${process.execPath}
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("1.18.32"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), pwd: process.env.PWD, cwd: process.cwd() }));
const task = process.argv[process.argv.length - 1];
const ev = (t, x) => console.log(JSON.stringify({ type: t, sessionID: "ses_fake1", ...x }));
if (task.includes("FAIL_402")) { ev("error", { error: { name: "APIError", data: { statusCode: 402, message: "Insufficient credits" } } }); process.exit(1); }
ev("text", { part: { messageID: "m1", text: "Did the work." } });
ev("step_finish", { part: { cost: 0.0004 } });
`, { mode: 0o700 });
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        PHONECLAW_CODING_ENGINE: "opencode",
        OPENCODE_BIN: fake,
        OPENROUTER_API_KEY: "sk-or-test",
        CLAUDE_CODE_ALLOWED_DIRS: repo,
        CLAUDE_CODE_JOB_DIR: join(root, "jobs"),
      });
      await fn({ root, repo, record });
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function finish(jobId) {
  for (let i = 0; i < 100; i += 1) {
    const status = await claudeCodeTool({ action: "job_status", jobId });
    if (status.status !== "running") return status;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("job did not finish");
}

const okFetch = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("opencode job runs in the requested repo (--dir and PWD), auto mode, and reuses the session", withFakeOpencode(async ({ repo, record }) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = okFetch({ data: { limit_remaining: 4.5 } });
  try {
    const auth = await claudeCodeTool({ action: "auth_status" });
    assert.equal(auth.status, "ok");
    assert.equal(auth.engine, "opencode");
    assert.equal(auth.limit_remaining, 4.5);

    const started = await claudeCodeTool({ action: "submit_task", task: "Do it", repoPath: repo, confirmed: true });
    assert.equal(started.engine, "opencode");
    assert.equal(started.model, "openrouter/deepseek/deepseek-v4.1-flash");
    const done = await finish(started.job_id);
    assert.equal(done.status, "completed");
    assert.equal(done.output_preview, "Did the work.");
    let rec = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(rec.pwd, repo);
    assert.equal(rec.cwd, repo);
    assert.equal(rec.argv[rec.argv.indexOf("--dir") + 1], repo);
    assert.ok(rec.argv.includes("--auto"));
    assert.ok(!rec.argv.includes("-s"), "first job starts a new OpenCode session");

    const again = await claudeCodeTool({ action: "submit_task", task: "Follow up", repoPath: repo, sessionId: started.session_id, confirmed: true });
    await finish(again.job_id);
    rec = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(rec.argv[rec.argv.indexOf("-s") + 1], "ses_fake1", "follow-up continues the OpenCode session");

    const plan = await claudeCodeTool({ action: "submit_task", task: "Plan it", repoPath: repo, mode: "plan", confirmed: true });
    await finish(plan.job_id);
    rec = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(rec.argv[rec.argv.indexOf("--agent") + 1], "plan");
    assert.ok(!rec.argv.includes("--auto"), "plan mode never auto-approves");
  } finally {
    globalThis.fetch = realFetch;
  }
}));

test("opencode reports out-of-credit jobs and bad keys plainly", withFakeOpencode(async ({ repo }) => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = okFetch({ data: { limit_remaining: 5 } });
    const started = await claudeCodeTool({ action: "submit_task", task: "FAIL_402", repoPath: repo, confirmed: true });
    const done = await finish(started.job_id);
    assert.equal(done.status, "opencode_out_of_credit");
    assert.match(done.answer_text, /out of credit or has hit its spending cap/);

    globalThis.fetch = okFetch({ error: { message: "User not found." } }, 401);
    const denied = await claudeCodeTool({ action: "submit_task", task: "x", repoPath: repo, confirmed: true });
    assert.equal(denied.status, "opencode_auth_failed");
    assert.match(denied.answer_text, /OpenRouter API key was rejected/);

    globalThis.fetch = okFetch({ data: { limit_remaining: 0 } });
    assert.equal((await claudeCodeTool({ action: "auth_status" })).status, "opencode_out_of_credit");

    delete process.env.OPENROUTER_API_KEY;
    assert.equal((await claudeCodeTool({ action: "auth_status" })).status, "opencode_not_configured");
  } finally {
    globalThis.fetch = realFetch;
  }
}));
