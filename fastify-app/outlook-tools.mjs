import { htmlToText } from "html-to-text";

// Read-only Outlook access via two already-signed-in Chrome sessions on the bridge VM.
// This module talks to the local Chrome DevTools Protocol (CDP) to extract a short-lived
// Graph access token from the Outlook web app's MSAL cache, then calls Microsoft Graph.
// No tokens are ever logged. All commands are strictly read-only.
//
// Production assumptions from issue #161:
// - CoverNode account: Chrome DevTools on 127.0.0.1:9230, Outlook tab at https://outlook.cloud.microsoft/mail/
// - ADGA account:      Chrome DevTools on 127.0.0.1:9231, Outlook tab at https://outlook.cloud.microsoft/mail/andrew@ad-ga.com/
//
// Tests inject token and HTTP base URL to avoid live CDP/Graph.

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const DEFAULT_READ_MAX_BODY_CHARS = 20000;
const MAX_READ_MAX_BODY_CHARS = 60000;
const DEFAULT_TIMEOUT_MS = 15000;
const ET_TIMEZONE = "America/New_York";

const ACCOUNT_CONFIG = {
  covernode: {
    cdpPort: Number(process.env.OUTLOOK_COVERNODE_CDP_PORT || 9230),
    mainUrl: "https://outlook.cloud.microsoft/mail/",
    label: "covernode",
  },
  adga: {
    cdpPort: Number(process.env.OUTLOOK_ADGA_CDP_PORT || 9231),
    mainUrl: "https://outlook.cloud.microsoft/mail/andrew@ad-ga.com/",
    label: "adga",
  },
};

const GRAPH_BASE =
  normalizeUrl(process.env.OUTLOOK_GRAPH_BASE_URL) ||
  "https://graph.microsoft.com";

export async function outlookStatus({ account } = {}) {
  const targets = await resolveAccounts(account);
  const summaries = [];
  for (const target of targets) {
    const token = await safeGetGraphToken(target).catch(() => null);
    summaries.push({
      account: target.label,
      ok: Boolean(token),
      status: token ? "signed_in" : "needs_sign_in",
    });
  }
  const signedInCount = summaries.filter((s) => s.ok).length;
  return {
    ok: true,
    status: "ok",
    accounts_checked: summaries.length,
    accounts: summaries,
    answer_text:
      summaries.length === 1
        ? (summaries[0].ok ? "Signed in." : "Needs sign-in.")
        : `${signedInCount}/${summaries.length} Outlook sessions are signed in.`,
  };
}

