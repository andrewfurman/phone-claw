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
  normalizeUrl(process.env.OUTLOOK_GRAPH_BASE_URL) || "https://graph.microsoft.com";
const OUTLOOK_REST_BASE =
  normalizeUrl(process.env.OUTLOOK_REST_BASE_URL) || "https://outlook.office.com";

export async function outlookStatus({ account } = {}) {
  const targets = await resolveAccounts(account);
  const summaries = [];
  for (const target of targets) {
    const auth = await safeGetBestToken(target, "mail").catch(() => null);
    summaries.push({
      account: target.label,
      ok: Boolean(auth?.token),
      status: auth?.token ? "signed_in" : "needs_sign_in",
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
    const auth = await safeGetBestToken(target, "mail");
    if (!auth?.token) {
      queries.push({
        ok: false,
        account: target.label,
        status: "needs_sign_in",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const token = auth.token;
    const first = auth.api || preferredApiForToken(decodeJwtClaims(token));
    const attempt = async (api) => {
      if (api === "graph") {
        const url = new URL("/v1.0/me/mailFolders/Inbox/messages", ensureTrailingSlash(GRAPH_BASE));
        const params = new URLSearchParams();
        params.set("$select", "id,subject,from,receivedDateTime,isRead,conversationId,webLink");
        params.set("$orderby", "receivedDateTime desc");
        params.set("$top", String(boundedLimit));
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
        const headers = graphHeaders(token, { needsConsistencyLevel: Boolean(params.get("$search")) });
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "graph" });
      } else {
        const url = new URL("/api/v2.0/me/messages", ensureTrailingSlash(OUTLOOK_REST_BASE));
        const params = new URLSearchParams();
        params.set("$select", "Id,Subject,From,ReceivedDateTime,IsRead,ConversationId,WebLink");
        params.set("$orderby", "ReceivedDateTime desc");
        params.set("$top", String(boundedLimit));
        // Outlook REST v2.0 supports $filter; $search support varies, prefer $filter when possible.
        const filters = [];
        if (toBoolean(unread)) filters.push("IsRead eq false");
        const sender = normalizeString(from);
        if (sender) filters.push(`From/EmailAddress/Address eq '${escapeODataLiteral(sender)}'`);
        const sinceIso = toIsoUtcString(since, { assumeEtMidnight: true });
        if (sinceIso) filters.push(`ReceivedDateTime ge ${sinceIso}`);
        if (filters.length) params.set("$filter", filters.join(" and "));
        if (!filters.length && normalizeString(search)) params.set("$search", `"${normalizeString(search)}"`);
        url.search = params.toString();
        const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "outlook_rest" });
      }
    };
    let res = await attempt(first);
    if (!res.ok && shouldFallback(res)) {
      const second = first === "graph" ? "outlook_rest" : "graph";
      const res2 = await attempt(second);
      res = res2;
    }
    if (!res.ok) {
      queries.push({
        ok: false,
        account: target.label,
        status: "upstream_error",
        upstream_http_status: res.status,
        upstream_error: res.error || "",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const isGraph = res.api === "graph";
    const rows = Array.isArray(res.body?.value) ? res.body.value : [];
    const items = rows.map((m) => (isGraph ? compactGraphMessage(m, target.label) : compactOutlookRestMessage(m, target.label)));
    queries.push({ ok: true, account: target.label, status: "ok", returned_count: items.length, items });
  }
  // Merge results for "all"
  const merged = mergeAccountLists(queries);
  const anyError = queries.some((q) => !q.ok);
  const allFailed = queries.every((q) => !q.ok);
  return {
    ok: !allFailed,
    status: allFailed ? "upstream_error" : "ok",
    scope: accountScopeLabel(account),
    returned_count: merged.length,
    items: merged,
    answer_text:
      merged.length === 0 && anyError
        ? "The Outlook upstream call failed."
        : merged.length === 0
        ? "No messages matched."
        : `Found ${merged.length} message${merged.length === 1 ? "" : "s"}.`,
    accounts: queries,
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
    const auth = await safeGetBestToken(target, "mail");
    if (!auth?.token) continue;
    const token = auth.token;
    const claims = decodeJwtClaims(token);
    const first = auth.api || preferredApiForToken(claims);
    const attempt = async (api) => {
      if (api === "graph") {
        const url = new URL(`/v1.0/me/messages/${encodeURIComponent(messageId)}`, ensureTrailingSlash(GRAPH_BASE));
        const params = new URLSearchParams();
        params.set("$select", "id,subject,from,receivedDateTime,body,webLink");
        url.search = params.toString();
        const headers = graphHeaders(token);
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "graph" });
      } else {
        const url = new URL(`/api/v2.0/me/messages/${encodeURIComponent(messageId)}`, ensureTrailingSlash(OUTLOOK_REST_BASE));
        const params = new URLSearchParams();
        params.set("$select", "Id,Subject,From,ReceivedDateTime,Body,WebLink");
        url.search = params.toString();
        const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "outlook_rest" });
      }
    };
    let res = await attempt(first);
    if (!res.ok && shouldFallback(res)) res = await attempt(first === "graph" ? "outlook_rest" : "graph");
    if (!res.ok) return { ok: false, status: "message_read_failed", account: target.label, id: messageId, upstream_http_status: res.status, answer_text: "The Outlook upstream call failed." };
    const isGraph = res.api === "graph";
    const raw = res.body || {};
    const compact = (isGraph ? compactGraphMessage(raw, target.label, {
      includeBody: true,
      maxBodyChars: clampInteger(maxBodyChars, 2000, MAX_READ_MAX_BODY_CHARS, DEFAULT_READ_MAX_BODY_CHARS),
    }) : compactOutlookRestMessage(raw, target.label, {
      includeBody: true,
      maxBodyChars: clampInteger(maxBodyChars, 2000, MAX_READ_MAX_BODY_CHARS, DEFAULT_READ_MAX_BODY_CHARS),
    }));
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
    const auth = await safeGetBestToken(target, "mail");
    if (!auth?.token) {
      lists.push({
        ok: false,
        account: target.label,
        status: "needs_sign_in",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const token = auth.token;
    const first = auth.api || preferredApiForToken(decodeJwtClaims(token));
    const attempt = async (api) => {
      if (api === "graph") {
        const url = new URL("/v1.0/me/messages", ensureTrailingSlash(GRAPH_BASE));
        const params = new URLSearchParams();
        params.set("$select", "id,subject,from,receivedDateTime,isRead,conversationId,webLink");
        params.set("$search", `"${normalizeString(query)}"`);
        params.set("$orderby", "receivedDateTime desc");
        params.set("$top", String(boundedLimit));
        url.search = params.toString();
        const headers = graphHeaders(token, { needsConsistencyLevel: true });
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "graph" });
      } else {
        const url = new URL("/api/v2.0/me/messages", ensureTrailingSlash(OUTLOOK_REST_BASE));
        const params = new URLSearchParams();
        params.set("$select", "Id,Subject,From,ReceivedDateTime,IsRead,ConversationId,WebLink");
        params.set("$orderby", "ReceivedDateTime desc");
        params.set("$top", String(boundedLimit));
        params.set("$search", `"${normalizeString(query)}"`); // best-effort; some tenants may not support it
        url.search = params.toString();
        const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "outlook_rest" });
      }
    };
    let res = await attempt(first);
    if (!res.ok && shouldFallback(res)) res = await attempt(first === "graph" ? "outlook_rest" : "graph");
    if (!res.ok) {
      lists.push({ ok: false, account: target.label, status: "search_failed", upstream_http_status: res.status, upstream_error: res.error || "", returned_count: 0, items: [] });
      continue;
    }
    const isGraph = res.api === "graph";
    const items = Array.isArray(res.body?.value) ? res.body.value : [];
    lists.push({ ok: true, account: target.label, status: "ok", returned_count: items.length, items: items.map((m) => (isGraph ? compactGraphMessage(m, target.label) : compactOutlookRestMessage(m, target.label))) });
  }
  const merged = mergeAccountLists(lists);
  return {
    ok: lists.some(l => l.ok),
    status: lists.some(l => l.ok) ? "ok" : "search_failed",
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
  const { startLocal, endLocal } = normalizeEtLocalRange({ today, tomorrow, start_date, end_date });
  const boundedLimit = clampInteger(limit, 1, 200, 50);
  const lists = [];
  for (const target of targets) {
    const auth = await safeGetBestToken(target, "calendar");
    if (!auth?.token) {
      lists.push({
        ok: false,
        account: target.label,
        status: "needs_sign_in",
        returned_count: 0,
        items: [],
      });
      continue;
    }
    const token = auth.token;
    const first = auth.api || preferredApiForToken(decodeJwtClaims(token));
    const attempt = async (api) => {
      if (api === "graph") {
        const url = new URL("/v1.0/me/calendarView", ensureTrailingSlash(GRAPH_BASE));
        const params = new URLSearchParams();
        params.set("startDateTime", startLocal);
        params.set("endDateTime", endLocal);
        params.set("$top", String(boundedLimit));
        params.set("$orderby", "start/dateTime asc");
        params.set("$select", "id,subject,start,end,location,organizer,isAllDay,webLink");
        url.search = params.toString();
        const headers = graphHeaders(token, { preferOutlookTz: ET_TIMEZONE });
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "graph" });
      } else {
        const url = new URL("/api/v2.0/me/calendarview", ensureTrailingSlash(OUTLOOK_REST_BASE));
        const params = new URLSearchParams();
        params.set("startDateTime", startLocal);
        params.set("endDateTime", endLocal);
        params.set("$top", String(boundedLimit));
        params.set("$orderby", "Start/DateTime asc");
        params.set("$select", "Id,Subject,Start,End,Location,Organizer,IsAllDay,WebLink");
        url.search = params.toString();
        const headers = { authorization: `Bearer ${token}`, accept: "application/json", prefer: `outlook.timezone="${ET_TIMEZONE}"` };
        return await fetchJsonDetailed(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, api: "outlook_rest" });
      }
    };
    let res = await attempt(first);
    if (!res.ok && shouldFallback(res)) res = await attempt(first === "graph" ? "outlook_rest" : "graph");
    if (!res.ok) {
      lists.push({ ok: false, account: target.label, status: "agenda_failed", upstream_http_status: res.status, upstream_error: res.error || "", returned_count: 0, items: [] });
      continue;
    }
    const isGraph = res.api === "graph";
    const values = Array.isArray(res.body?.value) ? res.body.value : [];
    lists.push({ ok: true, account: target.label, status: "ok", returned_count: values.length, items: values.map((e) => (isGraph ? compactGraphEvent(e, target.label) : compactOutlookRestEvent(e, target.label))) });
  }
  // Return a per-account map; do not merge calendar events across accounts into one list by default
  const result = {
    ok: true,
    status: "ok",
    scope: accountScopeLabel(account),
    start_date: startLocal,
    end_date: endLocal,
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

async function safeGetBestToken(target, purpose /* "mail" | "calendar" */) {
  // Allow test override without CDP
  const envOverride =
    (target.label === "covernode" && process.env.OUTLOOK_TEST_TOKEN_COVERNODE) ||
    (target.label === "adga" && process.env.OUTLOOK_TEST_TOKEN_ADGA) ||
    process.env.OUTLOOK_TEST_TOKEN ||
    "";
  if (normalizeString(envOverride)) return { token: envOverride, api: preferredApiForToken(decodeJwtClaims(envOverride)) };
  return await getBestTokenViaCdp(target, purpose);
}

async function getBestTokenViaCdp({ cdpPort, mainUrl, label }, purpose) {
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
  async function scanOnce() {
    const expr = `
(function() {
  try {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i) || "";
      var raw = null;
      try { raw = localStorage.getItem(k) || ""; } catch(e) {}
      if (!raw) continue;
      try {
        var obj = JSON.parse(raw);
        if (k.startsWith("msal.3|") && obj && obj.credentialType === "AccessToken" && typeof obj.secret === "string") {
          out.push({ key: k, source: "msal_v3", target: String(obj.target||""), expiresOn: Number(obj.expiresOn||0), token: obj.secret });
          continue;
        }
        if (k.startsWith("accesstoken-") && (obj.secret || obj.accessToken || obj.credential)) {
          out.push({ key: k, source: "msal_v2", target: String(obj.target||obj.scopes||""), expiresOn: Number(obj.expiresOn||obj.expires_on||0), token: obj.secret || obj.accessToken || obj.credential });
          continue;
        }
      } catch (e) {
        // ignore parse errors
      }
    }
    return { ok: true, tokens: out };
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
    const value = reply.result?.result?.value || {};
    return (value && value.ok && Array.isArray(value.tokens)) ? value.tokens : [];
  }
  try {
    let tokens = await scanOnce();
    let best = pickBestToken(tokens, purpose);
    if (!best) {
      // Ask the page to reload and try again once to allow MSAL to refresh silently
      const reloadId = nextId();
      ws.send(JSON.stringify({ id: reloadId, method: "Page.reload", params: { ignoreCache: true } }));
      await new Promise(r => setTimeout(r, 1500));
      tokens = await scanOnce();
      best = pickBestToken(tokens, purpose);
    }
    try { ws.close(); } catch {}
    return best ? { token: best.token, api: best.api } : null;
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

function compactOutlookRestMessage(msg, account, { includeBody = false, maxBodyChars = DEFAULT_READ_MAX_BODY_CHARS } = {}) {
  // Outlook REST uses PascalCase fields
  const id = String(msg.Id || "");
  const from = {
    name: String(msg.From?.EmailAddress?.Name || ""),
    address: String(msg.From?.EmailAddress?.Address || ""),
  };
  const receivedUtc = String(msg.ReceivedDateTime || "");
  const receivedEt = toEtLocalString(receivedUtc);
  const base = {
    account,
    id,
    subject: trimTo(String(msg.Subject || ""), 400),
    from,
    is_unread: msg.IsRead === false,
    received_datetime: receivedUtc,
    received_at: receivedEt,
    web_link: String(msg.WebLink || ""),
    conversation_id: String(msg.ConversationId || ""),
  };
  if (includeBody) {
    const bodyType = String(msg.Body?.ContentType || "").toLowerCase();
    const raw = String(msg.Body?.Content || "");
    const text = bodyType === "text" ? raw : htmlToText(raw || "", { wordwrap: 120, selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }] });
    base.body_text = trimTo(text, maxBodyChars);
  }
  return base;
}

function compactOutlookRestEvent(evt, account) {
  const start = { dateTime: String(evt.Start?.DateTime || ""), timeZone: String(evt.Start?.TimeZone || ET_TIMEZONE) };
  const end = { dateTime: String(evt.End?.DateTime || ""), timeZone: String(evt.End?.TimeZone || ET_TIMEZONE) };
  return {
    account,
    id: String(evt.Id || ""),
    subject: trimTo(String(evt.Subject || ""), 400),
    is_all_day: Boolean(evt.IsAllDay),
    location: String(evt.Location?.DisplayName || ""),
    organizer: {
      name: String(evt.Organizer?.EmailAddress?.Name || ""),
      address: String(evt.Organizer?.EmailAddress?.Address || ""),
    },
    start,
    end,
    web_link: String(evt.WebLink || ""),
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

async function fetchJsonDetailed(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, api } = {}) {
  const response = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text().catch(() => "");
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { ok: response.ok, status: response.status, body, error: !response.ok ? (body?.error?.message || String(text).slice(0, 200)) : "", api: api || (String(url).includes("graph.microsoft.com") ? "graph" : "outlook_rest") };
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

function normalizeEtLocalRange({ today, tomorrow, start_date, end_date }) {
  // Return ET-local wall times as YYYY-MM-DDTHH:mm:ss strings for API calls that honor Prefer: outlook.timezone
  const nowMs = Number(process.env.OUTLOOK_TEST_NOW_MS || 0) || Date.now();
  const ymd = (offset) => {
    const now = new Date(nowMs);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ET_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    let year = Number(parts.find((p) => p.type === "year")?.value);
    let month = Number(parts.find((p) => p.type === "month")?.value);
    let day = Number(parts.find((p) => p.type === "day")?.value) + offset;
    // Build a date in ET by adjusting UTC parts; we just need the Y-M-D string, not a Date.
    const d = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const again = new Intl.DateTimeFormat("en-CA", { timeZone: ET_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    return `${again.find(p=>p.type==="year")?.value}-${again.find(p=>p.type==="month")?.value}-${again.find(p=>p.type==="day")?.value}`;
  };
  if (toBoolean(today)) {
    const d = ymd(0);
    return { startLocal: `${d}T00:00:00`, endLocal: `${d}T23:59:59` };
  }
  if (toBoolean(tomorrow)) {
    const d = ymd(1);
    return { startLocal: `${d}T00:00:00`, endLocal: `${d}T23:59:59` };
  }
  const s = normalizeString(start_date);
  const e = normalizeString(end_date);
  const startLocal = s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s || "";
  const endLocal = e && /^\d{4}-\d{2}-\d{2}$/.test(e) ? `${e}T23:59:59` : e || "";
  if (startLocal && endLocal) return { startLocal, endLocal };
  const d = ymd(0);
  return { startLocal: `${d}T00:00:00`, endLocal: `${d}T23:59:59` };
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

function decodeJwtClaims(token) {
  try {
    const [, payload] = String(token).split(".");
    if (!payload) return {};
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4);
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function preferredApiForToken(claims) {
  const aud = String(claims?.aud || "").toLowerCase();
  if (aud.includes("graph.microsoft.com") || aud === "00000003-0000-0000-c000-000000000000") return "graph";
  if (aud.includes("outlook.office.com") || aud === "00000002-0000-0ff1-ce00-000000000000" || aud.includes("substrate.office.com")) return "outlook_rest";
  return "graph"; // default
}

function shouldFallback(res) {
  return !res.ok && (res.status === 401 || res.status === 403 || res.status === 404);
}

function ensureTrailingSlash(base) {
  return base.endsWith("/") ? base : base + "/";
}

function pickBestToken(tokens, purpose) {
  const nowSec = Math.floor(Date.now() / 1000);
  const margin = 60;
  const need = purpose === "calendar" ? "Calendars.Read" : "Mail.Read";
  const filtered = tokens
    .map(t => ({ ...t, target: String(t.target || ""), expiresOn: Number(t.expiresOn || 0) }))
    .filter(t => t.token && t.token.length > 100);
  const valid = filtered.filter(t => t.expiresOn > nowSec + margin);
  const byPref = (domain) =>
    valid
      .filter(t => t.target.includes(domain) && t.target.includes(need))
      .sort((a, b) => b.expiresOn - a.expiresOn)[0];
  const outlook = byPref("outlook.office.com");
  if (outlook) return { token: outlook.token, api: "outlook_rest", target: outlook.target, expiresOn: outlook.expiresOn };
  const graph = byPref("graph.microsoft.com");
  if (graph) return { token: graph.token, api: "graph", target: graph.target, expiresOn: graph.expiresOn };
  return null;
}

// Test hook for msal.3 parsing/selection
export function __test_selectBestTokenFromMsalEntries(entries, purpose) {
  return pickBestToken(entries, purpose);
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

