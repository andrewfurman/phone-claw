// Phone test for Apple Notes edits (#150): a Twilio test caller asks PhoneClaw to add a line to a disposable note,
// then says yes. Passes only if the agent previewed first (confirmation_required), saved after the yes
// (notes_updated) and the line is really in the note. Run test-notes-edit-live.mjs --write first.
//   node setup-and-testing-scripts/test-notes-edit-call.mjs --place-call
import assert from "node:assert/strict";
import twilio from "twilio";
import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
if (!process.env.ELEVENLABS_API_KEY) loadPhoneclawEnv();
if (!process.argv.includes("--place-call")) throw new Error("Pass --place-call to place one billable automated call.");
const env = process.env, title = env.NOTES_EDIT_TEST_TITLE || "Zebra test list", item = env.NOTES_EDIT_TEST_ITEM || "Pineapple";
const client = twilio(env.TWILIO_API_KEY || env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY ? env.TWILIO_API_SECRET : env.TWILIO_AUTH_TOKEN, { accountSid: env.TWILIO_ACCOUNT_SID, autoRetry: false });
const twiml = new twilio.twiml.VoiceResponse();
twiml.pause({ length: 6 });
twiml.say({ voice: "alice" }, `This is an automated PhoneClaw test call. Please add ${item.toLowerCase()} to my Apple note called ${title}.`);
twiml.pause({ length: 40 });
twiml.say({ voice: "alice" }, "Yes, please make that change.");
twiml.pause({ length: 30 });
twiml.say({ voice: "alice" }, "Thank you. This was an automated PhoneClaw test call. Goodbye.");
twiml.pause({ length: 6 });
twiml.hangup();
const started = Math.floor(Date.now() / 1000), wait = ms => new Promise(r => setTimeout(r, ms));
const eleven = p => fetch(`https://api.elevenlabs.io/v1/convai${p}`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }).then(r => r.json());
let call = await client.calls.create({ to: env.TWILIO_TEST_TO, from: env.TWILIO_TEST_FROM, twiml: twiml.toString(), timeout: 20, timeLimit: 150 });
console.log(JSON.stringify({ call_started: true, call_sid: call.sid }));
for (let i = 0; i < 90 && !["completed", "busy", "failed", "no-answer", "canceled"].includes(call.status); i++) { await wait(2000); call = await client.calls(call.sid).fetch(); }
assert.equal(call.status, "completed");
let detail;
for (let i = 0; i < 40 && !detail; i++) {
  const recent = await eleven(`/conversations?agent_id=${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}&page_size=3`);
  const conv = (recent.conversations || []).find(c => c.start_time_unix_secs >= started - 2);
  if (conv) { const d = await eleven(`/conversations/${conv.conversation_id}`); if (["done", "failed"].includes(d.status)) detail = d; }
  if (!detail) await wait(3000);
}
assert.ok(detail, "No finalized conversation");
const results = detail.transcript.flatMap(t => t.tool_results || []).map(r => { try { return typeof r.result_value === "string" ? JSON.parse(r.result_value) : r.result_value; } catch { return {}; } });
const data = results.map(r => r?.data || r);
const checks = {
  previewed_first: data.some(d => d?.action === "notes_edit_preview_required" || d?.action === "notes_edit_confirmation_required"),
  saved_after_yes: data.some(d => d?.action === "notes_updated"),
  line_in_note: data.some(d => d?.action === "notes_updated" && (d.after_lines || []).some(l => l.toLowerCase().includes(item.toLowerCase()))),
  no_tool_errors: !detail.transcript.flatMap(t => t.tool_results || []).some(r => r.is_error),
};
console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), call_sid: call.sid, conversation_id: detail.conversation_id, checks }, null, 2));
assert.ok(Object.values(checks).every(Boolean), "Notes edit phone test failed");
