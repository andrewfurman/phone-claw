import { execFile } from "node:child_process";
import { analyzeImagesWithGateway } from "./ai-gateway-vision.mjs";

// Work Outlook (CoverNode, AD-GA) runs the outlook-web-cli binary (andrewfurman/outlook-web-cli,
// Rust, v1.0.0+), which signs in with each mailbox's saved Outlook web session
// (~phoneclaw/.config/outlook-web-cli/sessions). Its config.json there names each account's
// Chrome DevTools port and mailbox URL, used only to re-import a session that stopped working.
// Every call is `outlook-web-cli <command> --json '<snake_case body>'` (plus `--yes` for a
// confirmed draft); the binary prints one JSON object and exits 1 when ok is false.

const DEFAULT_TIMEOUT_MS = 55_000;
const SESSION_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 24 * 1024 * 1024; // attachments with include_data can be several MB
const MAX_INSPECT_IMAGE_BYTES = 5_000_000;
const ATTACHMENT_PIECE_BYTES = 1_000_000; // the binary's largest data/range size
const DEFAULT_INLINE_IMAGE_HOSTS = "dmvr3d99h35se.cloudfront.net"; // newspaper/visualizer images on R2's CDN
const DEFAULT_ATTACHMENT_INSPECT_PROMPT =
  "Describe this screenshot or image in detail, then transcribe ALL visible text verbatim in reading order " +
  "(menus, labels, table cells, numbers, dates). Put the full transcription in ocr_text.";

// The two work mailboxes and the names Andrew may say for them. Resolved here, before the
// binary is called, so voice aliases work whatever the bridge's config.json lists.
export const WORK_ACCOUNTS = [
  { name: "covernode", aliases: ["covernode.io", "covernodeoutlook", "covernodework"], email_domain: "covernode.io" },
  { name: "adga", aliases: ["ad-ga.com", "adgaoutlook", "adgawork"], email_domain: "ad-ga.com" },
];

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Maps a typed or spoken name, alias, email address or domain to "covernode" or "adga".
// Returns null for empty input, "all", or anything else (e.g. personal Gmail).
export function resolveWorkAccountAlias(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return null;
  const candidates = [squash(raw), squash(raw.replace(/^.*@/, ""))];
  for (const account of WORK_ACCOUNTS) {
    const keys = [account.name, ...account.aliases, account.email_domain].map(squash).filter(Boolean);
    if (candidates.some((c) => keys.includes(c))) return account.name;
  }
  return null;
}

export function listWorkAccounts() {
  return WORK_ACCOUNTS.map((a) => ({ account: a.name, email_domain: a.email_domain, provider: "outlook", access: "read + drafts" }));
}

// A known alias becomes the account name; anything else ("all", unknown) goes through as typed.
function accountArg(account) {
  if (account === undefined || account === null) return undefined;
  const raw = String(account).trim();
  if (!raw) return undefined;
  return resolveWorkAccountAlias(raw) || raw;
}

// The child sees only what it needs: no bridge API keys or tokens.
const ENV_PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
function childEnv(source = process.env) {
  const env = {};
  for (const key of ENV_PASSTHROUGH) if (source[key] !== undefined) env[key] = source[key];
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("OUTLOOK_") && key !== "OUTLOOK_WEB_CLI_BIN" && value !== undefined) env[key] = value;
  }
  // HOME is where the binary finds ~/.config/outlook-web-cli (config.json + sessions).
  env.HOME = source.OUTLOOK_WEB_CLI_HOME || source.HOME || "/home/phoneclaw";
  if (!source.OUTLOOK_INLINE_IMAGE_HOSTS) env.OUTLOOK_INLINE_IMAGE_HOSTS = DEFAULT_INLINE_IMAGE_HOSTS;
  return env;
}

