import { executeCli } from "../shared/cli-process.mjs";

// Confirmed iMessage send (#140). Runs `imsg send` on the Mac over the mac-imsg
// SSH wrapper. Raw `imsg send` stays blocked for run_cli; this is the only send
// path, and it needs an exact spoken preview (previewed=true) and Andrew's yes
// (confirmed=true from the outer run_cli flag, never from the JSON payload).
const DEFAULT_WRAPPER = "/home/phoneclaw/bin/mac-imsg";
const MAX_TEXT_CHARS = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICES = new Set(["imessage", "sms", "auto"]);

export function normalizeRecipient(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("@")) return EMAIL.test(raw) ? raw.toLowerCase() : null;
  const digits = raw.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

export async function imessageSend(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.executeCli || executeCli;
  const to = normalizeRecipient(options.to);
  const text = String(options.text ?? "").trim();
  const service = String(options.service || "imessage").toLowerCase();

  if (!to) {
    return fail("invalid_recipient", "Give a phone number (like +15551234567) or an iMessage email address.", "to");
  }
  if (!text) return fail("missing_field", "Say what the message should say.", "text");
  if (text.length > MAX_TEXT_CHARS) {
    return fail("text_too_long", `Keep the message under ${MAX_TEXT_CHARS} characters.`, "text");
  }
  if (!SERVICES.has(service)) return fail("invalid_service", "Service must be imessage, sms, or auto.", "service");
  const allowed = allowedRecipients(env);
  if (allowed && !allowed.has(to)) {
    return fail("recipient_not_allowed", `${to} is not on the iMessage recipient allowlist.`, "to");
  }

  const preview = { to, text, service };
  if (!options.previewed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "imessage_send_preview_required",
      requires_preview: true,
      requires_confirmation: true,
      preview,
      message: `Read this aloud exactly: "Text ${to}: ${text}". Ask "Do you want me to send this message now?" Only after Andrew says yes, call again with previewed=true and confirmed=true.`,
      answer_text: `Read the message to ${to} aloud and confirm with Andrew before sending.`,
    };
  }
  if (!options.confirmed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "imessage_send_confirmation_required",
      requires_confirmation: true,
      preview,
      message: `Ask Andrew: "Do you want me to send this message to ${to} now?" Then call again with previewed=true and confirmed=true.`,
      answer_text: `Confirm with Andrew before texting ${to}.`,
    };
  }

  const args = ["send", "--to", to, "--text", text, "--service", service, "--json"];
  const result = await run(env.MAC_IMSG_BIN || DEFAULT_WRAPPER, args, {
    env: { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || "", MAC_SSH_ALIAS: env.MAC_SSH_ALIAS || "" },
    timeoutMs: Number(options.timeoutMs) || 45_000,
    maxBuffer: 1_000_000,
  });
  if (result.status === "cli_timeout") {
    return {
      ...fail("imessage_send_timeout", `The send to ${to} timed out, so delivery is unconfirmed. Check Messages before retrying.`),
      action: "imessage_send_timeout",
      preview,
    };
  }
  if (!result.ok) {
    const reason = (result.stderr || result.stdout || "").trim().slice(0, 200);
    return {
      ...fail("imessage_send_failed", `The message to ${to} did not send${reason ? `: ${reason}` : "."}`),
      action: "imessage_send_failed",
      preview,
    };
  }
  return {
    ok: true,
    status: "ok",
    action: "imessage_sent",
    to,
    service,
    text,
    output: parseJson(result.stdout),
    answer_text: `Sent your message to ${to}.`,
  };
}

function allowedRecipients(env) {
  const list = String(env.IMESSAGE_ALLOWED_RECIPIENTS || "").split(",").map(normalizeRecipient).filter(Boolean);
  return list.length ? new Set(list) : null;
}

function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text.split("\n").filter(Boolean).at(-1));
  } catch {
    return text.slice(0, 500);
  }
}

function fail(status, message, field) {
  return { ok: false, status, ...(field ? { field } : {}), message, answer_text: message };
}
