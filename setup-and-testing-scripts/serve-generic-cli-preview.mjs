// Temporary PR preview endpoint. Run as a restricted user; no production secrets.
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { runGenericCli, GENERIC_CLI_POLICY_VERSION } from "../fastify-app/generic-cli.mjs";

const token = process.env.PHONECLAW_TEST_TOOL_TOKEN;
const revision = process.env.PHONECLAW_TEST_REVISION;
if (!token || token.length < 32 || !/^[a-f0-9]{40}$/.test(revision || "") || !process.env.GENERIC_CLI_ALLOWED_DIRS) {
  throw new Error("Set a random PHONECLAW_TEST_TOOL_TOKEN (32+ chars), full PHONECLAW_TEST_REVISION, and GENERIC_CLI_ALLOWED_DIRS");
}
const app = Fastify({ logger: false });
app.addHook("onRequest", async (request, reply) => {
  const actual = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ ok: false });
});
app.get("/health", async () => ({ ok: true, revision, policy_version: GENERIC_CLI_POLICY_VERSION }));
app.post("/cli/run", async request => {
  const body = request.body || {};
  return { ...await runGenericCli({ command: body.command, cwd: body.cwd, confirmed: body.confirmed, timeoutMs: body.timeout_ms, maxRawBytes: body.max_raw_bytes, env: body.env }), revision };
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT || 18000) });
