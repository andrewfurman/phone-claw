import { htmlToText } from "html-to-text";
import {
  economistBrowserFetchConfigured,
  fetchEconomistArticleWithBrowser,
} from "./economist-browser-fetcher.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_MAX_TEXT_CHARS = 30_000;
const MAX_TEXT_CHARS = 120_000;
const RSS_BRIDGE_VIRTUAL_ID_BASE = 900_000_000;
const DEFAULT_RSS_BRIDGE_URL =
  "https://cli-bridge.aifurman.com/rss/economist/latest.atom";

export function minifluxConfigured() {
  return Boolean(process.env.MINIFLUX_API_TOKEN);
}

export function economistFullTextBrowserConfigured() {
  return economistBrowserFetchConfigured();
}

export function economistRssBridgeConfigured() {
  return Boolean(
    normalizeString(process.env.ECONOMIST_RSS_BRIDGE_URL) ||
      normalizeString(process.env.ECONOMIST_RSS_BRIDGE_TOKEN) ||
      normalizeString(process.env.ECONOMIST_PUBLIC_RSS_TOKEN)
  );
}

export async function rssRecentEntries({
  limit = DEFAULT_LIMIT,
  status = "all",
  maxExcerptChars = 320,
} = {}) {
  return rssSearchEntries({
    query: "",
    limit,
    status,
    maxExcerptChars,
  });
}