function compactBody(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function redact(text) {
  return String(text || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]");
}

function parseJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Runs `outlook-web-cli ...args` and returns its JSON. A non-zero exit with JSON on stdout
// (ok=false) is a normal answer; anything else becomes a compact failure. Never logs output.
export function runOutlookCli(args, { timeoutMs = DEFAULT_TIMEOUT_MS, deps = {} } = {}) {
  const executable = deps.bin || process.env.OUTLOOK_WEB_CLI_BIN || "outlook-web-cli";
  const execImpl = deps.execFile || execFile;
  const env = childEnv(deps.env || process.env);
  return new Promise((resolve) => {
    execImpl(executable, args, { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      const parsed = parseJson(stdout);
      if (parsed && !(error && error.killed)) {
        if (typeof parsed.ok !== "boolean") parsed.ok = !error;
        if (!parsed.status) parsed.status = parsed.ok ? "ok" : "error";
        resolve(parsed);
        return;
      }
      const detail = redact(String(stderr || "").trim()).slice(0, 500);
      let status = "cli_failed";
      let answer = "The Outlook command failed.";
      if (error?.code === "ENOENT") {
        status = "cli_not_installed";
        answer = "The outlook-web-cli program isn't installed on the bridge.";
      } else if (error?.killed || error?.signal === "SIGTERM") {
        status = "cli_timeout";
        answer = "Outlook took too long to answer.";
      } else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        status = "output_too_large";
        answer = "Outlook returned more than the bridge can hold; ask for less (for example without include_data).";
      } else if (!error) {
        answer = "The Outlook command returned no JSON.";
      }
      resolve({
        ok: false,
        status,
        exit_code: typeof error?.code === "number" ? error.code : (error ? null : 0),
        timeout_ms: timeoutMs,
        message: detail || answer,
        answer_text: answer,
      });
    });
  });
}

function runCommand(command, body, { confirmed = false, deps, timeoutMs } = {}) {
  const args = [command, "--json", JSON.stringify(compactBody(body))];
  if (truthy(confirmed)) args.push("--yes"); // drafts only; the binary refuses them without it
  return runOutlookCli(args, { deps, timeoutMs });
}

export function outlookStatus({ account, deps } = {}) {
  return runCommand("status", { account: accountArg(account) }, { deps });
}

export function outlookMessages({ account, limit, unread, from, since, search, folder, deps } = {}) {
  return runCommand("messages", { account: accountArg(account), limit, unread, from, since, search, folder }, { deps });
}

export function outlookRead({ account, id, maxBodyChars, deps } = {}) {
  return runCommand("read", { account: accountArg(account), id, max_body_chars: maxBodyChars }, { deps });
}

export function outlookSearch({ account, query, limit, deps } = {}) {
  return runCommand("search", { account: accountArg(account), query, limit }, { deps });
}

export function outlookAgenda({ account, today, tomorrow, start_date, end_date, limit, deps } = {}) {
  return runCommand("agenda", { account: accountArg(account), today, tomorrow, start_date, end_date, limit }, { deps });
}

// When each person is busy and the slots when everyone is free (America/New_York).
export function outlookFreeBusy({ account, emails, today, tomorrow, start_date, end_date, day_start, day_end, min_minutes, weekends, deps } = {}) {
  return runCommand("freebusy", {
    account: accountArg(account), emails, today, tomorrow, start_date, end_date, day_start, day_end, min_minutes, weekends,
  }, { deps });
}

export async function outlookAttachments({ account, id, includeData, maxDataBytes, imagesOnly, index, contentId, attachmentId, offset, length, deps } = {}) {
  if (given(offset) && given(id)) return attachmentRange({ account, id, index, contentId, attachmentId, offset, length, deps });
  return runAttachments({ account, id, includeData, maxDataBytes, imagesOnly, index, contentId, attachmentId, deps });
}

function runAttachments({ account, id, includeData, maxDataBytes, imagesOnly, index, contentId, attachmentId, offset, length, deps } = {}) {
  return runCommand("attachments", {
    account: accountArg(account), id, include_data: includeData, max_data_bytes: maxDataBytes, images_only: imagesOnly,
    index, content_id: contentId, attachment_id: attachmentId, offset, length,
  }, { deps });
}

