import { executeCli } from "../shared/cli-process.mjs";
import { normalizeRecipient } from "./imessage-tools.mjs";

// WhatsApp over wacli (#142). wacli runs on the bridge as the phoneclaw user;
// phoneclaw-wacli-sync.service keeps its local store current. Reads query that
// local store with --read-only. The only send path is `whatsapp send`, which
// needs an exact spoken preview (previewed=true) and the outer confirmed=true.
const DEFAULT_BIN = "/usr/local/bin/wacli";
const MAX_LIMIT = 25;
const MAX_TEXT_CHARS = 1000;
const JID = /^[0-9A-Za-z.-]+@(s\.whatsapp\.net|g\.us|newsletter|lid)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function whatsappChats(options = {}, deps = {}) {
  const args = ["chats", "list", "--limit", String(limitOf(options.limit, 10))];
  const query = clean(options.query);
  if (query) args.push("--query", query);
  if (options.unread === true || options.unread === "true") args.push("--unread");
  const result = await wacli(args, deps);
  if (!result.ok) return result;
  const chats = (result.data || []).map(chat => ({
    name: chat.name || chat.jid,
    kind: chat.kind,
    jid: chat.jid,
    last_message: chat.last_message_ts || null,
    unread_count: chat.unread_count || 0,
  }));
  return {
    ok: true,
    status: "ok",
    action: "whatsapp_chats",
    chats,
    answer_text: chats.length
      ? chats.map(c => `${c.name}${c.unread_count ? ` (${c.unread_count} unread)` : ""}`).join("; ")
      : "No matching WhatsApp chats.",
  };
}

export async function whatsappMessages(options = {}, deps = {}) {
  const args = ["messages", "list", "--limit", String(limitOf(options.limit, 10))];
  const chat = clean(options.chat);
  if (chat) {
    if (!JID.test(chat)) return fail("invalid_chat", "Use the chat's jid from a WhatsApp chats listing.", "chat");
    args.push("--chat", chat);
  }
  const range = dateArgs(options);
  if (range.error) return range.error;
  args.push(...range.args);
  return messageResult(await wacli(args, deps), "whatsapp_messages");
}

export async function whatsappSearch(options = {}, deps = {}) {
  const query = clean(options.query);
  if (!query) return fail("missing_field", "Say what to search WhatsApp messages for.", "query");
  const args = ["messages", "search", query, "--limit", String(limitOf(options.limit, 10))];
  const chat = clean(options.chat);
  if (chat) {
    if (!JID.test(chat)) return fail("invalid_chat", "Use the chat's jid from a WhatsApp chats listing.", "chat");
    args.push("--chat", chat);
  }
  const range = dateArgs(options);
  if (range.error) return range.error;
  args.push(...range.args);
  return messageResult(await wacli(args, deps), "whatsapp_search");
}

export async function whatsappSend(options = {}, deps = {}) {
  const text = String(options.text ?? "").trim();
  const target = await resolveRecipient(clean(options.to), deps);
  if (!target.ok) return target;
  if (!text) return fail("missing_field", "Say what the WhatsApp message should say.", "text");
  if (text.length > MAX_TEXT_CHARS) return fail("text_too_long", `Keep the message under ${MAX_TEXT_CHARS} characters.`, "text");

  const preview = { to: target.to, name: target.name, text };
  const who = target.name ? `${target.name} (${target.to})` : target.to;
  if (!options.previewed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "whatsapp_send_preview_required",
      requires_preview: true,
      requires_confirmation: true,
      preview,
      message: `Read this aloud exactly: "WhatsApp ${who}: ${text}". Ask "Do you want me to send this WhatsApp message now?" Only after Andrew says yes, call again with previewed=true and confirmed=true.`,
      answer_text: `Read the WhatsApp message to ${who} aloud and confirm with Andrew before sending.`,
    };
  }
  if (!options.confirmed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "whatsapp_send_confirmation_required",
      requires_confirmation: true,
      preview,
      message: `Ask Andrew: "Do you want me to send this WhatsApp message to ${who} now?" Then call again with previewed=true and confirmed=true.`,
      answer_text: `Confirm with Andrew before messaging ${who} on WhatsApp.`,
    };
  }

  const args = ["send", "text", "--to", target.to, "--message", text, "--lock-wait", "20s"];
  if (options.allowSelf) args.push("--allow-self");
  const result = await wacli(args, deps, { timeoutMs: Number(options.timeoutMs) || 45_000, readOnly: false });
  if (result.status === "whatsapp_timeout") {
    return { ...fail("whatsapp_send_timeout", `The WhatsApp send to ${who} timed out, so delivery is unconfirmed. Check WhatsApp before retrying.`), action: "whatsapp_send_timeout", preview };
  }
  if (!result.ok) {
    return { ...fail("whatsapp_send_failed", `The WhatsApp message to ${who} did not send: ${result.message}`), action: "whatsapp_send_failed", preview };
  }
  return {
    ok: true,
    status: "ok",
    action: "whatsapp_sent",
    to: target.to,
    name: target.name,
    text,
    message_id: result.data?.id || result.data?.message_id || null,
    answer_text: `Sent your WhatsApp message to ${target.name || target.to}.`,
  };
}

