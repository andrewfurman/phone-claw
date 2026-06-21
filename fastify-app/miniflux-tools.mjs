import { htmlToText } from "html-to-text";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_MAX_TEXT_CHARS = 30_000;
const MAX_TEXT_CHARS = 120_000;

export function minifluxConfigured() {
  return Boolean(process.env.MINIFLUX_API_TOKEN);
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
  if (!minifluxConfigured()) return notConfiguredResponse();

  const category = await economistCategory();
  if (!category.ok) return category;

  const params = new URLSearchParams();
  params.set("limit", String(clampInteger(limit, 1, MAX_LIMIT, DEFAULT_LIMIT)));
  params.set("order", "published_at");
  params.set("direction", "desc");
  if (category.category_id) params.set("category_id", String(category.category_id));

  const normalizedStatus = normalizeEnum(status, ["all", "read", "unread"], "all");
  if (normalizedStatus !== "all") params.append("status", normalizedStatus);

  const normalizedQuery = normalizeString(query);
  if (normalizedQuery) params.set("search", normalizedQuery);

  const after = unixSeconds(startDate);
  const before = unixSeconds(endDate);
  if (after) params.set("published_after", String(after));
  if (before) params.set("published_before", String(before));

  const result = await minifluxRequest(`/v1/entries?${params.toString()}`);
  if (!result.ok) return result;

  const entries = Array.isArray(result.body?.entries)
    ? result.body.entries.map((entry) =>
        compactEntry(entry, { maxExcerptChars: clampInteger(maxExcerptChars, 80, 1_200, 320) })
      )
    : [];

  return {
    ok: true,
    status: "ok",
    provider: "miniflux",
    source: "economist",
    query: normalizedQuery,
    start_date: startDate || "",
    end_date: endDate || "",
    returned_count: entries.length,
    total_count: Number.isFinite(result.body?.total) ? result.body.total : null,
    category_id: category.category_id || null,
    category_title: category.category_title || "",
    items: entries,
    answer_text: formatEntriesAnswer(entries, normalizedQuery),
  };
}

export async function rssEntryFullText({
  entryId,
  id,
  fetchOriginal = true,
  updateContent = true,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
} = {}) {
  if (!minifluxConfigured()) return notConfiguredResponse();

  const normalizedId = normalizeInteger(entryId || id);
  if (!normalizedId) {
    return missingField("entry_id", "A Miniflux entry id is required.");
  }

  const entryResult = await minifluxRequest(`/v1/entries/${normalizedId}`);
  if (!entryResult.ok) return entryResult;

  const entry = entryResult.body || {};
  let contentHtml = normalizeString(entry.content);
  let contentSource = "stored_entry_content";
  let fetchStatus = "not_requested";
  let fetchMessage = "";

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

  const contentText = normalizeArticleText(htmlToText(contentHtml || "", {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }));
  const boundedMax = clampInteger(maxTextChars, 2_000, MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);
  const truncated = truncateText(contentText, boundedMax);
  const compact = compactEntry(entry, { maxExcerptChars: 420 });

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
    full_text_chars: contentText.length,
    returned_text_chars: truncated.value.length,
    full_text_truncated: truncated.truncated,
    full_text: truncated.value,
    access_note: accessNote(contentText, entry, { fetchStatus, fetchMessage }),
    answer_text: `Retrieved article text for "${compact.title}". ${truncated.truncated ? "The returned text is truncated." : "The returned text is complete within the configured limit."}`,
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

function formatEntriesAnswer(entries, query) {
  if (entries.length === 0) {
    return query
      ? `Miniflux found no Economist articles matching "${query}".`
      : "Miniflux found no recent Economist articles.";
  }

  const heading = query
    ? `Miniflux found ${entries.length} Economist articles matching "${query}".`
    : `Miniflux returned ${entries.length} recent Economist articles.`;
  const lines = entries.slice(0, 5).map((entry, index) => {
    const date = entry.published_at ? `, published ${entry.published_at.slice(0, 10)}` : "";
    return `${index + 1}. ${entry.title}${date}. Entry id ${entry.id}.`;
  });
  return [heading, ...lines].join("\n");
}

function accessNote(text, entry, { fetchStatus, fetchMessage } = {}) {
  const normalized = text.toLowerCase();
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