export async function rssSearchEntries({
  query = "",
  startDate,
  endDate,
  limit = DEFAULT_LIMIT,
  status = "all",
  maxExcerptChars = 320,
} = {}) {
  const boundedLimit = clampInteger(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const boundedExcerptChars = clampInteger(maxExcerptChars, 80, 1_200, 320);
  const normalizedStatus = normalizeEnum(status, ["all", "read", "unread"], "all");
  const normalizedQuery = normalizeString(query);
  const rssBridgeEntries = await rssBridgeCompactEntries({
    query: normalizedQuery,
    startDate,
    endDate,
    maxExcerptChars: boundedExcerptChars,
    include: normalizedStatus === "all",
  });

  if (!minifluxConfigured()) {
    if (rssBridgeEntries.ok) {
      const entries = rssBridgeEntries.items.slice(0, boundedLimit);
      return {
        ok: true,
        status: "ok",
        provider: "rss_bridge",
        source: "economist",
        query: normalizedQuery,
        start_date: startDate || "",
        end_date: endDate || "",
        returned_count: entries.length,
        total_count: entries.length,
        category_id: null,
        category_title: "",
        rss_bridge_status: rssBridgeEntries.status,
        rss_bridge_message: rssBridgeEntries.message || "",
        items: entries,
        answer_text: formatEntriesAnswer(entries, normalizedQuery, "RSS-Bridge"),
      };
    }
    return notConfiguredResponse();
  }

  const category = await economistCategory();
  if (!category.ok) return category;

  const params = new URLSearchParams();
  params.set("limit", String(boundedLimit));
  params.set("order", "published_at");
  params.set("direction", "desc");
  if (category.category_id) params.set("category_id", String(category.category_id));

  if (normalizedStatus !== "all") params.append("status", normalizedStatus);

  if (normalizedQuery) params.set("search", normalizedQuery);

  const after = unixSeconds(startDate);
  const before = unixSeconds(endDate);
  if (after) params.set("published_after", String(after));
  if (before) params.set("published_before", String(before));

  const result = await minifluxRequest(`/v1/entries?${params.toString()}`);
  if (!result.ok) return result;

  const entries = Array.isArray(result.body?.entries)
    ? result.body.entries.map((entry) =>
        compactEntry(entry, { maxExcerptChars: boundedExcerptChars })
      )
    : [];
  const mergedEntries = mergeEntries(rssBridgeEntries.ok ? rssBridgeEntries.items : [], entries)
    .slice(0, boundedLimit);

  return {
    ok: true,
    status: "ok",
    provider: rssBridgeEntries.ok ? "rss_bridge+miniflux" : "miniflux",
    source: "economist",
    query: normalizedQuery,
    start_date: startDate || "",
    end_date: endDate || "",
    returned_count: mergedEntries.length,
    total_count: Number.isFinite(result.body?.total) ? result.body.total : null,
    category_id: category.category_id || null,
    category_title: category.category_title || "",
    rss_bridge_status: rssBridgeEntries.status,
    rss_bridge_message: rssBridgeEntries.message || "",
    items: mergedEntries,
    answer_text: formatEntriesAnswer(mergedEntries, normalizedQuery, providerLabel(rssBridgeEntries)),
  };
}

export async function rssEntryFullText({
  entryId,
  id,
  articleUrl,
  url,
  fetchOriginal = true,
  updateContent = true,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
} = {}) {
  const normalizedId = normalizeInteger(entryId || id);
  const normalizedUrl = normalizeString(articleUrl || url);
  const boundedMax = clampInteger(maxTextChars, 2_000, MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);

  if (!normalizedId) {
    if (normalizedUrl) {
      return rssBridgeFullTextResult({ entryId: null, articleUrl: normalizedUrl, maxTextChars: boundedMax });
    }
    return missingField("entry_id", "An Economist entry id is required.");
  }

  if (isRssBridgeVirtualId(normalizedId) || normalizedUrl) {
    const rssBridgeResult = await rssBridgeFullTextResult({
      entryId: normalizedId,
      articleUrl: normalizedUrl,
      maxTextChars: boundedMax,
    });
    if (rssBridgeResult.ok || isRssBridgeVirtualId(normalizedId)) return rssBridgeResult;
  }

  if (!minifluxConfigured()) return notConfiguredResponse();

  const entryResult = await minifluxRequest(`/v1/entries/${normalizedId}`);
  if (!entryResult.ok) return entryResult;

  const entry = entryResult.body || {};
  let contentHtml = normalizeString(entry.content);
  let contentSource = "stored_entry_content";
  let fetchStatus = "not_requested";
  let fetchMessage = "";
  let browserFetchStatus = "not_requested";
  let browserFetchMessage = "";
  let browserFetchUrl = "";
  let rssBridgeFetchStatus = "not_requested";
  let rssBridgeFetchMessage = "";
  let rssBridgeUrl = "";

  if (toBoolean(fetchOriginal, true)) {
    const params = new URLSearchParams({
      update_content: toBoolean(updateContent, true) ? "true" : "false",
    });
    const fetched = await minifluxRequest(
      `/v1/entries/${normalizedId}/fetch-content?${params.toString()}`
    );
    fetchStatus = fetched.ok ? "ok" : fetched.status || "fetch_failed";
    fetchMessage = fetched.ok ? "" : normalizeString(fetched.message);
    if (fetched.ok && normalizeString(fetched.body?.content)) {
      contentHtml = fetched.body.content;
      contentSource = "original_article_fetch";
    }
  }

  let contentText = normalizeArticleText(htmlToText(contentHtml || "", {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }));
  const compact = compactEntry(entry, { maxExcerptChars: 420 });

  const rssBridgeResult = await rssBridgeFullTextResult({
    articleUrl: entry.url,
    title: entry.title,
    maxTextChars: boundedMax,
    allowNoMatch: true,
  });
  rssBridgeFetchStatus = rssBridgeResult.status || "not_requested";
  rssBridgeFetchMessage = rssBridgeResult.message || rssBridgeResult.access_note || "";
  rssBridgeUrl = rssBridgeResult.rss_bridge_url || "";

  if (
    rssBridgeResult.ok &&
    rssBridgeResult.full_text_chars > Math.max(contentText.length, 700)
  ) {
    contentText = rssBridgeResult.full_text || "";
    contentSource = "economist_rss_bridge";
  }

  if (shouldTryBrowserFallback({ contentText, fetchStatus }) && entry.url) {
    const browserResult = await fetchEconomistArticleWithBrowser({
      url: entry.url,
      maxTextChars: boundedMax,
    });
    browserFetchStatus = browserResult.status || "browser_fetch_unknown";
    browserFetchMessage = browserResult.message || "";
    browserFetchUrl = browserResult.final_url || browserResult.url || entry.url;

    if (browserResult.ok && browserResult.full_text_chars > contentText.length) {
      contentText = browserResult.full_text || "";
      contentSource = "economist_browser_fetch";
    }
  }

  const truncated = truncateText(contentText, boundedMax);

  return {
    ok: true,
    status: "ok",
    provider: "miniflux",
    source: "economist",
    entry: compact,
    entry_id: normalizedId,
    content_source: contentSource,
    original_fetch_status: fetchStatus,
    original_fetch_message: fetchMessage,
    rss_bridge_fetch_status: rssBridgeFetchStatus,
    rss_bridge_fetch_message: rssBridgeFetchMessage,
    rss_bridge_url: rssBridgeUrl,
    browser_fetch_status: browserFetchStatus,
    browser_fetch_message: browserFetchMessage,
    browser_fetch_url: browserFetchUrl,
    full_text_chars: contentText.length,
    returned_text_chars: truncated.value.length,
    full_text_truncated: truncated.truncated,
    full_text: truncated.value,
    access_note: accessNote(contentText, entry, {
      fetchStatus,
      fetchMessage,
      rssBridgeFetchStatus,
      rssBridgeFetchMessage,
      contentSource,
      browserFetchStatus,
      browserFetchMessage,
    }),
    answer_text: `Retrieved article text for "${compact.title}". ${truncated.truncated ? "The returned text is truncated." : "The returned text is complete within the configured limit."}`,
  };
}

function shouldTryBrowserFallback({ contentText, fetchStatus }) {
  if (!economistBrowserFetchConfigured()) return false;
  if (fetchStatus && !["ok", "not_requested"].includes(fetchStatus)) return true;
  return String(contentText || "").length < 700;
}

async function rssBridgeCompactEntries({
  query = "",
  startDate,
  endDate,
  maxExcerptChars = 320,
  include = true,
} = {}) {
  if (!include) return { ok: false, status: "not_requested", items: [] };

  const feed = await rssBridgeLatestFeed();
  if (!feed.ok) return { ...feed, items: [] };

  const normalizedQuery = normalizeString(query).toLowerCase();
  const after = unixSeconds(startDate);
  const before = unixSeconds(endDate);
  const items = feed.entries
    .filter((entry) => {
      const published = unixSeconds(entry.published_at || entry.updated_at);
      if (after && published && published < after) return false;
      if (before && published && published > before) return false;
      if (!normalizedQuery) return true;
      return [entry.title, entry.url, entry.full_text]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .map((entry) => compactRssBridgeEntry(entry, { maxExcerptChars }));

  return {
    ok: true,
    status: "ok",
    message: "",
    items,
  };
}

async function rssBridgeFullTextResult({
  entryId,
  articleUrl,
  title,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  allowNoMatch = false,
} = {}) {
  const feed = await rssBridgeLatestFeed();
  if (!feed.ok) {
    return {
      ok: false,
      status: feed.status,
      message: feed.message,
      answer_text: "The Economist RSS-Bridge full-text feed is not available.",
    };
  }

  const match = findRssBridgeEntry(feed.entries, { entryId, articleUrl, title });
  if (!match) {
    return {
      ok: false,
      status: allowNoMatch ? "rss_bridge_no_matching_entry" : "rss_bridge_entry_not_found",
      message: "The RSS-Bridge latest feed did not contain the requested Economist article.",
      rss_bridge_url: feed.url,
      answer_text:
        "The Economist full-text bridge is available, but it did not contain that specific article.",
    };
  }

  const text = normalizeArticleText(match.full_text || "");
  const truncated = truncateText(text, maxTextChars);
  const entry = compactRssBridgeEntry(match, { maxExcerptChars: 420 });

  return {
    ok: true,
    status: "ok",
    provider: "rss_bridge",
    source: "economist",
    entry,
    entry_id: entry.id,
    content_source: "economist_rss_bridge",
    original_fetch_status: "not_requested",
    original_fetch_message: "",
    rss_bridge_fetch_status: "ok",
    rss_bridge_fetch_message: "",
    rss_bridge_url: feed.url,
    browser_fetch_status: "not_requested",
    browser_fetch_message: "",
    browser_fetch_url: "",
    full_text_chars: text.length,
    returned_text_chars: truncated.value.length,
    full_text_truncated: truncated.truncated,
    full_text: truncated.value,
    access_note: accessNote(text, entry, {
      contentSource: "economist_rss_bridge",
      rssBridgeFetchStatus: "ok",
    }),
    answer_text: `Retrieved full Economist article text for "${entry.title}" from RSS-Bridge. ${truncated.truncated ? "The returned text is truncated." : "The returned text is complete within the configured limit."}`,
  };
}

export async function rssRefreshFeeds() {
  if (!minifluxConfigured()) return notConfiguredResponse();

  const category = await economistCategory();
  if (!category.ok) return category;
  if (!category.category_id) {
    return {
      ok: false,
      status: "economist_category_not_found",
      message: "Could not find the Economist category in Miniflux.",
      answer_text: "I could not find the Economist feed category.",
    };
  }

  const result = await minifluxRequest(`/v1/categories/${category.category_id}/refresh`, {
    method: "PUT",
    expectNoContent: true,
  });
  if (!result.ok) return result;

  return {
    ok: true,
    status: "refresh_started",
    provider: "miniflux",
    source: "economist",
    category_id: category.category_id,
    category_title: category.category_title,
    answer_text: `Started refreshing Economist feeds in Miniflux.`,
  };
}

async function economistCategory() {
  const configuredId = normalizeInteger(process.env.MINIFLUX_ECONOMIST_CATEGORY_ID);
  if (configuredId) {
    return {
      ok: true,
      category_id: configuredId,
      category_title: process.env.MINIFLUX_ECONOMIST_CATEGORY_TITLE || "Economist",
    };
  }

  const title = normalizeString(process.env.MINIFLUX_ECONOMIST_CATEGORY_TITLE, "Economist");
  const result = await minifluxRequest("/v1/categories");
  if (!result.ok) return result;

  const categories = Array.isArray(result.body) ? result.body : [];
  const match = categories.find(
    (category) => normalizeString(category.title).toLowerCase() === title.toLowerCase()
  );

  if (!match) {
    return {
      ok: false,
      status: "economist_category_not_found",
      message: `Could not find Miniflux category "${title}".`,
      categories: categories.map((category) => ({
        id: category.id,
        title: category.title,
      })),
      answer_text: `I could not find the Economist category in Miniflux.`,
    };
  }

  return {
    ok: true,
    category_id: match.id,
    category_title: match.title,
  };
}

async function minifluxRequest(path, { method = "GET", body, expectNoContent = false } = {}) {
  const apiToken = process.env.MINIFLUX_API_TOKEN;
  if (!apiToken) return notConfiguredResponse();

  const baseUrl = normalizeString(process.env.MINIFLUX_BASE_URL, DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-auth-token": apiToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (expectNoContent && response.status === 204) {
    return { ok: true, status: "ok", body: null };
  }

  const text = await response.text();
  const parsed = parseMaybeJson(text);
  if (!response.ok) {
    return {
      ok: false,
      status: "miniflux_request_failed",
      upstream_status: response.status,
      message: parsed?.error_message || parsed?.message || text || "Miniflux request failed.",
      answer_text: "The Miniflux RSS request failed.",
    };
  }

  return {
    ok: true,
    status: "ok",
    body: parsed,
  };
}

async function rssBridgeLatestFeed() {
  if (!economistRssBridgeConfigured()) {
    return {
      ok: false,
      status: "rss_bridge_not_configured",
      message:
        "ECONOMIST_RSS_BRIDGE_URL, ECONOMIST_RSS_BRIDGE_TOKEN, or ECONOMIST_PUBLIC_RSS_TOKEN is not configured.",
    };
  }

  const { url, headers: rssBridgeHeaders } = economistRssBridgeRequest();
  const timeoutMs = clampInteger(process.env.ECONOMIST_RSS_BRIDGE_TIMEOUT_MS, 2_000, 30_000, 12_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": "phoneclaw-economist-rss-bridge/1.0",
        ...rssBridgeHeaders,
      },
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        status: "rss_bridge_request_failed",
        upstream_status: response.status,
        message: text.slice(0, 500) || "RSS-Bridge request failed.",
      };
    }

    return {
      ok: true,
      status: "ok",
      url: redactedUrl(url),
      entries: parseAtomEntries(text),
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? "rss_bridge_timeout" : "rss_bridge_request_failed",
      message: error?.message || "RSS-Bridge request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function economistRssBridgeUrl() {
  const explicit = normalizeString(process.env.ECONOMIST_RSS_BRIDGE_URL);
  const rawUrl = explicit || DEFAULT_RSS_BRIDGE_URL;
  const url = new URL(rawUrl);
  return url;
}

function economistRssBridgeRequest() {
  const url = economistRssBridgeUrl();
  const token = normalizeString(
    process.env.ECONOMIST_RSS_BRIDGE_TOKEN || process.env.ECONOMIST_PUBLIC_RSS_TOKEN
  );
  const headers = {};
  if (token && !url.searchParams.has("token")) {
    headers.authorization = `Bearer ${token}`;
  }
  return { url, headers };
}

function parseAtomEntries(xml) {
  const entries = [...String(xml || "").matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  return entries.map((match) => {
    const block = match[0];
    const title = atomText(block, "title");
    const url = atomLink(block) || atomText(block, "id");
    const contentHtml = atomText(block, "content") || atomText(block, "summary");
    const fullText = normalizeArticleText(htmlToText(contentHtml, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
      ],
    }));
    const publishedAt = atomText(block, "published") || atomText(block, "updated");

    return {
      id: rssBridgeVirtualId({ title, url }),
      title,
      url,
      author: atomNestedText(block, "author", "name"),
      published_at: publishedAt,
      updated_at: atomText(block, "updated"),
      full_text: fullText,
      feed_title: "Economist RSS-Bridge",
    };
  });
}

function atomText(block, tagName) {
  const match = String(block || "").match(
    new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i")
  );
  if (!match) return "";
  return decodeXmlEntities(stripCdata(match[1])).trim();
}

function atomNestedText(block, outerTagName, innerTagName) {
  const match = String(block || "").match(
    new RegExp(`<${outerTagName}\\b[^>]*>([\\s\\S]*?)<\\/${outerTagName}>`, "i")
  );
  return match ? atomText(match[1], innerTagName) : "";
}

function atomLink(block) {
  const links = [...String(block || "").matchAll(/<link\b([^>]*)>/gi)];
  const alternate =
    links.find((match) => /rel=["']alternate["']/i.test(match[1])) || links[0];
  if (!alternate) return "";
  const href = alternate[1].match(/\bhref=["']([^"']+)["']/i);
  return href ? decodeXmlEntities(href[1]).trim() : "";
}

function stripCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function compactEntry(entry, { maxExcerptChars }) {
  const text = normalizeArticleText(htmlToText(entry.content || "", {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }));

  return {
    id: entry.id,
    title: entry.title || "",
    url: entry.url || "",
    author: entry.author || "",
    published_at: entry.published_at || "",
    created_at: entry.created_at || "",
    changed_at: entry.changed_at || "",
    status: entry.status || "",
    starred: Boolean(entry.starred),
    reading_time: entry.reading_time ?? null,
    feed_id: entry.feed_id || entry.feed?.id || null,
    feed_title: entry.feed?.title || "",
    feed_url: entry.feed?.feed_url || "",
    category_title: entry.feed?.category?.title || "",
    excerpt: truncateText(text, maxExcerptChars).value,
  };
}

function compactRssBridgeEntry(entry, { maxExcerptChars }) {
  return {
    id: entry.id || rssBridgeVirtualId(entry),
    title: entry.title || "",
    url: entry.url || "",
    author: entry.author || "",
    published_at: entry.published_at || entry.updated_at || "",
    created_at: "",
    changed_at: entry.updated_at || "",
    status: "",
    starred: false,
    reading_time: Math.max(1, Math.round(String(entry.full_text || "").split(/\s+/).length / 225)),
    feed_id: null,
    feed_title: entry.feed_title || "Economist RSS-Bridge",
    feed_url: redactedUrl(economistRssBridgeUrl()),
    category_title: "Economist",
    content_source: "economist_rss_bridge",
    full_text_available: normalizeArticleText(entry.full_text).length >= 700,
    excerpt: truncateText(normalizeArticleText(entry.full_text), maxExcerptChars).value,
  };
}

function mergeEntries(preferredEntries, fallbackEntries) {
  const seen = new Set();
  const merged = [];

  for (const entry of [...preferredEntries, ...fallbackEntries]) {
    const key = entryKey(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(entry);
  }

  return merged;
}

function entryKey(entry) {
  const urlKey = canonicalArticleUrl(entry?.url);
  if (urlKey) return `url:${urlKey}`;
  const title = normalizeString(entry?.title).toLowerCase();
  return title ? `title:${title}` : "";
}

function providerLabel(rssBridgeEntries) {
  return rssBridgeEntries.ok ? "RSS-Bridge and Miniflux" : "Miniflux";
}

function formatEntriesAnswer(entries, query, provider = "Miniflux") {
  if (entries.length === 0) {
    return query
      ? `${provider} found no Economist articles matching "${query}".`
      : `${provider} found no recent Economist articles.`;
  }

  const heading = query
    ? `${provider} found ${entries.length} Economist articles matching "${query}".`
    : `${provider} returned ${entries.length} recent Economist articles.`;
  const lines = entries.slice(0, 5).map((entry, index) => {
    const date = entry.published_at ? `, published ${entry.published_at.slice(0, 10)}` : "";
    return `${index + 1}. ${entry.title}${date}. Entry id ${entry.id}.`;
  });
  return [heading, ...lines].join("\n");
}

function accessNote(text, entry, {
  fetchStatus,
  fetchMessage,
  rssBridgeFetchStatus,
  rssBridgeFetchMessage,
  contentSource,
  browserFetchStatus,
  browserFetchMessage,
} = {}) {
  const normalized = text.toLowerCase();
  if (contentSource === "economist_rss_bridge" && text.length >= 700) {
    return "";
  }
  if (
    rssBridgeFetchStatus &&
    !["not_requested", "ok", "rss_bridge_not_configured", "rss_bridge_no_matching_entry"].includes(
      rssBridgeFetchStatus
    )
  ) {
    return rssBridgeFetchMessage
      ? `The RSS-Bridge full-text feed did not return article text: ${rssBridgeFetchMessage}`
      : "The RSS-Bridge full-text feed did not return article text.";
  }
  if (browserFetchStatus && !["not_requested", "ok"].includes(browserFetchStatus)) {
    return browserFetchMessage
      ? `The authenticated browser fallback did not return full article text: ${browserFetchMessage}`
      : "The authenticated browser fallback did not return full article text.";
  }
  if (fetchStatus && !["ok", "not_requested"].includes(fetchStatus)) {
    return fetchMessage
      ? `Miniflux could not fetch the original article: ${fetchMessage}. The returned text is from the RSS entry and may be only an excerpt.`
      : "Miniflux could not fetch the original article. The returned text is from the RSS entry and may be only an excerpt.";
  }
  if (text.length < 700) {
    return "The returned article text is short; it may be an RSS excerpt, not the full subscriber article.";
  }
  if (
    normalized.includes("subscribe") &&
    (normalized.includes("sign in") || normalized.includes("log in"))
  ) {
    return "The fetched article text appears to include subscription or login language; full subscriber access may need an authenticated Economist cookie/private feed.";
  }
  if (entry?.feed?.title) {
    return `Text came from ${entry.feed.title}.`;
  }
  return "";
}

function findRssBridgeEntry(entries, { entryId, articleUrl, title } = {}) {
  const normalizedId = normalizeInteger(entryId);
  if (isRssBridgeVirtualId(normalizedId)) {
    const byId = entries.find((entry) => Number(entry.id) === normalizedId);
    if (byId) return byId;
  }

  const requestedUrl = canonicalArticleUrl(articleUrl);
  if (requestedUrl) {
    const byUrl = entries.find((entry) => canonicalArticleUrl(entry.url) === requestedUrl);
    if (byUrl) return byUrl;
  }

  const requestedTitle = normalizeString(title).toLowerCase();
  if (requestedTitle) {
    return entries.find((entry) => normalizeString(entry.title).toLowerCase() === requestedTitle);
  }

  return null;
}

function rssBridgeVirtualId(entry) {
  const key = canonicalArticleUrl(entry?.url) || normalizeString(entry?.title).toLowerCase();
  return RSS_BRIDGE_VIRTUAL_ID_BASE + (hashString(key) % 90_000_000);
}

function isRssBridgeVirtualId(value) {
  return Number.isInteger(value) && value >= RSS_BRIDGE_VIRTUAL_ID_BASE;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function canonicalArticleUrl(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function redactedUrl(value) {
  try {
    const url = value instanceof URL ? new URL(value.toString()) : new URL(String(value));
    if (url.searchParams.has("token")) url.searchParams.set("token", "[redacted]");
    return url.toString();
  } catch {
    return String(value || "").replace(/token=[^&\s]+/g, "token=[redacted]");
  }
}

function normalizeArticleText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return { value: text, truncated: false };
  return {
    value: text.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

function notConfiguredResponse() {
  return {
    ok: false,
    status: "miniflux_not_configured",
    message: "MINIFLUX_API_TOKEN is not configured on the bridge.",
    answer_text: "Miniflux RSS access is not configured on the bridge yet.",
  };
}

function missingField(field, message) {
  return {
    ok: false,
    status: "missing_field",
    field,
    message,
    answer_text: message,
  };
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value).toLowerCase().replaceAll("-", "_");
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeInteger(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

function unixSeconds(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
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
