import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUniversalCli } from "../fastify-app/universal-cli.mjs";
import { whatsappChats, whatsappMessages, whatsappSearch, whatsappSend } from "../fastify-app/whatsapp-tools.mjs";

// Offline tests for WhatsApp via wacli (#142). A stub stands in for wacli, so
// nothing is ever read from or sent to WhatsApp.
const CHATS = [
  { jid: "15551230001@s.whatsapp.net", kind: "dm", name: "Joe Burgess", last_message_ts: "2026-09-25T14:00:00Z", unread_count: 2 },
  { jid: "15551230002@s.whatsapp.net", kind: "dm", name: "Joe Smith", last_message_ts: "2026-09-24T14:00:00Z", unread_count: 0 },
  { jid: "120363000000000000@g.us", kind: "group", name: "Family", last_message_ts: "2026-09-23T14:00:00Z", unread_count: 0 },
  { jid: "120363227381635534@newsletter", kind: "newsletter", name: "F1", last_message_ts: "2026-09-25T14:33:46Z", unread_count: 0 },
];
const MESSAGES = [{ ChatJID: CHATS[0].jid, ChatName: "Joe Burgess", SenderJID: CHATS[0].jid, SenderName: "Joe Burgess", Timestamp: "2026-09-25T14:00:00Z", FromMe: false, Text: "See you at 6", DisplayText: "See you at 6" }];

function fakeWacli() {
  const calls = [];
  const run = async (executable, args) => {
    calls.push(args);
    const ok = data => ({ ok: true, status: "ok", stdout: JSON.stringify({ success: true, data, error: null }), stderr: "" });
    if (args[0] === "chats") {
      const q = args.includes("--query") ? args[args.indexOf("--query") + 1].toLowerCase() : "";
      return ok(CHATS.filter(c => !q || c.name.toLowerCase().includes(q)));
    }
    if (args[0] === "messages") return ok({ fts: true, messages: MESSAGES });
    if (args[0] === "send") return ok({ id: "3AFAKE" });
    return { ok: false, status: "cli_failed", stdout: "", stderr: "unexpected" };
  };
  return { calls, deps: { env: { WACLI_BIN: "/fake/wacli" }, executeCli: run } };
}

test("reads always pass --read-only and --json, cap limits, and summarize", async () => {
  const { calls, deps } = fakeWacli();
  const chats = await whatsappChats({ limit: 500, unread: true }, deps);
  assert.equal(chats.ok, true);
  assert.equal(chats.chats.length, 4);
  assert.match(chats.answer_text, /Joe Burgess \(2 unread\)/);
  assert.deepEqual(calls[0], ["chats", "list", "--limit", "25", "--unread", "--json", "--read-only"]);

  const msgs = await whatsappMessages({ chat: CHATS[0].jid, after: "2026-09-01" }, deps);
  assert.equal(msgs.messages[0].text, "See you at 6");
  assert.deepEqual(calls[1], ["messages", "list", "--limit", "10", "--chat", CHATS[0].jid, "--after", "2026-09-01", "--json", "--read-only"]);

  const found = await whatsappSearch({ query: "dinner", limit: 3 }, deps);
  assert.equal(found.action, "whatsapp_search");
  assert.deepEqual(calls[2], ["messages", "search", "dinner", "--limit", "3", "--json", "--read-only"]);
});

test("read validation", async () => {
  const { calls, deps } = fakeWacli();
  assert.equal((await whatsappSearch({ query: " " }, deps)).status, "missing_field");
  assert.equal((await whatsappMessages({ chat: "Joe" }, deps)).status, "invalid_chat");
  assert.equal((await whatsappMessages({ after: "yesterday" }, deps)).status, "invalid_date");
  assert.equal(calls.length, 0);
});

test("send: preview, then confirmation, then a delegated send", async () => {
  const { calls, deps } = fakeWacli();
  const msg = { to: "Joe Burgess", text: "Running late" };
  const preview = await whatsappSend(msg, deps);
  assert.equal(preview.action, "whatsapp_send_preview_required");
  assert.deepEqual(preview.preview, { to: CHATS[0].jid, name: "Joe Burgess", text: "Running late" });
  assert.equal((await whatsappSend({ ...msg, previewed: true }, deps)).action, "whatsapp_send_confirmation_required");
  assert.ok(!calls.some(args => args[0] === "send"), "must not send before confirmation");

  const sent = await whatsappSend({ ...msg, previewed: true, confirmed: true }, deps);
  assert.equal(sent.action, "whatsapp_sent");
  const send = calls.find(args => args[0] === "send");
  assert.deepEqual(send, ["send", "text", "--to", CHATS[0].jid, "--message", "Running late", "--lock-wait", "20s", "--json"]);
});