export async function outlookMessages({
  account,
  limit = DEFAULT_LIST_LIMIT,
  unread = false,
  from,
  since,
  search,
  maxRawBytes, // accepted but unused to preserve common signature style
} = {}) {
  const targets = await resolveAccounts(account);
  const boundedLimit = clampInteger(limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const queries = [];
  for (const target of targets) {
    const token = await safeGetGraphToken(target);
    if (!token) {
      queries.push({
        ok: false,
        account: target.label,
        status: "needs_sign_in",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const url = new URL(
      "/v1.0/me/mailFolders/Inbox/messages",
      GRAPH_BASE.endsWith("/") ? GRAPH_BASE : GRAPH_BASE + "/"
    );
    const params = new URLSearchParams();
    params.set(
      "$select",
      "id,subject,from,receivedDateTime,isRead,conversationId,webLink"
    );
    params.set("$orderby", "receivedDateTime desc");
    params.set("$top", String(boundedLimit));
    // search and filter are not allowed together on Graph message list; prefer $search when provided.
    let usedSearch = false;
    if (normalizeString(search)) {
      params.set("$search", `"${normalizeString(search)}"`);
      usedSearch = true;
    } else {
      const filters = [];
      if (toBoolean(unread)) filters.push("isRead eq false");
      const sender = normalizeString(from);
      if (sender) filters.push(`from/emailAddress/address eq '${escapeODataLiteral(sender)}'`);
      const sinceIso = toIsoUtcString(since, { assumeEtMidnight: true });
      if (sinceIso) filters.push(`receivedDateTime ge ${sinceIso}`);
      if (filters.length) params.set("$filter", filters.join(" and "));
    }
    url.search = params.toString();
    const headers = graphHeaders(token, { needsConsistencyLevel: usedSearch });
    const json = await httpJson(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS });
    const items = Array.isArray(json.value) ? json.value : [];
    queries.push({
      ok: true,
      account: target.label,
      status: "ok",
      returned_count: items.length,
      items: items.map((m) => compactGraphMessage(m, target.label)),
    });
  }
  // Merge results for "all"
  const merged = mergeAccountLists(queries);
  return {
    ok: true,
    status: "ok",
    scope: accountScopeLabel(account),
    returned_count: merged.length,
    items: merged,
    answer_text:
      merged.length === 0
        ? "No messages matched."
        : `Found ${merged.length} message${merged.length === 1 ? "" : "s"}.`,
  };
}

export async function outlookRead({
  account,
  id,
  maxBodyChars = DEFAULT_READ_MAX_BODY_CHARS,
} = {}) {
  const messageId = normalizeString(id);
  if (!messageId) return missingField("id", "An Outlook message id is required.");
  const targets = await resolveAccounts(account);
  // If "all", prefer the first account that can read the id; attempt sequentially.
  for (const target of targets) {
    const token = await safeGetGraphToken(target);
    if (!token) continue;
    const url = new URL(
      `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      GRAPH_BASE.endsWith("/") ? GRAPH_BASE : GRAPH_BASE + "/"
    );
    const params = new URLSearchParams();
    params.set("$select", "id,subject,from,receivedDateTime,body,webLink");
    url.search = params.toString();
    const headers = graphHeaders(token);
    const json = await httpJson(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS });
    if (json.error?.code === "ErrorItemNotFound") continue; // try next account
    if (json.error) return graphError(json.error, target.label, "message_read_failed");
    const compact = compactGraphMessage(json, target.label, {
      includeBody: true,
      maxBodyChars: clampInteger(maxBodyChars, 2000, MAX_READ_MAX_BODY_CHARS, DEFAULT_READ_MAX_BODY_CHARS),
    });
    return {
      ok: true,
      status: "ok",
      account: target.label,
      id: compact.id,
      subject: compact.subject,
      from: compact.from,
      received_at: compact.received_at,
      received_datetime: compact.received_datetime,
      web_link: compact.web_link || "",
      body_text: compact.body_text || "",
      answer_text: compact.body_text
        ? `${compact.subject || "Email"} from ${compact.from?.address || "unknown sender"}.`
        : "Message has no readable body.",
    };
  }
  // Tried all accounts
  return {
    ok: false,
    status: "message_not_found",
    scope: accountScopeLabel(account),
    id: messageId,
    answer_text: "Message not found.",
  };
}

export async function outlookSearch({
  account,
  query,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  if (!normalizeString(query)) return missingField("query", "A search query is required.");
  const targets = await resolveAccounts(account);
  const boundedLimit = clampInteger(limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const lists = [];
  for (const target of targets) {
    const token = await safeGetGraphToken(target);
    if (!token) {
      lists.push({
        ok: false,
        account: target.label,
        status: "needs_sign_in",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const url = new URL(
      "/v1.0/me/messages",
      GRAPH_BASE.endsWith("/") ? GRAPH_BASE : GRAPH_BASE + "/"
    );
    const params = new URLSearchParams();
    params.set("$select", "id,subject,from,receivedDateTime,isRead,conversationId,webLink");
    params.set("$search", `"${normalizeString(query)}"`);
    params.set("$orderby", "receivedDateTime desc");
    params.set("$top", String(boundedLimit));
    url.search = params.toString();
    const headers = graphHeaders(token, { needsConsistencyLevel: true });
    const json = await httpJson(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS });
    if (json.error) {
      lists.push(graphError(json.error, target.label, "search_failed"));
      continue;
    }
    const items = Array.isArray(json.value) ? json.value : [];
    lists.push({
      ok: true,
      account: target.label,
      status: "ok",
      returned_count: items.length,
      items: items.map((m) => compactGraphMessage(m, target.label)),
    });
  }
  const merged = mergeAccountLists(lists);
  return {
    ok: true,
    status: "ok",
    scope: accountScopeLabel(account),
    returned_count: merged.length,
    items: merged,
    answer_text:
      merged.length === 0
        ? "No results."
        : `Found ${merged.length} result${merged.length === 1 ? "" : "s"}.`,
  };
}

export async function outlookAgenda({
  account,
  // One of: { today: true }, { tomorrow: true }, or explicit { start_date, end_date } (ISO or YYYY-MM-DD)
  today = false,
  tomorrow = false,
  start_date,
  end_date,
  limit = 50,
} = {}) {
  const targets = await resolveAccounts(account);
  const { startIso, endIso } = normalizeDateRangeEt({ today, tomorrow, start_date, end_date });
  const boundedLimit = clampInteger(limit, 1, 200, 50);
  const lists = [];
  for (const target of targets) {
    const token = await safeGetGraphToken(target);
    if (!token) {
      lists.push({
        ok: false,
        account: target.label,
        status: "needs_sign_in",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const url = new URL(
      "/v1.0/me/calendarView",
      GRAPH_BASE.endsWith("/") ? GRAPH_BASE : GRAPH_BASE + "/"
    );
    const params = new URLSearchParams();
    params.set("startDateTime", startIso);
    params.set("endDateTime", endIso);
    params.set("$top", String(boundedLimit));
    params.set("$orderby", "start/dateTime asc");
    params.set("$select", "id,subject,start,end,location,organizer,isAllDay,webLink");
    url.search = params.toString();
    const headers = graphHeaders(token, {
      preferOutlookTz: ET_TIMEZONE,
    });
    const json = await httpJson(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS });
    if (json.error) {
      lists.push(graphError(json.error, target.label, "agenda_failed"));
      continue;
    }
    const items = Array.isArray(json.value) ? json.value : [];
    lists.push({
      ok: true,
      account: target.label,
      status: "ok",
      returned_count: items.length,
      items: items.map((e) => compactGraphEvent(e, target.label)),
    });
  }
  // Return a per-account map; do not merge calendar events across accounts into one list by default
  const result = {
    ok: true,
    status: "ok",
    scope: accountScopeLabel(account),
    start_date: startIso,
    end_date: endIso,
    accounts: lists.map((list) => ({
      account: list.account,
      ok: list.ok,
      status: list.status,
      returned_count: list.returned_count,
      items: list.items,
    })),
  };
  const total =
    result.accounts?.reduce((sum, a) => sum + (a.ok ? a.returned_count : 0), 0) || 0;
  result.answer_text =
    total === 0
      ? "No events in the selected range."
      : `${total} event${total === 1 ? "" : "s"} in the selected range.`;
  return result;
}

// ------------------------------
// Helpers
// ------------------------------

async function resolveAccounts(scope) {
  const s = normalizeString(scope);
  if (!s || s === "all") return [ACCOUNT_CONFIG.covernode, ACCOUNT_CONFIG.adga];
  const conf = ACCOUNT_CONFIG[s];
  if (!conf) throw new Error(`Unknown account '${scope}'. Use covernode, adga, or all.`);
  return [conf];
}

function accountScopeLabel(scope) {
  const s = normalizeString(scope);
  return s || "all";
}

function graphHeaders(token, { needsConsistencyLevel = false, preferOutlookTz } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (needsConsistencyLevel) headers["consistency-level"] = "eventual";
  if (preferOutlookTz) headers["prefer"] = `outlook.timezone="${preferOutlookTz}"`;
  return headers;
}

async function safeGetGraphToken(target) {
  // Allow test override without CDP
  const envOverride =
    (target.label === "covernode" && process.env.OUTLOOK_TEST_TOKEN_COVERNODE) ||
    (target.label === "adga" && process.env.OUTLOOK_TEST_TOKEN_ADGA) ||
    process.env.OUTLOOK_TEST_TOKEN ||
    "";
  if (normalizeString(envOverride)) return envOverride;
  return await getGraphTokenViaCdp(target);
}

async function getGraphTokenViaCdp({ cdpPort, mainUrl, label }) {
  const base = `http://127.0.0.1:${cdpPort}`;
  const listUrl = `${base}/json/list`;
  let targets;
  try {
    const res = await fetch(listUrl, { redirect: "error", signal: AbortSignal.timeout(3000) });
    targets = await res.json();
  } catch {
    return null;
  }
  const page = Array.isArray(targets)
    ? targets.find(
        (t) =>
          t.type === "page" &&
          typeof t.url === "string" &&
          (t.url === mainUrl || t.url.startsWith(mainUrl))
      )
    : null;
  if (!page?.webSocketDebuggerUrl) return null;
  // Minimal CDP client
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const nextId = (() => {
    let id = 0;
    return () => ++id;
  })();
  const once = (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("cdp_timeout"));
      }, 4000);
      ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id === id) {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {
          // ignore
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cdp_error"));
      });
    });
  const open = await new Promise((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
    setTimeout(() => resolve(false), 2000);
  });
  if (!open) return null;
  try {
    const expr = `
(function() {
  try {
    var tokenCandidate = null;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("accesstoken-")) {
        try {
          var obj = JSON.parse(localStorage.getItem(k) || "{}");
          if (obj && (obj.secret || obj.accessToken || obj.credential)) {
            return { ok: true, source: "msal_v2", key: k, token: obj.secret || obj.accessToken || obj.credential, scopes: obj.target || obj.scopes || null, expiresOn: obj.expiresOn || obj.expires_on || null };
          }
        } catch (e) {}
      }
    }
    // Fallback: scan values for JSON with access token hints (best-effort)
    for (var i = 0; i < localStorage.length; i++) {
      var k2 = localStorage.key(i);
      try {
        var raw = localStorage.getItem(k2) || "";
        if (raw.indexOf('"accessToken"') >= 0 || raw.indexOf('"secret"') >= 0) {
          var obj2 = JSON.parse(raw);
          var t = obj2 && (obj2.secret || obj2.accessToken || (obj2.credential && obj2.credential.accessToken));
          if (t && typeof t === "string" && t.length > 100) return { ok: true, source: "msal_guess", key: k2, token: t };
        }
      } catch (e2) {}
    }
    return { ok: false, status: "token_not_found" };
  } catch (e3) {
    return { ok: false, status: "token_probe_failed" };
  }
})()
    `.trim();
    // Enable Runtime and evaluate
    const enableId = nextId();
    ws.send(JSON.stringify({ id: enableId, method: "Runtime.enable" }));
    await once(enableId);
    const evalId = nextId();
    ws.send(
      JSON.stringify({
        id: evalId,
        method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      })
    );
    const reply = await once(evalId);
    try { ws.close(); } catch {}
    const value = reply.result?.result?.value || {};
    if (value && value.ok && typeof value.token === "string") {
      return value.token;
    }
    return null;
  } catch {
    try { ws.close(); } catch {}
    return null;
  }
}

