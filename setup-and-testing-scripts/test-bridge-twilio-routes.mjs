import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bridge must not expose unauthenticated Twilio call routes by default:
// the Worker handles calls; a forged POST here could start an agent session.
async function withBridge(extraEnv, fn) {
  const root = mkdtempSync(join(tmpdir(), "phoneclaw-twilio-routes-"));
  const server = spawn(process.execPath, [new URL("../fastify-app/server.mjs", import.meta.url).pathname], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, PORT: "0", HOST: "127.0.0.1", CLI_BRIDGE_TOKEN: "t".repeat(40), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (d) => { logs += d; });
  server.stderr.on("data", (d) => { logs += d; });
  try {
    const deadline = Date.now() + 10_000;
    while (!/Server listening at (http:\/\/127\.0\.0\.1:\d+)/.test(logs)) {
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`bridge did not start: ${logs.slice(-500)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    await fn(logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)[1]);
  } finally {
    server.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

const form = { "content-type": "application/x-www-form-urlencoded" };
const fakeCall = "From=%2B15555550100&To=%2B15555550199&CallSid=CAfake";

test("bridge Twilio call routes are off by default", () => withBridge({}, async (base) => {
  for (const path of ["/twilio/inbound", "/twilio/outbound", "/twilio/stream-status", "/twilio/call-status"]) {
    const r = await fetch(base + path, { method: "POST", headers: form, body: fakeCall });
    assert.equal(r.status, 404, path);
  }
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.bridge_twilio_routes_enabled, false);
}));

test("bridge Twilio call routes can be re-enabled explicitly", () => withBridge({ PHONECLAW_BRIDGE_TWILIO_ROUTES: "true" }, async (base) => {
  const r = await fetch(`${base}/twilio/inbound`, { method: "POST", headers: form, body: "" });
  assert.notEqual(r.status, 404);
}));