test("send: recipients must be unambiguous", async () => {
  const { calls, deps } = fakeWacli();
  const ambiguous = await whatsappSend({ to: "Joe", text: "hi", previewed: true, confirmed: true }, deps);
  assert.equal(ambiguous.status, "recipient_ambiguous");
  assert.deepEqual(ambiguous.matches.map(m => m.name), ["Joe Burgess", "Joe Smith"]);
  assert.equal((await whatsappSend({ to: "Nobody", text: "hi", previewed: true, confirmed: true }, deps)).status, "recipient_not_found");
  assert.equal((await whatsappSend({ to: "F1", text: "hi", previewed: true, confirmed: true }, deps)).status, "recipient_not_found", "newsletters are not recipients");
  const phone = await whatsappSend({ to: "(555) 123-0009", text: "hi" }, deps);
  assert.equal(phone.preview.to, "15551230009");
  assert.ok(!calls.some(args => args[0] === "send"));
});

test("send timeouts and failures are unconfirmed, never sent", async () => {
  const timeout = await whatsappSend({ to: "15551230009", text: "hi", previewed: true, confirmed: true },
    { env: {}, executeCli: async () => ({ ok: false, status: "cli_timeout", stdout: "", stderr: "" }) });
  assert.equal(timeout.action, "whatsapp_send_timeout");
  assert.match(timeout.message, /unconfirmed/);
  const failed = await whatsappSend({ to: "15551230009", text: "hi", previewed: true, confirmed: true },
    { env: {}, executeCli: async () => ({ ok: false, status: "cli_failed", stdout: JSON.stringify({ success: false, error: "not paired" }), stderr: "" }) });
  assert.equal(failed.action, "whatsapp_send_failed");
  assert.match(failed.message, /not paired/);
});

test("run_cli: payload cannot self-confirm; raw wacli writes and reads stay blocked", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-wacli-")));
  const fixture = join(root, "wacli");
  const configPath = join(root, "programs.json");
  const previous = { ...process.env };
  try {
    process.env.GENERIC_CLI_ALLOWED_DIRS = root;
    process.env.GENERIC_CLI_PROGRAMS_PATH = configPath;
    process.env.WACLI_BIN = fixture;
    const example = JSON.parse(readFileSync(new URL("../config/cli-programs.example.json", import.meta.url), "utf8"));
    writeFileSync(configPath, JSON.stringify({ wacli: { ...example.wacli, executable: fixture, env: [] } }));
    writeFileSync(fixture, `#!${process.execPath}\nconst a = process.argv.slice(2);\nconst data = a[0] === "send" ? { id: "3AFAKE" } : a[0] === "chats" ? ${JSON.stringify(CHATS)} : { messages: [] };\nconsole.log(JSON.stringify({ success: true, data, error: null }));\n`, { mode: 0o700 });

    const chats = await runUniversalCli({ command: "phoneclaw", args: ["whatsapp", "chats", "--json", '{"limit":3}'], cwd: root, confirmed: false });
    assert.equal(chats.ok, true, JSON.stringify(chats));
    assert.equal(chats.data.action, "whatsapp_chats");

    const body = JSON.stringify({ to: "15551230009", text: "hi", previewed: true, confirmed: true });
    const selfConfirmed = await runUniversalCli({ command: "phoneclaw", args: ["whatsapp", "send", "--json", body], cwd: root, confirmed: false });
    assert.equal(selfConfirmed.status, "confirmation_required", "payload confirmed=true must not count");
    const sent = await runUniversalCli({ command: "phoneclaw", args: ["whatsapp", "send", "--json", body], cwd: root, confirmed: true });
    assert.equal(sent.data.action, "whatsapp_sent", JSON.stringify(sent));

    for (const args of [["send", "text", "--to", "15551230009", "--message", "x"], ["auth"], ["messages", "list"], ["chats", "list"], ["groups", "leave", "x"], ["profile", "set-name", "x"]]) {
      const raw = await runUniversalCli({ command: "wacli", args, cwd: root, confirmed: true });
      assert.equal(raw.status, "command_blocked", JSON.stringify({ args, raw }));
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});