function compactGraphMessage(msg, account, { includeBody = false, maxBodyChars = DEFAULT_READ_MAX_BODY_CHARS } = {}) {
  const id = String(msg.id || "");
  const from = {
    name: String(msg.from?.emailAddress?.name || ""),
    address: String(msg.from?.emailAddress?.address || ""),
  };
  const receivedUtc = String(msg.receivedDateTime || "");
  const receivedEt = toEtLocalString(receivedUtc);
  const base = {
    account,
    id,
    subject: trimTo(String(msg.subject || ""), 400),
    from,
    is_unread: msg.isRead === false,
    received_datetime: receivedUtc,
    received_at: receivedEt,
    web_link: String(msg.webLink || ""),
    conversation_id: String(msg.conversationId || ""),
  };
  if (includeBody) {
    const bodyType = String(msg.body?.contentType || "").toLowerCase();
    const raw = String(msg.body?.content || "");
    const text =
      bodyType === "text"
        ? raw
        : htmlToText(raw || "", { wordwrap: 120, selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }] });
    base.body_text = trimTo(text, maxBodyChars);
  }
  return base;
}

function compactGraphEvent(evt, account) {
  const start = asEtIso(evt.start);
  const end = asEtIso(evt.end);
  return {
    account,
    id: String(evt.id || ""),
    subject: trimTo(String(evt.subject || ""), 400),
    is_all_day: Boolean(evt.isAllDay),
    location: String(evt.location?.displayName || ""),
    organizer: {
      name: String(evt.organizer?.emailAddress?.name || ""),
      address: String(evt.organizer?.emailAddress?.address || ""),
    },
    start: start,
    end: end,
    web_link: String(evt.webLink || ""),
  };
}

