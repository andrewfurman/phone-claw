import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";

const SENDGRID_MAIL_SEND_URL = "https://api.sendgrid.com/v3/mail/send";
const DEFAULT_FROM = "info@aifurman.com";
const DEFAULT_TO = "aifurman@gmail.com";
const DEFAULT_OWNER = "aifurman@gmail.com";
const ALLOWED_FROM_DOMAIN = "aifurman.com";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * First-class SendGrid outbound path for assistant mail from aifurman.com.
 * Keeps sends out of personal Gmail SMTP / Himalaya Sent.
 */
export async function sendgridEmailSend(options = {}, deps = {}) {
  ensureEnvLoaded(deps);
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  const defaults = resolveDefaults(env);
  const fromRaw = normalizeHeaderValue(options.from) || defaults.from;
  const toRaw = normalizeHeaderValue(options.to) || defaults.to;
  const ccRaw = normalizeHeaderValue(options.cc);
  const bccRaw = normalizeHeaderValue(options.bcc);
  const subject = normalizeHeaderValue(options.subject);
  const bodyText = normalizeString(options.body ?? options.text);
  const bodyHtml = normalizeString(options.html);
  const previewed = toBoolean(options.previewed, false);
  const confirmed = toBoolean(options.confirmed, false);

  let toEmails = parseEmailList(toRaw);
  let ccEmails = parseEmailList(ccRaw);
  const bccEmails = parseEmailList(bccRaw);

  const preview = {
    from: fromRaw,
    to: formatEmailList(toEmails),
    cc: formatEmailList(ccEmails),
    bcc: formatEmailList(bccEmails),
    subject,
    body: bodyText,
    html: bodyHtml ? "[html present]" : "",
  };

  if (!defaults.apiKey) {
    return {
      ok: false,
      status: "not_configured",
      action: "sendgrid_email_send_not_configured",
      message: "SENDGRID_API_KEY is not configured on the bridge.",
      preview,
      answer_text:
        "SendGrid is not configured on the bridge yet. Set SENDGRID_API_KEY in bridge.env.",
    };
  }

  if (!fromRaw || !hasEmailAddress(fromRaw)) {
    return missingField("from", "A from address is required before sending via SendGrid.");
  }

  const fromEmail = extractPrimaryEmail(fromRaw);
  if (!isAllowedFromDomain(fromEmail)) {
    return {
      ok: false,
      status: "invalid_from_domain",
      action: "sendgrid_email_send_invalid_from",
      field: "from",
      message: `From address must use @${ALLOWED_FROM_DOMAIN}.`,
      preview: { ...preview, from: fromEmail || fromRaw },
      answer_text: `SendGrid from-addresses must be on ${ALLOWED_FROM_DOMAIN}.`,
    };
  }

  if (!toEmails.length) {
    return missingField("to", "At least one recipient is required before sending email.");
  }

  if (!subject) {
    return missingField("subject", "A subject is required before sending email.");
  }

  if (!bodyText && !bodyHtml) {
    return missingField(
      "body",
      "A non-empty email body (text or html) is required before sending email."
    );
  }

  const ownerEmail = defaults.owner;
  let ownerAddedToCc = false;
  if (!recipientListContains(toEmails, ownerEmail) && !recipientListContains(ccEmails, ownerEmail)) {
    ccEmails = [...ccEmails, ownerEmail];
    ownerAddedToCc = true;
  }

  preview.to = formatEmailList(toEmails);
  preview.cc = formatEmailList(ccEmails);
  preview.from = fromEmail;

  if (!previewed) {
    return {
      ...confirmationRequired(
        `Before sending via SendGrid, read Andrew the exact email preview: From ${fromEmail}; To ${preview.to}; CC ${preview.cc || "(none)"}; Subject "${subject}"; Body "${bodyText || "(html only)"}". Then ask, "Do you want me to send this assistant email now?"`
      ),
      action: "sendgrid_email_send_preview_required",
      requires_preview: true,
      requires_confirmation: true,
      preview,
      owner_added_to_cc: ownerAddedToCc,
    };
  }

  if (!confirmed) {
    return {
      ...confirmationRequired(
        `Confirm one more time that Andrew wants to send this assistant email now from ${fromEmail} to ${preview.to} with subject "${subject}".`
      ),
      action: "sendgrid_email_send_confirmation_required",
      requires_confirmation: true,
      preview,
      owner_added_to_cc: ownerAddedToCc,
    };
  }

  const payload = {
    personalizations: [
      {
        to: toEmails.map((email) => ({ email })),
        ...(ccEmails.length ? { cc: ccEmails.map((email) => ({ email })) } : {}),
        ...(bccEmails.length ? { bcc: bccEmails.map((email) => ({ email })) } : {}),
      },
    ],
    from: { email: fromEmail },
    subject,
    content: buildContent(bodyText, bodyHtml),
  };

  const timeoutMs = clampInteger(
    options.timeoutMs ?? env.SENDGRID_TIMEOUT_MS,
    1_000,
    60_000,
    DEFAULT_TIMEOUT_MS
  );

  let response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      SENDGRID_MAIL_SEND_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${defaults.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
      return {
        ok: false,
        status: "sendgrid_timeout",
        action: "sendgrid_email_send_timeout",
        message: `SendGrid request timed out after ${timeoutMs}ms.`,
        preview,
        owner_added_to_cc: ownerAddedToCc,
        answer_text:
          "The SendGrid send timed out, so delivery is unconfirmed. Check inbox before retrying.",
      };
    }
    return {
      ok: false,
      status: "sendgrid_request_failed",
      action: "sendgrid_email_send_failed",
      message: sanitizeErrorMessage(error),
      preview,
      owner_added_to_cc: ownerAddedToCc,
      answer_text: "The SendGrid send failed before a response came back.",
    };
  }

  const messageId =
    response.headers?.get?.("x-message-id") ||
    response.headers?.get?.("X-Message-Id") ||
    "";

  if (response.status === 202 || (response.ok && response.status >= 200 && response.status < 300)) {
    const ownerNote = ownerAddedToCc
      ? ` Owner ${ownerEmail} was auto-added to CC.`
      : "";
    return {
      ok: true,
      status: "ok",
      action: "sendgrid_email_sent",
      provider: "sendgrid",
      message_id: messageId || null,
      x_message_id: messageId || null,
      http_status: response.status,
      from: fromEmail,
      to: preview.to,
      cc: preview.cc,
      bcc: preview.bcc,
      subject,
      preview,
      owner_added_to_cc: ownerAddedToCc,
      answer_text: `Sent assistant email via SendGrid from ${fromEmail} to ${preview.to} with subject "${subject}".${ownerNote}`,
    };
  }

  const errorBody = await safeReadBody(response);
  return {
    ok: false,
    status: "sendgrid_http_error",
    action: "sendgrid_email_send_failed",
    http_status: response.status,
    message: summarizeSendgridError(errorBody, response.status),
    preview,
    owner_added_to_cc: ownerAddedToCc,
    answer_text: `SendGrid rejected the send with HTTP ${response.status}.`,
  };
}

