import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../cloudflare-worker/twilio-elevenlabs-worker.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-http-test-")));
mkdirSync(join(root, "child"));
const token = "synthetic-bridge-token";
const server = spawn(process.execPath, ["fastify-app/server.mjs"], {
  env: { PATH: process.env.PATH, HOME: root, PORT: "0", HOST: "127.0.0.1", CLI_BRIDGE_TOKEN: token, GENERIC_CLI_ALLOWED_DIRS: root, PHONECLAW_TEST_MARKER: "synthetic-private-marker" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", data => { logs += data; });
server.stderr.on("data", data => { logs += data; });
const checks = {};
try {
  const deadline = Date.now() + 10000;
  while (!/Server listening at (http:\/\/127\.0\.0\.1:\d+)/.test(logs)) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error("Test bridge did not start");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const base = logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)[1];
  const send = (body, auth = token) => fetch(`${base}/cli/run`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  checks.auth_required = (await send({ command: "pwd", cwd: root }, "wrong-token")).status === 401;
  const nested = await (await send({ command: "pwd", cwd: join(root, "child") })).json();
  checks.nested_directory = nested.ok === true && nested.working_directory === join(root, "child");
  const deniedResponse = await send({ command: "touch denied.txt", cwd: root });
  checks.confirmation_response = deniedResponse.status === 200 && (await deniedResponse.json()).status === "confirmation_required";
  checks.no_unconfirmed_write = !existsSync(join(root, "denied.txt"));
  const secret = await (await send({ command: 'printf "%s" "$PHONECLAW_TEST_MARKER"', cwd: root, confirmed: true })).json();
  checks.server_env_filtered = secret.ok === true && secret.stdout === "";
  const workerEnv = { WEB_SEARCH_TOKEN: "synthetic-worker-token", CLI_BRIDGE_URL: base, CLI_BRIDGE_TOKEN: token };
  const proxy = await worker.fetch(new Request("https://worker.example/cli/run", { method: "POST", headers: { authorization: "Bearer synthetic-worker-token", "content-type": "application/json" }, body: JSON.stringify({ command: "pwd", cwd: join(root, "child") }) }), workerEnv, {});
  const body = await proxy.json();
  checks.worker_proxy = proxy.status === 200 && body.ok === true && body.working_directory === join(root, "child");
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  console.log(JSON.stringify({ ok: true, checks, note: "Real Fastify HTTP handler and Worker proxy, local fixtures only" }, null, 2));
} finally {
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
}