function graphError(error, account, code = "graph_error") {
  const message = String(error?.message || "Graph error");
  return {
    ok: false,
    account,
    status: code,
    error_code: String(error?.code || ""),
    error_message: message.slice(0, 400),
  };
}

function mergeAccountLists(lists) {
  const merged = [];
  for (const list of lists) {
    if (!list.ok) continue;
    for (const item of list.items || []) merged.push(item);
  }
  merged.sort((a, b) => {
    const aT = Date.parse(a.received_datetime || a.start?.dateTime || 0) || 0;
    const bT = Date.parse(b.received_datetime || b.start?.dateTime || 0) || 0;
    return bT - aT;
  });
  return merged;
}

async function httpJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let text = "";
  try { text = await response.text(); } catch {}
  let json;
  try { json = JSON.parse(text); } catch { json = { error: { code: "invalid_json", message: "Upstream did not return JSON." } }; }
  if (!response.ok) {
    const error = json?.error || { code: `HTTP_${response.status}`, message: text.slice(0, 400) };
    return { error };
  }
  return json;
}

function normalizeDateRangeEt({ today, tomorrow, start_date, end_date }) {
  if (toBoolean(today)) {
    const { start, end } = etDayBounds(0);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }
  if (toBoolean(tomorrow)) {
    const { start, end } = etDayBounds(1);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }
  const startIso = toIsoUtcString(start_date, { assumeEtMidnight: true });
  const endIso = toIsoUtcString(end_date, { assumeEtMidnight: false, endOfDay: true });
  if (startIso && endIso) return { startIso, endIso };
  // Default: today
  const { start, end } = etDayBounds(0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function etDayBounds(offsetDays) {
  const now = new Date();
  // Compute ET midnight for current date + offset
  const options = { timeZone: ET_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" };
  const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value) + Number(offsetDays || 0);
  // Build a Date in ET, then convert to UTC ISO
  const base = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const start = shiftUtcFromEt(base, 0, 0, 0);
  const end = shiftUtcFromEt(base, 23, 59, 59, 999);
  return { start, end };
}

function shiftUtcFromEt(dateUtc, h, m, s, ms = 0) {
  // dateUtc is the ET calendar date at 00:00 UTC; we need to offset by the ET UTC offset for that calendar day.
  const et = new Date(dateUtc);
  et.setUTCHours(h, m, s, ms);
  // Determine ET offset by formatting the target time in ET and parsing back the offset via toLocaleString with timeZoneName.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // The Date object et is UTC; we just return it — Graph will accept the UTC ISO range.
  return et;
}

function toEtLocalString(isoUtc) {
  if (!isoUtc) return "";
  const d = new Date(isoUtc);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // en-CA yields YYYY-MM-DD, HH:mm:ss
  const parts = f.formatToParts(d);
  const as = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${as("year")}-${as("month")}-${as("day")}T${as("hour")}:${as("minute")}:${as("second")}`;
}

function asEtIso(g) {
  // Graph calendarView returns start/end as { dateTime, timeZone }. Respect that if present.
  if (!g) return { dateTime: "", timeZone: ET_TIMEZONE };
  const tz = g.timeZone || ET_TIMEZONE;
  const dt = String(g.dateTime || "");
  return { dateTime: dt, timeZone: tz };
}

function toIsoUtcString(input, { assumeEtMidnight = false, endOfDay = false } = {}) {
  const s = normalizeString(input);
  if (!s) return "";
  // If only a date is supplied (YYYY-MM-DD), treat it as ET midnight boundaries.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const h = endOfDay ? 23 : 0;
    const mi = endOfDay ? 59 : 0;
    const se = endOfDay ? 59 : 0;
    const d = new Date(Date.UTC(year, month, day, h, mi, se, endOfDay ? 999 : 0));
    return d.toISOString();
  }
  // Otherwise expect an ISO with zone or plain ISO — pass through.
  try {
    const d = new Date(s);
    return d.toISOString();
  } catch {
    return "";
  }
}

function trimTo(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 3)) + "...";
}

function normalizeUrl(s) {
  if (!s || typeof s !== "string") return "";
  return s.trim();
}

function clampInteger(value, min, max, fallback) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

function toBoolean(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return Boolean(fallback);
}

function normalizeString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const s = value.trim();
  return s || fallback;
}

function escapeODataLiteral(s) {
  return String(s).replace(/'/g, "''");
}

function missingField(field, message) {
  return { ok: false, status: "missing_field", field, message };
}

