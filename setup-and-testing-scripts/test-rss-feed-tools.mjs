import assert from "node:assert/strict";
import http from "node:http";
import { rssConfiguredRecentEntries } from "../fastify-app/rss-feed-tools.mjs";

function buildEconomistStyleFeedXml(articles) {
  const items = articles
    .map((article) => {
      const link = article.omitLink
        ? ""
        : `    <link>https://feeds.example.test/article.txt?url=${encodeURIComponent(article.canonicalUrl)}&amp;key=test</link>\n`;
      return `  <item>
    <title>${article.title}</title>
${link}    <guid isPermaLink="false">${article.guid}</guid>
    <pubDate>${article.pubDate}</pubDate>
    <description>${article.title} summary</description>
  </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Economist fixture</title>
    <link>https://feeds.example.test/</link>
    <description>Fixture feed with article.txt wrapper links</description>
${items}
  </channel>
</rss>
`;
}

const articles = [
  {
    title: "World in Brief",
    guid: "wib-1",
    canonicalUrl: "https://www.economist.com/the-world-in-brief/2026/09/19/brief",
    pubDate: "Fri, 19 Sep 2026 12:00:00 GMT",
    omitLink: true,
  },
  {
    title: "Leaders A",
    guid: "uuid-a",
    canonicalUrl: "https://www.economist.com/leaders/2026/09/18/a",
    pubDate: "Thu, 18 Sep 2026 12:00:00 GMT",
  },
  {
    title: "Leaders B",
    guid: "uuid-b",
    canonicalUrl: "https://www.economist.com/leaders/2026/09/18/b",
    pubDate: "Thu, 18 Sep 2026 11:00:00 GMT",
  },
  {
    title: "Finance C",
    guid: "uuid-c",
    canonicalUrl: "https://www.economist.com/finance/2026/09/17/c",
    pubDate: "Wed, 17 Sep 2026 12:00:00 GMT",
  },
];

const xml = buildEconomistStyleFeedXml(articles);

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/rss.xml")) {
    res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
    res.end(xml);
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const feedUrl = `http://127.0.0.1:${port}/rss.xml`;

process.env.RSS_FEEDS_JSON = JSON.stringify([
  {
    id: "economist",
    title: "The Economist",
    url: feedUrl,
    private: true,
    cache_seconds: 1,
  },
]);
delete process.env.RSS_FEEDS_CONFIG_PATH;

const result = await rssConfiguredRecentEntries({
  feedId: "economist",
  refresh: true,
  limit: 50,
});

server.close();

assert.equal(result.ok, true, `expected ok response, got ${result.status}`);
assert.equal(result.feeds?.[0]?.item_count, articles.length, "parser should see every item");
assert.equal(
  result.returned_count,
  articles.length,
  `dedupe must not collapse article.txt wrappers; got ${result.returned_count}`
);
assert.equal(result.available_count, articles.length);
assert.equal(result.has_more, false);

const titles = result.items.map((item) => item.title).sort();
assert.deepEqual(
  titles,
  articles.map((article) => article.title).sort(),
  "all article titles should remain after dedupe"
);

const ids = new Set(result.items.map((item) => item.id));
assert.equal(ids.size, articles.length, "entry ids must be unique across wrapper links");

const wrapped = result.items.find((item) => item.title === "Leaders A");
assert.match(String(wrapped.url), /\/article\.txt\?/, "fetchable wrapper link should be preserved");
assert.equal(wrapped.guid, "uuid-a");

console.log(
  JSON.stringify(
    {
      ok: true,
      item_count: result.feeds[0].item_count,
      returned_count: result.returned_count,
      available_count: result.available_count,
    },
    null,
    2
  )
);
