import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_RAW_BYTES = 120_000;
const MAX_RAW_BYTES = 250_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const CONFIRMATION_TTL_MS = 2 * 60 * 1000; // 2 minutes

// In-memory confirmation store for Slack sends (preview → confirm).
// Keyed by confirmationId; values carry a payload hash, expiry, and a used flag.
const pendingConfirmations = new Map();

export async function slackAuthStatus({ maxRawBytes = DEFAULT_MAX_RAW_BYTES, deps = {} } = {}) {
  const whoami = await runSlack({
    args: ["auth", "whoami"],
    maxRawBytes,
    deps,
  });
  const list = await runSlack({
    args: ["auth", "list", "--check", "--json"],
    maxRawBytes,
    deps,
  });

  const ok = whoami.ok || list.ok;
  const who = sanitizeOneLine(whoami.raw_json || whoami.stdout || "").slice(0, 400);
  const workspaces = Array.isArray(list.parsed_json) ? list.parsed_json : [];
  return {
    ok,
    status: ok ? "ok" : "slack_auth_check_failed",
    action: "slack_auth_status",
    provider: "slackcli",
    whoami: who,
    workspaces,
    stdout: "",
    stderr: "",
    exit_code: whoami.exit_code ?? list.exit_code ?? 0,
    answer_text: ok
      ? (who ? `Slack is signed in as ${who}.` : "Slack authentication looks OK.")
      : "Slack authentication check failed.",
  };
}