const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";
// Byte ranges of one attachment (offset/length, for callers with small output limits such as
// SSM) are cut from a copy kept in memory for a few minutes (never on disk), so pulling one
// image in many pieces downloads it from Outlook once, not once per piece.
const ATTACHMENT_CACHE_TTL_MS = 5 * 60_000;
const ATTACHMENT_CACHE_MAX_ENTRIES = 8;
const ATTACHMENT_CACHE_MAX_BYTES = 10_000_000;
const DEFAULT_RANGE_BYTES = 250_000;
const attachmentCache = new Map();

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function rangeCacheKey(account, id, { index, contentId, attachmentId }) {
  return JSON.stringify([String(accountArg(account) || "").toLowerCase(), String(id), String(attachmentId || ""), given(attachmentId) ? "" : String(contentId || "").replace(/^<|>$/g, "").toLowerCase(), given(attachmentId) || given(contentId) ? "" : String(index ?? "")]);
}

async function attachmentRange({ account, id, index, contentId, attachmentId, offset, length, deps }) {
  const pick = { index, contentId, attachmentId };
  const key = rangeCacheKey(account, id, pick);
  const now = Date.now();
  let entry = attachmentCache.get(key);
  if (!entry || now - entry.at > ATTACHMENT_CACHE_TTL_MS) {
    const whole = await runAttachments({ account, id, ...pick, includeData: true, maxDataBytes: ATTACHMENT_PIECE_BYTES, deps });
    if (!whole.ok || !whole.attachment) return whole;
    const total = Number(whole.total_bytes || 0);
    let data = whole.data_base64 ? Buffer.from(whole.data_base64, "base64") : null;
    if (!data) {
      if (total > ATTACHMENT_CACHE_MAX_BYTES) return runAttachments({ account, id, ...pick, offset, length, deps });
      const pieces = [];
      let at = 0;
      while (at !== null && at < total) {
        const piece = await runAttachments({ account, id, ...pick, offset: at, length: ATTACHMENT_PIECE_BYTES, deps });
        if (!piece.ok) return piece;
        const bytes = Buffer.from(String(piece.data_base64 || ""), "base64");
        if (!bytes.length) break;
        pieces.push(bytes);
        at = typeof piece.next_offset === "number" ? piece.next_offset : null;
      }
      data = Buffer.concat(pieces);
    }
    entry = { at: now, account: whole.account, attachment: whole.attachment, bytes: data };
    attachmentCache.delete(key);
    attachmentCache.set(key, entry);
    // Later pieces usually name the attachment_id the first piece returned.
    if (whole.attachment.attachment_id) attachmentCache.set(rangeCacheKey(account, id, { attachmentId: whole.attachment.attachment_id }), entry);
    while (attachmentCache.size > ATTACHMENT_CACHE_MAX_ENTRIES) attachmentCache.delete(attachmentCache.keys().next().value);
  }
  const bytes = entry.bytes;
  const start = clampInt(offset, 0, bytes.length, 0);
  const end = Math.min(bytes.length, start + clampInt(length, 1_000, ATTACHMENT_PIECE_BYTES, DEFAULT_RANGE_BYTES));
  return {
    ok: true,
    status: "ok",
    account: entry.account,
    id,
    attachment: entry.attachment,
    total_bytes: bytes.length,
    offset: start,
    returned_bytes: end - start,
    next_offset: end < bytes.length ? end : null,
    data_base64: bytes.subarray(start, end).toString("base64"),
    answer_text: `Bytes ${start}-${end} of ${bytes.length} of ${entry.attachment.name}.`,
  };
}

const given = (v) => v !== undefined && v !== null && v !== "";

