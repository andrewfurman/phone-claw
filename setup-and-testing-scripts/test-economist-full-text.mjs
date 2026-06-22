const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const entryId = process.argv[2] || process.env.ECONOMIST_TEST_ENTRY_ID;

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const targetEntryId = entryId || (await latestEntryId());
const article = await workerJson("/cli/rss/economist/article-text", {
  entry_id: targetEntryId,
  fetch_original: true,
  update_content: true,
  max_text_chars: 12_000,
});

const fullArticleAvailable =
  article.ok === true &&
  [
    "economist_rss_bridge",
    "economist_browser_fetch",
    "original_article_fetch",
    "stored_entry_content",
  ].includes(article.content_source) &&
  Number(article.full_text_chars || 0) >= 700 &&
  !article.access_note;

console.log(
  JSON.stringify(
    {
      ok: article.ok === true,
      full_article_available: fullArticleAvailable,
      entry_id: article.entry_id,
      title: article.entry?.title || article.title || "",
      content_source: article.content_source,
      original_fetch_status: article.original_fetch_status,
      original_fetch_message: article.original_fetch_message,
      rss_bridge_fetch_status: article.rss_bridge_fetch_status,
      rss_bridge_fetch_message: article.rss_bridge_fetch_message,
      browser_fetch_status: article.browser_fetch_status,
      browser_fetch_message: article.browser_fetch_message,
      full_text_chars: article.full_text_chars,
      returned_text_chars: article.returned_text_chars,
      access_note: article.access_note,
      text_preview: String(article.full_text || "").slice(0, 400),
    },
    null,
    2
  )
);

process.exit(fullArticleAvailable ? 0 : 2);

async function latestEntryId() {
  const recent = await workerJson("/cli/rss/economist/recent", {
    limit: 1,
    max_excerpt_chars: 120,
  });
  const id = recent.items?.[0]?.id;
  if (!id) throw new Error("Could not find a recent Economist entry id.");
  return id;
}

async function workerJson(pathname, body) {
  const response = await fetch(`${workerBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`Worker request failed (${response.status}): ${text}`);
  }

  return parsed;
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