export function sendgridConfigured(env = process.env) {
  ensureEnvLoaded({ env });
  return Boolean(normalizeString(env.SENDGRID_API_KEY));
}

function ensureEnvLoaded(deps = {}) {
  if (deps.skipEnvLoad) return;
  if (deps.envLoaded) return;
  try {
    loadPhoneclawEnv({ env: deps.env || process.env });
  } catch {
    // Env load is best-effort; missing files are fine.
  }
  deps.envLoaded = true;
}

function resolveDefaults(env) {
  return {
    apiKey: normalizeString(env.SENDGRID_API_KEY),
    from: normalizeString(env.SENDGRID_DEFAULT_FROM, DEFAULT_FROM),
    to: normalizeString(env.SENDGRID_DEFAULT_TO, DEFAULT_TO),
    owner: normalizeString(env.SENDGRID_OWNER_EMAIL, DEFAULT_OWNER).toLowerCase(),
  };
}

function buildContent(bodyText, bodyHtml) {
  const content = [];
  if (bodyText) {
    content.push({ type: "text/plain", value: bodyText });
  }
  if (bodyHtml) {
    content.push({ type: "text/html", value: bodyHtml });
  }
  if (!content.length) {
    content.push({ type: "text/plain", value: " " });
  }
  return content;
}

function parseEmailList(value) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .flatMap((entry) => parseEmailList(entry))
          .map((email) => email.toLowerCase())
          .filter(Boolean)
      )
    );
  }
  const raw = normalizeHeaderValue(value);
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((part) => extractPrimaryEmail(part))
        .filter(Boolean)
        .map((email) => email.toLowerCase())
    )
  );
}

function extractPrimaryEmail(value) {
  const text = normalizeHeaderValue(value);
  if (!text) return "";
  const angle = text.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const emailMatch = text.match(/[^\s@<>,"']+@[^\s@<>,"']+\.[^\s@<>,"']+/);
  if (emailMatch) return emailMatch[0].trim().toLowerCase();
  return "";
}

function formatEmailList(emails) {
  return emails.join(", ");
}

function recipientListContains(emails, ownerEmail) {
  const needle = String(ownerEmail || "").toLowerCase();
  return emails.some((email) => email.toLowerCase() === needle);
}

function isAllowedFromDomain(email) {
  const normalized = String(email || "").toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 0) return false;
  return normalized.slice(at + 1) === ALLOWED_FROM_DOMAIN;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadBody(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 500) };
    }
  } catch {
    return null;
  }
}

function summarizeSendgridError(body, status) {
  if (!body) return `SendGrid HTTP ${status}`;
  if (typeof body === "string") return body.slice(0, 300);
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((entry) => entry.message || entry.field || JSON.stringify(entry))
      .join("; ")
      .slice(0, 300);
  }
  return JSON.stringify(body).slice(0, 300);
}

function sanitizeErrorMessage(error) {
  return String(error?.message || error || "unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/SG\.[A-Za-z0-9._-]+/g, "SG.[redacted]")
    .slice(0, 300);
}

function missingField(field, message) {
  return {
    ok: false,
    status: "missing_field",
    action: "sendgrid_email_send_missing_field",
    field,
    message,
    answer_text: message,
  };
}

function confirmationRequired(message) {
  return {
    ok: false,
    status: "confirmation_required",
    message,
    answer_text: message,
  };
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeHeaderValue(value) {
  return normalizeString(value).replace(/[\r\n]+/g, " ").trim();
}

function hasEmailAddress(value) {
  return /[^\s@<>,"']+@[^\s@<>,"']+\.[^\s@<>,"']+/.test(String(value || ""));
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
