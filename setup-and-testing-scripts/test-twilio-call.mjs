// A real phone-network test. Requires an explicitly configured automated target.
import assert from "node:assert/strict";
import twilio from "twilio";
import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
import { GENERIC_CLI_POLICY_VERSION } from "../fastify-app/generic-cli.mjs";
if (!process.env.ELEVENLABS_API_KEY) loadPhoneclawEnv();
const env = process.env;
const required = ["TWILIO_ACCOUNT_SID", "TWILIO_TEST_FROM", "TWILIO_TEST_TO", "ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "PHONECLAW_TEST_CWD", "PHONECLAW_TEST_PROJECT_ROOT", "PHONECLAW_TEST_REVISION", "WEB_SEARCH_TOKEN", "PHONECLAW_WORKER_BASE_URL"];
const missing = required.filter(key => !env[key]);
if (!env.TWILIO_AUTH_TOKEN && !(env.TWILIO_API_KEY && env.TWILIO_API_SECRET)) missing.push("TWILIO_AUTH_TOKEN or TWILIO_API_KEY + TWILIO_API_SECRET");
if (missing.length) throw new Error(`Missing test configuration: ${missing.join(", ")}`);
if (!process.argv.includes("--place-call")) throw new Error("Pass --place-call to initiate one billable automated call. See docs/AUTOMATED_CALL_TESTING.md");
for (const key of ["TWILIO_TEST_FROM", "TWILIO_TEST_TO"]) assert.match(env[key], /^\+[1-9]\d{7,14}$/);
const client = twilio(env.TWILIO_API_KEY || env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY ? env.TWILIO_API_SECRET : env.TWILIO_AUTH_TOKEN, { accountSid: env.TWILIO_ACCOUNT_SID, autoRetry: false, timeout: 15000 });
const worker = new URL(env.PHONECLAW_WORKER_BASE_URL);
assert.equal(worker.protocol, "https:");
const owned = await client.incomingPhoneNumbers.list({ phoneNumber: env.TWILIO_TEST_TO, limit: 2 });
assert.equal(owned.length, 1, "Target must be a phone number owned by this Twilio account");
const voiceUrl = new URL(owned[0].voiceUrl);
assert.equal(voiceUrl.origin, worker.origin, "Target must point at the intended PhoneClaw Worker");
assert.equal(voiceUrl.pathname, "/twilio/inbound", "Target must use the real inbound route");
async function tool(body) {
  const response = await fetch(new URL("/cli/run", worker), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.WEB_SEARCH_TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  return response.json();
}
const preflight = await tool({ command: "pwd", cwd: env.PHONECLAW_TEST_CWD });
assert.equal(preflight.ok, true);
assert.equal(preflight.policy_version, GENERIC_CLI_POLICY_VERSION, "Deploy the PR before testing it");
const head = await tool({ command: "git rev-parse HEAD", cwd: env.PHONECLAW_TEST_PROJECT_ROOT, confirmed: true });
assert.equal(head.ok, true);
assert.equal(head.stdout.trim(), env.PHONECLAW_TEST_REVISION, "Deployed checkout differs from expected revision");
const phrase = `Please use run CLI with command P W D and working directory ${env.PHONECLAW_TEST_CWD}. Tell me the working directory returned by the tool.`;
const twiml = new twilio.twiml.VoiceResponse();
twiml.pause({ length: 6 });
twiml.say({ voice: "alice", language: "en-US" }, phrase);
twiml.pause({ length: 35 });
twiml.hangup();
const started = Math.floor(Date.now() / 1000);
let call;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
async function eleven(path) {
  const r = await fetch(`https://api.elevenlabs.io/v1/convai${path}`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ElevenLabs returned HTTP ${r.status}`);
  return r.json();
}
try {
  // No retries: an ambiguous create response must not place a second call.
  call = await client.calls.create({ to: env.TWILIO_TEST_TO, from: env.TWILIO_TEST_FROM, twiml: twiml.toString(), timeout: 20, timeLimit: 90 });
  console.log(JSON.stringify({ call_started: true, call_sid: call.sid }));
  for (let i = 0; i < 55 && !terminal.has(call.status); i++) { await wait(2000); call = await client.calls(call.sid).fetch(); }
  assert.equal(call.status, "completed", "Twilio call did not complete normally");
  // Twilio-to-Twilio calls have separate outgoing and incoming call SIDs.
  const inbound = (await client.calls.list({ to: env.TWILIO_TEST_TO, from: env.TWILIO_TEST_FROM, limit: 20 })).filter(c => c.direction === "inbound" && Math.floor(new Date(c.dateCreated).getTime() / 1000) >= started - 2);
  assert.equal(inbound.length, 1, "Cannot uniquely correlate the incoming test call");
  const sid = inbound[0].sid;
  let matched;
  for (let i = 0; i < 30 && !matched; i++) {
    const recent = await eleven(`/conversations?agent_id=${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}&page_size=20`);
    for (const item of recent.conversations || []) {
      if (item.start_time_unix_secs < started - 2) continue;
      const detail = await eleven(`/conversations/${item.conversation_id}`);
      const actualSid = detail.metadata?.phone_call?.call_sid || detail.metadata?.twilio_call_sid || detail.conversation_initiation_client_data?.dynamic_variables?.twilio_call_sid;
      if (actualSid === sid) { matched = detail; break; }
    }
    if (!matched) await wait(2000);
  }
  assert.ok(matched, "No ElevenLabs transcript correlated to the Twilio Call SID");
  const results = matched.transcript?.flatMap(t => t.tool_results || []) || [];
  const cliResult = results.find(r => r.tool_name === "run_cli");
  const value = typeof cliResult?.result_value === "string" ? JSON.parse(cliResult.result_value) : cliResult?.result_value;
  const checks = { twilio_completed: call.status === "completed", conversation_correlated: true, run_cli_ok: cliResult?.is_error === false && value?.ok === true, expected_policy: value?.policy_version === GENERIC_CLI_POLICY_VERSION, expected_directory: value?.working_directory === env.PHONECLAW_TEST_CWD, user_audio_transcribed: matched.transcript?.some(t => t.role === "user" && t.message?.length > 0) };
  console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), transport: "twilio_pstn", revision: env.PHONECLAW_TEST_REVISION, call_sid: call.sid, incoming_call_sid: sid, conversation_id: matched.conversation_id, checks }, null, 2));
  assert.ok(Object.values(checks).every(Boolean), "Twilio functionality test failed");
} finally {
  if (call && !terminal.has(call.status)) await client.calls(call.sid).update({ status: ["queued", "ringing"].includes(call.status) ? "canceled" : "completed" });
}
