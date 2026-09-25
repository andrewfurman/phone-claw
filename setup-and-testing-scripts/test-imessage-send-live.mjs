// Live end-to-end test for confirmed iMessage send (#140) through the deployed
// bridge's /cli/run. Always checks the preview/confirmation gates and that raw
// `imsg send` stays blocked. Sends one real iMessage only when
// IMESSAGE_TEST_SEND=1 and IMESSAGE_TEST_TO is set (use Andrew's own handle),
// then confirms it landed in Messages via the read-only `imsg chats` listing.
//
//   PHONECLAW_RUN_CLI_URL  default https://webhooks.aifurman.com/cli/run
//                          (on EC2: http://127.0.0.1:8000/cli/run)
//   CLI_BRIDGE_TOKEN (bridge), or COMMAND_BRIDGE_TOKEN / WEB_SEARCH_TOKEN (Worker)
const url = process.env.PHONECLAW_RUN_CLI_URL
  || `${process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com"}/cli/run`;
const token = process.env.CLI_BRIDGE_TOKEN || process.env.COMMAND_BRIDGE_TOKEN || process.env.WEB_SEARCH_TOKEN;
const sendTo = process.env.IMESSAGE_TEST_TO || "";
const reallySend = process.env.IMESSAGE_TEST_SEND === "1" && sendTo;
if (!token) {
  console.error("Missing CLI_BRIDGE_TOKEN, COMMAND_BRIDGE_TOKEN or WEB_SEARCH_TOKEN.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const text = `PhoneClaw iMessage test ${stamp} (#140)`;
const payload = JSON.stringify({ to: sendTo || "+15555550123", text, previewed: true });
const checks = {};
const responses = {};

const preview = await runCli({ command: "phoneclaw", args: ["imessage", "send", "--json", JSON.stringify({ to: sendTo || "+15555550123", text })], confirmed: false });
responses.preview = preview;
checks.preview_required = preview.data?.action === "imessage_send_preview_required" && preview.data?.preview?.text === text;

const selfConfirm = await runCli({ command: "phoneclaw", args: ["imessage", "send", "--json", JSON.stringify({ to: sendTo || "+15555550123", text, previewed: true, confirmed: true })], confirmed: false });
checks.payload_cannot_self_confirm = selfConfirm.data?.action === "imessage_send_confirmation_required";

const invalid = await runCli({ command: "phoneclaw", args: ["imessage", "send", "--json", JSON.stringify({ to: "not-a-number", text, previewed: true })], confirmed: true });
checks.invalid_recipient_rejected = invalid.status === "invalid_recipient";

for (const command of ["imsg", "mac-imsg"]) {
  const raw = await runCli({ command, args: ["send", "--to", sendTo || "+15555550123", "--text", text], confirmed: true });
  checks[`raw_${command}_send_blocked`] = raw.status === "command_blocked";
}

if (reallySend) {
  const sent = await runCli({ command: "phoneclaw", args: ["imessage", "send", "--json", payload], confirmed: true, timeout_ms: 60_000 });
  checks.sent = sent.ok === true && sent.data?.action === "imessage_sent";
  if (!checks.sent) console.error(JSON.stringify(sent, null, 2));
  const chats = await runCli({ command: "imsg", args: ["chats", "--limit", "5", "--json"], confirmed: false });
  const recent = String(chats.stdout || "").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const target = sendTo.replace(/[\s().-]/g, "").toLowerCase();
  checks.visible_in_messages = recent.some(chat =>
    JSON.stringify(chat).toLowerCase().includes(target.replace(/^\+?1?(?=\d{10}$)/, ""))
    && Date.now() - Date.parse(chat.last_message_at || chat.lastMessageAt || chat.last || 0) < 5 * 60_000);
}

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, url, really_sent: Boolean(reallySend), to: reallySend ? sendTo : null, checks }, null, 2));
if (!ok) console.error(JSON.stringify(responses, null, 2).slice(0, 2000));
process.exit(ok ? 0 : 1);

async function runCli(body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  try { return JSON.parse(raw); } catch { return { ok: false, status: `http_${response.status}`, raw: raw.slice(0, 300) }; }
}