// A phone number or JID is used as given. A name must match exactly one chat,
// so a voice request can never go to a guessed recipient.
async function resolveRecipient(to, deps) {
  if (!to) return fail("missing_field", "Say who the WhatsApp message is for.", "to");
  if (JID.test(to)) return { ok: true, to, name: null };
  if (/^[+(\d][\d\s().-]{6,}$/.test(to)) {
    const phone = normalizeRecipient(to);
    return phone ? { ok: true, to: phone.replace(/^\+/, ""), name: null } : fail("invalid_recipient", "That phone number doesn't look right.", "to");
  }
  const found = await whatsappChats({ query: to, limit: 5 }, deps);
  if (!found.ok) return found;
  const direct = found.chats.filter(c => c.kind === "dm" || c.kind === "group");
  const exact = direct.filter(c => c.name.toLowerCase() === to.toLowerCase());
  const matches = exact.length ? exact : direct;
  if (matches.length === 1) return { ok: true, to: matches[0].jid, name: matches[0].name };
  if (!matches.length) return fail("recipient_not_found", `No WhatsApp chat matches "${to}". Give a phone number instead.`, "to");
  return { ...fail("recipient_ambiguous", `"${to}" matches ${matches.map(c => c.name).join(", ")}. Say which one.`, "to"), matches: matches.map(({ name, jid }) => ({ name, jid })) };
}

async function wacli(args, deps, { timeoutMs = 25_000, readOnly = true } = {}) {
  const env = deps.env || process.env;
  const run = deps.executeCli || executeCli;
  const full = [...args, "--json", ...(readOnly ? ["--read-only"] : [])];
  const result = await run(env.WACLI_BIN || DEFAULT_BIN, full, {
    env: {
      PATH: env.PATH || "/usr/bin:/bin",
      HOME: env.HOME || "/home/phoneclaw",
      ...(env.WACLI_STORE_DIR ? { WACLI_STORE_DIR: env.WACLI_STORE_DIR } : {}),
    },
    timeoutMs,
    maxBuffer: 2_000_000,
  });
  if (result.status === "cli_timeout") return fail("whatsapp_timeout", "WhatsApp did not answer in time.");
  if (result.status === "cli_not_installed") return fail("whatsapp_not_installed", "wacli is not installed on the bridge.");
  let parsed;
  try { parsed = JSON.parse(String(result.stdout || "").trim()); } catch { parsed = null; }
  if (!parsed?.success) {
    const reason = parsed?.error?.message || parsed?.error || (result.stderr || "").trim().split("\n").at(-1) || "unknown error";
    return fail("whatsapp_failed", String(reason).slice(0, 200));
  }
  return { ok: true, data: parsed.data };
}

function messageResult(result, action) {
  if (!result.ok) return result;
  const messages = (result.data?.messages || []).map(m => ({
    time: m.Timestamp,
    chat: m.ChatName || m.ChatJID,
    chat_jid: m.ChatJID,
    from: m.FromMe ? "me" : (m.SenderName || m.SenderJID),
    text: String(m.Text || m.MediaCaption || m.DisplayText || m.Snippet || "").slice(0, 300),
  }));
  return {
    ok: true,
    status: "ok",
    action,
    messages,
    answer_text: messages.length
      ? messages.map(m => `${m.from} in ${m.chat}: ${m.text}`).join(" | ")
      : "No matching WhatsApp messages.",
  };
}

function dateArgs(options) {
  const args = [];
  for (const key of ["after", "before"]) {
    const value = clean(options[key]);
    if (!value) continue;
    if (!DAY.test(value)) return { error: fail("invalid_date", `${key} must be YYYY-MM-DD.`, key) };
    args.push(`--${key}`, value);
  }
  return { args };
}

function limitOf(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : fallback;
}

function clean(value) {
  return String(value ?? "").trim();
}

function fail(status, message, field) {
  return { ok: false, status, ...(field ? { field } : {}), message, answer_text: message };
}
