import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
import { GENERIC_CLI_POLICY_VERSION } from "../fastify-app/generic-cli.mjs";

if (!process.env.ELEVENLABS_API_KEY) loadPhoneclawEnv();
const apiKey = process.env.ELEVENLABS_API_KEY;
const sourceAgentId = process.env.ELEVENLABS_AGENT_ID;
const endpoint = process.env.PHONECLAW_TEST_TOOL_URL;
const token = process.env.PHONECLAW_TEST_TOOL_TOKEN;
const cwd = process.env.PHONECLAW_TEST_CWD;
const revision = process.env.PHONECLAW_TEST_REVISION;
if (!apiKey || !sourceAgentId || !endpoint || !token || !cwd || !revision) {
  throw new Error("Missing ElevenLabs credentials or PHONECLAW_TEST_TOOL_URL/TOKEN/CWD/REVISION; see docs/AUTOMATED_CALL_TESTING.md");
}
if (new URL(endpoint).protocol !== "https:") throw new Error("Preview tool URL must use HTTPS");
const apiBase = "https://api.elevenlabs.io/v1/convai";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, method = "GET", body) {
  const response = await fetch(apiBase + path, { method, headers: { "xi-api-key": apiKey, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`ElevenLabs ${method} ${path.split('?')[0]} returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function tool(body) {
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  return response.json();
}
// Check the deployed PR code before creating a billable conversation.
const preflight = await tool({ command: "pwd", cwd });
assert.equal(preflight.ok, true);
assert.equal(preflight.policy_version, GENERIC_CLI_POLICY_VERSION);
assert.equal(preflight.revision, revision);
const denied = await tool({ command: "printf 'denied' > unconfirmed-probe.txt", cwd });
assert.equal(denied.status, "confirmation_required");
// A dedicated synthetic marker is set only on the preview process.
const filtered = await tool({ command: 'printf "%s" "$PHONECLAW_TEST_MARKER"', cwd, confirmed: true });
assert.equal(filtered.ok, true);
assert.equal(filtered.stdout, "");

const source = await api(`/agents/${sourceAgentId}`);
const snapshot = JSON.parse(await readFile(new URL("../elevenlabs-setup/andrew-assistant-agent.config.json", import.meta.url), "utf8"));
const configTool = structuredClone(snapshot.agent.conversation_config.agent.prompt.tools.find(t => t.name === "run_cli"));
configTool.api_schema.url = endpoint;
configTool.api_schema.request_headers = { Authorization: `Bearer ${token}` };
configTool.api_schema.auth_connection = null;
configTool.api_schema.auth_resolved_params = [];
configTool.description = "Run a command on the test bridge. Only pwd and ls with supported flags need no confirmation. Every other exact command must be confirmed by Andrew first. Never bypass a rejection.";
configTool.api_schema.request_body_schema.properties.confirmed.description = "True only after the exact command is explicitly confirmed.";
const created = await api("/agents/create", "POST", {
  name: `PhoneClaw PR CLI test ${revision.slice(0, 8)}`,
  conversation_config: {
    tts: { voice_id: source.conversation_config.tts.voice_id, model_id: source.conversation_config.tts.model_id },
    agent: {
      first_message: "Ready for the command tool test.", language: "en",
      prompt: {
        prompt: `You are Andrew's command test assistant. Use run_cli when asked; use cwd exactly as supplied. Only pwd and ls with simple flags run without confirmation. All other commands require confirmation of the exact command. Never invent execution results or bypass a rejection. Report the result briefly.`,
        llm: source.conversation_config.agent.prompt.llm, tools: [configTool],
      },
    },
    conversation: { max_duration_seconds: 120, client_events: ["audio", "agent_response", "user_transcript", "agent_tool_response"] },
  },
});
const testAgentId = created.agent_id;
let conversationId;
try {
  const signed = await api(`/conversation/get-signed-url?agent_id=${encodeURIComponent(testAgentId)}`);
  const ws = new WebSocket(signed.signed_url);
  let sent = false;
  let finished;
  let failed;
  const done = new Promise((resolve, reject) => { finished = resolve; failed = reject; });
  const timer = setTimeout(() => failed(new Error("Live test timed out")), 90000);
  let settle;
  let toolSeen = false;
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "conversation_initiation_client_data" })));
  ws.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ping") ws.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
    if (message.type === "conversation_initiation_metadata") {
      conversationId = message.conversation_initiation_metadata_event?.conversation_id;
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "user_message", text: `Please use run_cli with command pwd and cwd ${cwd}. Report the working directory returned by the tool.` }));
      }
    }
    if (message.type === "agent_tool_response") toolSeen = true;
    if (toolSeen && message.type === "agent_response") {
      clearTimeout(settle);
      settle = setTimeout(finished, 2000);
    }
  });
  ws.addEventListener("error", () => failed(new Error("Live test WebSocket failed")));
  ws.addEventListener("close", () => { if (toolSeen) finished(); else failed(new Error("Conversation closed before tool result")); });
  try { await done; } finally { clearTimeout(timer); clearTimeout(settle); ws.close(); }
  assert.ok(conversationId);
  let details;
  let matched;
  for (let attempt = 0; attempt < 30; attempt++) {
    details = await api(`/conversations/${conversationId}`);
    matched = details.transcript?.flatMap(turn => turn.tool_results || []).find(r => r.tool_name === "run_cli");
    if (matched) break;
    await wait(2000);
  }
  const result = typeof matched?.result_value === "string" ? JSON.parse(matched.result_value) : matched?.result_value;
  const call = details.transcript?.flatMap(turn => turn.tool_calls || []).find(c => c.tool_name === "run_cli");
  const args = typeof call?.params_as_json === "string" ? JSON.parse(call.params_as_json) : call?.params_as_json;
  const checks = {
    tool_called: Boolean(call), exact_command: args?.command === "pwd", exact_cwd: args?.cwd === cwd,
    result_ok: matched?.is_error === false && result?.ok === true,
    deployed_revision: result?.revision === revision, policy_version: result?.policy_version === GENERIC_CLI_POLICY_VERSION,
    nested_directory: result?.working_directory === cwd, confirmation_preflight: denied.status === "confirmation_required", environment_preflight: filtered.stdout === "",
    agent_answered: details.transcript?.some(turn => turn.role === "agent" && String(turn.message || "").includes(cwd)),
  };
  console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), transport: "elevenlabs_websocket_text", revision, conversation_id: conversationId, checks }, null, 2));
  assert.ok(Object.values(checks).every(Boolean), "Live CLI test failed");
} finally {
  await api(`/agents/${testAgentId}`, "DELETE");
}