// Describes and transcribes one image attachment (default: the first image) with
// phone-claw's own vision gateway. The binary only fetches the bytes.
export async function outlookAttachmentInspect({ account, id, index, contentId, prompt, visionAnalyze = analyzeImagesWithGateway, deps } = {}) {
  if (!given(id)) return { ok: false, status: "missing_id", field: "id", answer_text: "An Outlook message id is required." };
  const listed = await runAttachments({ account, id, deps });
  if (!listed.ok) return listed;
  const attachments = Array.isArray(listed.attachments) ? listed.attachments : [];
  const images = attachments.filter((x) => x.is_image);
  const cid = String(contentId || "").trim().replace(/^<|>$/g, "").toLowerCase();
  const image = cid
    ? attachments.find((x) => String(x.content_id || "").toLowerCase() === cid)
    : given(index) ? attachments.find((x) => x.index === Number(index)) : images[0];
  if (!image || !image.is_image) {
    return {
      ok: false,
      status: images.length ? "image_not_found" : "no_images",
      account: listed.account,
      id,
      images,
      answer_text: images.length ? "No image matched that index or content id." : "That email has no images.",
    };
  }
  if (Number(image.size) > MAX_INSPECT_IMAGE_BYTES) {
    return { ok: false, status: "image_too_large", account: listed.account, id, answer_text: "That image is too large to inspect." };
  }
  const fetched = await fetchAttachmentBytes({ account, id, image, deps });
  if (!fetched.ok) return { ...fetched, account: fetched.account || listed.account, id };
  if (typeof visionAnalyze !== "function") {
    const message = "No image model is set up.";
    return { ok: false, status: "vision_not_configured", account: listed.account, id, message, answer_text: message };
  }
  const vision = await visionAnalyze({
    provider: "openrouter",
    prompt: String(prompt || "").trim() || DEFAULT_ATTACHMENT_INSPECT_PROMPT,
    images: [{ media_type: image.content_type, data_base64: fetched.data_base64, filename: image.name }],
  });
  if (!vision?.ok) {
    return { ok: false, status: vision?.status || "vision_error", account: listed.account, id, image, message: vision?.message, answer_text: vision?.message || "Vision analysis failed." };
  }
  return {
    ok: true,
    status: "ok",
    account: listed.account,
    id,
    image,
    provider: vision.provider || "",
    upstream_provider: vision.upstream_provider || "",
    model: vision.model || "",
    usage: vision.usage || null,
    description: vision.description || "",
    ocr_text: vision.ocr_text || "",
    answer_text: vision.answer_text || vision.description || "I inspected the image.",
  };
}

// One attachment's bytes as base64, through the in-memory range cache (one Outlook download).
async function fetchAttachmentBytes({ account, id, image, deps }) {
  const pick = image.attachment_id ? { attachmentId: image.attachment_id } : { index: image.index };
  const pieces = [];
  let offset = 0;
  while (offset !== null) {
    const piece = await attachmentRange({ account, id, ...pick, offset, length: ATTACHMENT_PIECE_BYTES, deps });
    if (!piece.ok) return piece;
    if (piece.total_bytes > MAX_INSPECT_IMAGE_BYTES) return { ok: false, status: "image_too_large", answer_text: "That image is too large to inspect." };
    pieces.push(Buffer.from(String(piece.data_base64 || ""), "base64"));
    offset = piece.next_offset;
  }
  return { ok: true, data_base64: Buffer.concat(pieces).toString("base64") };
}

export function outlookDraftReply({ account, id, body, bodyHtml, replyAll, addTo, addCc, inlineImages, confirmed = false, deps } = {}) {
  return runCommand("draft-reply", {
    account: accountArg(account), id, body, body_html: bodyHtml, reply_all: replyAll, add_to: addTo, add_cc: addCc, inline_images: inlineImages,
  }, { confirmed, deps });
}

export function outlookDraftNew({ account, to, cc, subject, body, bodyHtml, inlineImages, confirmed = false, deps } = {}) {
  return runCommand("draft-new", {
    account: accountArg(account), to, cc, subject, body, body_html: bodyHtml, inline_images: inlineImages,
  }, { confirmed, deps });
}

export function outlookDeleteDraft({ account, id, confirmed = false, deps } = {}) {
  return runCommand("draft-delete", { account: accountArg(account), id }, { confirmed, deps });
}

// Session health for `phoneclaw outlook session` (`outlook-web-cli auth status`), or renew
// every account's session now (`auth refresh --all [--rotate]`). No secrets in the output.
export async function outlookSession({ refresh = false, rotate = false, deps } = {}) {
  if (truthy(refresh) || truthy(rotate)) {
    const args = ["auth", "refresh", "--all"];
    if (truthy(rotate)) args.push("--rotate");
    return runOutlookCli(args, { deps, timeoutMs: SESSION_TIMEOUT_MS });
  }
  const result = await runOutlookCli(["auth", "status"], { deps });
  if (!Array.isArray(result.accounts)) return result;
  const { config_dir, ...rest } = result;
  return { ...rest, ok: result.ok !== false && result.accounts.length > 0 && result.accounts.every((a) => a.saved), status: "ok", accounts: result.accounts };
}