export async function slackConversationsList({
  types,
  limit = DEFAULT_LIST_LIMIT,
  excludeArchived = true,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}) {
  const bounded = clampInteger(limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const args = ["conversations", "list", "--limit", String(bounded), "--json"];
  if (excludeArchived) args.push("--exclude-archived");
  if (types) args.push("--types", String(types));
  const result = await runSlack({ args, maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_conversations_list_failed", action: "slack_conversations_list" });
  const conversations = Array.isArray(result.parsed_json) ? result.parsed_json : (result.parsed_json?.conversations || []);
  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: "slack_conversations_list",
    provider: "slackcli",
    returned_count: conversations.length,
    conversations,
    answer_text: conversations.length
      ? `Found ${conversations.length} Slack conversations.`
      : "No Slack conversations matched.",
  };
}

export async function slackRead({
  channel,
  conversation,
  permalink,
  thread_ts,
  limit = DEFAULT_READ_LIMIT,
  exclude_replies,
  exclude_replies_bool,
  exclude_self,
  exclude_self_bool,
  oldest,
  latest,
  fields,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}) {
  const target = normalizeString(channel || conversation || permalink);
  if (!target) return missingField("channel", "A channel id, #name, user id/@handle/email, or permalink is required.");
  const bounded = clampInteger(limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
  const args = ["conversations", "read"];
  if (/^https?:\/\//.test(target)) args.push("--permalink", target);
  else args.push(target);
  if (thread_ts) args.push("--thread-ts", String(thread_ts));
  if (toBoolean(exclude_replies ?? exclude_replies_bool)) args.push("--exclude-replies");
  if (toBoolean(exclude_self ?? exclude_self_bool)) args.push("--exclude-self");
  if (oldest) args.push("--oldest", String(oldest));
  if (latest) args.push("--latest", String(latest));
  args.push("--json");
  if (fields) args.push("--fields", String(fields));

  const result = await runSlack({ args, maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_read_failed", action: "slack_read" });

  const body = result.parsed_json || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const withTimes = messages.map((m) => addNyTime(m));
  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: thread_ts ? "slack_thread_read" : "slack_read",
    provider: "slackcli",
    returned_count: withTimes.length,
    time_zone: "America/New_York",
    messages: withTimes,
    next_oldest: body.next_oldest ?? null,
    has_more: Boolean(body.has_more),
    users: Array.isArray(body.users) ? body.users : undefined,
    answer_text: withTimes.length
      ? `${withTimes.length} Slack message${withTimes.length === 1 ? "" : "s"} returned.`
      : "No Slack messages matched.",
  };
}

export async function slackSearchMessages({
  query,
  in_: inOpt,
  from,
  limit = DEFAULT_SEARCH_LIMIT,
  sort,
  sort_dir,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}) {
  const q = normalizeString(query);
  if (!q) return missingField("query", "A search query is required.");
  const bounded = clampInteger(limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  const args = ["search", "messages", q, "--limit", String(bounded), "--json"];
  if (inOpt) args.push("--in", String(inOpt));
  if (from) args.push("--from", String(from));
  if (sort) args.push("--sort", String(sort));
  if (sort_dir) args.push("--sort-dir", String(sort_dir));
  const result = await runSlack({ args, maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_search_failed", action: "slack_search" });
  const body = result.parsed_json || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const withTimes = messages.map((m) => addNyTime(m));
  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: "slack_search",
    provider: "slackcli",
    query: q,
    returned_count: withTimes.length,
    page: body.page ?? null,
    pages: body.pages ?? null,
    time_zone: "America/New_York",
    messages: withTimes,
    answer_text: withTimes.length
      ? `${withTimes.length} Slack search result${withTimes.length === 1 ? "" : "s"}.`
      : "Slack search returned no results.",
  };
}

export async function slackUnreadSummary({
  types,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}) {
  const args = ["conversations", "unread", "--json"];
  if (types) args.push("--types", String(types));
  const result = await runSlack({ args, maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_unread_failed", action: "slack_unread" });
  const body = result.parsed_json || {};
  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: "slack_unread",
    provider: "slackcli",
    unread_channels: Array.isArray(body.unread_channels) ? body.unread_channels : [],
    threads: body.threads || undefined,
    answer_text: formatUnreadAnswer(body),
  };
}

export async function slackUserInfo({
  user,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}) {
  const target = normalizeString(user);
  if (!target) return missingField("user", "A Slack user id, @handle, or email is required.");
  const result = await runSlack({ args: ["users", "info", target, "--json"], maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_user_info_failed", action: "slack_user_info" });
  const body = result.parsed_json || {};
  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: "slack_user_info",
    provider: "slackcli",
    user: body,
    answer_text: body?.profile?.real_name ? `User: ${body.profile.real_name}.` : "User info returned.",
  };
}

export async function slackMessageSend({
  to,
  text,
  thread_ts,
  permalink,
  emoji, // optional follow-up reaction on success
  previewed,
  confirmation_id,
  confirm_id,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}, context = {}) {
  const recipient = normalizeString(to);
  const body = normalizeString(text);
  const previewedBool = toBoolean(previewed, false);
  const confirmed = context?.confirmed === true || context?.confirmed === "true";
  const providedConfirmationId = normalizeString(confirm_id || confirmation_id);

  if (!recipient) return missingField("to", "A Slack channel id/#name, user id/@handle/email, or Slack URL is required.");
  if (!body) return missingField("text", "A non-empty message text is required.");
  if (body.length > 40_000) {
    return {
      ok: false,
      status: "message_too_long",
      action: "slack_send_message_too_long",
      message: "Slack message text must be 40,000 characters or fewer.",
      answer_text: "The Slack message is too long.",
    };
  }

  const destinationLabel = destinationPreviewLabel(recipient);
  const preview = {
    to: destinationLabel,
    text: body,
    ...(thread_ts ? { thread_ts: String(thread_ts) } : {}),
    ...(permalink ? { permalink: String(permalink) } : {}),
  };

  const normalizedPayload = { to: recipient, text: body, thread_ts: thread_ts || "", permalink: permalink || "" };
  const payloadHash = hashPayload(normalizedPayload);

  // Preview step
  if (!previewedBool || !providedConfirmationId) {
    const id = issueConfirmationId({ payloadHash, deps });
    return {
      ok: false,
      status: "confirmation_required",
      action: "slack_send_preview_required",
      requires_preview: true,
      requires_confirmation: true,
      preview,
      confirmation_id: id,
      message: `Read this aloud exactly: "Slack ${destinationLabel}: ${body}". Ask "Do you want me to send this Slack message now?" Only after Andrew says yes, call again with the same content, previewed=true, confirmed=true, and confirmation_id="${id}".`,
      answer_text: `Preview ready for Slack ${destinationLabel}. Ask if you should send it now.`,
    };
  }

  // Confirmation required on the outer envelope as well.
  if (!confirmed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "slack_send_confirmation_required",
      requires_confirmation: true,
      preview,
      message: `Ask Andrew: "Do you want me to send this Slack message to ${destinationLabel} now?" Then call again with previewed=true, confirmed=true, and the provided confirmation_id.`,
      answer_text: `Ask for confirmation before sending to ${destinationLabel}.`,
    };
  }

  const check = consumeConfirmationId({ id: providedConfirmationId, payloadHash, deps });
  if (!check.ok) {
    return {
      ok: false,
      status: check.status,
      action: "slack_send_invalid_confirmation",
      message: check.message,
      preview,
      answer_text: check.message,
    };
  }

  // Send
  const args = ["messages", "send"];
  if (permalink) args.push("--permalink", String(permalink));
  else args.push("--recipient-id", recipient);
  if (thread_ts) args.push("--thread-ts", String(thread_ts));
  args.push("--message", body, "--json");
  const result = await runSlack({ args, maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_send_failed", action: "slack_send" });

  const bodyJson = result.parsed_json || {};
  const sentChannelId = bodyJson.channel_id || "";
  const sentTs = bodyJson.ts || "";
  const sentPermalink = bodyJson.permalink || "";

  // Optional reaction after a successful send.
  if (emoji) {
    await runSlack({
      args: reactArgs({ emoji, permalink: sentPermalink, channel_id: sentChannelId, ts: sentTs }),
      maxRawBytes,
      deps,
    });
  }

  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: "slack_message_sent",
    provider: "slackcli",
    channel_id: sentChannelId || null,
    ts: sentTs || null,
    permalink: sentPermalink || null,
    preview,
    answer_text: `Sent Slack message to ${destinationLabel}.`,
  };
}

export async function slackReact({
  emoji,
  channel_id,
  timestamp,
  permalink,
  previewed,
  confirmation_id,
  confirm_id,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  deps = {},
} = {}, context = {}) {
  const targetEmoji = normalizeString(emoji);
  const confirmed = context?.confirmed === true || context?.confirmed === "true";
  const providedConfirmationId = normalizeString(confirm_id || confirmation_id);

  if (!targetEmoji) return missingField("emoji", "An emoji name is required for a reaction.");
  const labeledTarget = permalink ? "the linked message" : (channel_id && timestamp ? `${channel_id} at ${timestamp}` : "the message");
  const preview = { emoji: targetEmoji, channel_id: channel_id || "", timestamp: timestamp || "", permalink: permalink || "" };
  const normalizedPayload = { emoji: targetEmoji, channel_id: channel_id || "", timestamp: timestamp || "", permalink: permalink || "" };
  const payloadHash = hashPayload(normalizedPayload);

  if (!toBoolean(previewed, false) || !providedConfirmationId) {
    const id = issueConfirmationId({ payloadHash, deps });
    return {
      ok: false,
      status: "confirmation_required",
      action: "slack_react_preview_required",
      requires_preview: true,
      requires_confirmation: true,
      preview,
      confirmation_id: id,
      message: `Add :${targetEmoji}: to ${labeledTarget}? Ask Andrew to confirm first. Then call again with previewed=true, confirmed=true and confirmation_id="${id}".`,
      answer_text: `Preview ready to react with :${targetEmoji}:.`,
    };
  }
  if (!confirmed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: "slack_react_confirmation_required",
      requires_confirmation: true,
      preview,
      message: `Ask Andrew to confirm adding :${targetEmoji}: to ${labeledTarget} before calling with confirmed=true.`,
      answer_text: "Ask for confirmation first.",
    };
  }
  const check = consumeConfirmationId({ id: providedConfirmationId, payloadHash, deps });
  if (!check.ok) {
    return {
      ok: false,
      status: check.status,
      action: "slack_react_invalid_confirmation",
      message: check.message,
      preview,
      answer_text: check.message,
    };
  }

  const args = reactArgs({ emoji: targetEmoji, permalink, channel_id, ts: timestamp });
  const result = await runSlack({ args, maxRawBytes, deps });
  if (!result.ok) return slackFailure(result, { status: "slack_react_failed", action: "slack_react" });
  return {
    ...compactSlackResult(result),
    ok: true,
    status: "ok",
    action: "slack_reacted",
    provider: "slackcli",
    preview,
    answer_text: `Added :${targetEmoji}: reaction.`,
  };
}

// ---------------------
// Internals
// ---------------------

function reactArgs({ emoji, permalink, channel_id, ts }) {
  const args = ["messages", "react", "--emoji", String(emoji)];
  if (permalink) args.push("--permalink", String(permalink));
  else {
    if (channel_id) args.push("--channel-id", String(channel_id));
    if (ts) args.push("--timestamp", String(ts));
  }
  return args;
}

function issueConfirmationId({ payloadHash, deps }) {
  const id = (deps?.randomId?.() ?? randomBytes(16).toString("hex")).slice(0, 32);
  const now = deps?.nowMs?.() ?? Date.now();
  pendingConfirmations.set(id, { payloadHash, expiresAt: now + CONFIRMATION_TTL_MS, used: false });
  return id;
}

function consumeConfirmationId({ id, payloadHash, deps }) {
  const now = deps?.nowMs?.() ?? Date.now();
  const entry = pendingConfirmations.get(id);
  if (!entry) return { ok: false, status: "invalid_confirmation", message: "This confirmation id is not valid. Preview again first." };
  if (entry.used) return { ok: false, status: "confirmation_already_used", message: "This confirmation id was already used. Preview again first." };
  if (entry.expiresAt < now) {
    pendingConfirmations.delete(id);
    return { ok: false, status: "confirmation_expired", message: "This confirmation id expired. Preview again first." };
  }
  if (entry.payloadHash !== payloadHash) {
    return { ok: false, status: "confirmation_mismatch", message: "Content changed. Preview again first with the exact recipient and message." };
  }
  entry.used = true;
  pendingConfirmations.set(id, entry);
  return { ok: true };
}

function hashPayload(obj) {
  const text = JSON.stringify(obj);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function runSlack({ args, timeoutMs = DEFAULT_TIMEOUT_MS, maxRawBytes = DEFAULT_MAX_RAW_BYTES, deps = {} }) {
  const rawLimit = clampInteger(maxRawBytes, 1_000, MAX_RAW_BYTES, DEFAULT_MAX_RAW_BYTES);
  const executable = deps.slackBin || process.env.SLACKCLI_BIN || "/usr/local/bin/slackcli";
  const homeDir = deps.home || process.env.SLACKCLI_HOME || "/home/phoneclaw";
  const env = {
    ...process.env,
    HOME: homeDir,
    NO_COLOR: "1",
  };
  const execImpl = deps.execFile || execFile;
  return new Promise((resolve) => {
    execImpl(
      executable,
      args,
      {
        env,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const cleanStdout = redact(stdout || "");
        const cleanStderr = redact(stderr || "");
        const truncated = truncateUtf8(cleanStdout, rawLimit);
        const parsed = parseMaybeJson(cleanStdout);

        if (error) {
          resolve({
            ok: false,
            status: error.killed ? "cli_timeout" : "cli_failed",
            timeout_ms: timeoutMs,
            exit_code: typeof error.code === "number" ? error.code : null,
            signal: error.signal || null,
            message: cleanStderr.trim() || error.message || "Slack CLI command failed.",
            raw_json: truncated.value,
            raw_truncated: truncated.truncated,
            stderr: truncateUtf8(cleanStderr, 10_000).value,
            parsed_json: parsed,
            answer_text: cleanStderr.trim() || error.message || "The Slack CLI command failed.",
          });
          return;
        }

        resolve({
          ok: true,
          status: "ok",
          timeout_ms: timeoutMs,
          exit_code: 0,
          raw_json: truncated.value,
          raw_truncated: truncated.truncated,
          stderr: truncateUtf8(cleanStderr, 10_000).value,
          parsed_json: parsed,
          answer_text: "The Slack CLI command completed successfully.",
        });
      }
    );
  });
}

function slackFailure(result, extra = {}) {
  return {
    ...compactSlackResult(result),
    ok: false,
    status: extra.status || result.status || "slack_cli_failed",
    action: extra.action || "slack_failed",
    message: result.message || "Slack CLI request failed.",
    answer_text: result.answer_text || "The Slack CLI request failed.",
  };
}

function compactSlackResult(result) {
  const { raw_json, raw_truncated, parsed_json, stderr, ...compact } = result;
  return {
    ...compact,
    raw_json: "",
    raw_truncated: false,
    stderr: stderr ? truncateUtf8(stderr, 1_000).value : "",
  };
}

function addNyTime(message) {
  const ts = String(message?.ts || "");
  const ny = ts ? formatNyTime(ts) : "";
  return ny ? { ...message, time_ny: ny } : message;
}

function formatNyTime(slackTs) {
  // Slack ts: "1234567890.123456" (seconds.micros) or epoch seconds.
  const seconds = Number.parseFloat(String(slackTs));
  if (!Number.isFinite(seconds)) return "";
  const date = new Date(Math.floor(seconds * 1000));
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(date)
      .replaceAll("\u200E", "");
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16);
  }
}

function destinationPreviewLabel(to) {
  const value = String(to || "");
  if (/^#/.test(value)) return value;
  if (/^C[A-Z0-9]/i.test(value)) return `channel ${value}`;
  if (/^@/.test(value)) return `DM with ${value.slice(1)}`;
  if (/^U[A-Z0-9]/i.test(value)) return `DM with ${value}`;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return `DM with ${value}`;
  if (/^https?:\/\//.test(value)) return "linked conversation";
  return value;
}

function formatUnreadAnswer(body) {
  const channels = Array.isArray(body.unread_channels) ? body.unread_channels : [];
  const threadNote = body.threads?.has_unreads
    ? body.threads?.mention_count
      ? " Threads: unread replies, with mentions."
      : " Threads: unread replies."
    : body.threads?.mention_count
      ? " Threads: no replies, but mentions are unread."
      : "";
  if (!channels.length && !threadNote) return "All caught up.";
  const first = channels[0]?.name || channels[0]?.id || "";
  const more = channels.length > 1 ? ` and ${channels.length - 1} more` : "";
  return channels.length ? `Unread in ${first}${more}.${threadNote}` : `No channels unread.${threadNote}`;
}

function sanitizeOneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function missingField(field, message) {
  return {
    ok: false,
    status: "missing_field",
    action: "slack_missing_field",
    field,
    message,
    answer_text: message,
  };
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

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { value: text, truncated: false };
  }
  return {
    value: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function redact(value) {
  return String(value || "")
    .replace(/xox[bp]-[A-Za-z0-9-]+/g, "xox[bp]-[redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"');
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

