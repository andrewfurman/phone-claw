import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { keyStats, parseSections, resetKeyStatsCache, splitModelName } from "../fastify-app/keystats-tools.mjs";
import { runUniversalCli } from "../fastify-app/universal-cli.mjs";
import { CLI_COMMAND_CATALOG } from "../shared/cli-command-catalog.mjs";

// All network is mocked: synthetic CNBC, Kalshi and OpenRouter payloads.
const originalFetch = globalThis.fetch;
const NOW = Date.parse("2026-11-14T12:00:00Z");
afterEach(() => { globalThis.fetch = originalFetch; resetKeyStatsCache(); });

function bars(start, count, firstPrice, step) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    out.push({ close: String(firstPrice + i * step), tradeTime: `${d}000000` });
  }
  return { barData: { priceBars: out } };
}
const market = (ticker, name, party, price, previous) => ({ ticker, yes_sub_title: name, subtitle: `:: ${party}`, status: "active", last_price_dollars: price, previous_price_dollars: previous, yes_bid_dollars: price, yes_ask_dollars: price, volume_fp: "100", updated_time: "2026-11-13T20:00:00Z" });
const FIXTURES = {
  "ts-api.cnbc.com": url => url.includes("LCO") ? bars("2026-08-01", 105, 80, 0.15) : bars("2026-08-01", 105, 75, 0.1),
  "/events/KXPRESPERSON-28": () => ({ event: { markets: [
    market("P-A", "Alex Example", "Democratic", "0.2000", "0.1900"),
    market("P-B", "Blair Sample", "Republican", "0.1500", "0.1500"),
    market("P-C", "Casey Fixture", "Democratic", "0.0900", "0.1000"),
    market("P-D", "Dana Placeholder", "Republican", "0.0300", "0.0300"),
    { ...market("P-E", "Settled Person", "Democratic", "0.9900", "0.9900"), status: "settled" },
  ] } }),
  "/events/KXPRESPARTY-2028": () => ({ event: { markets: [market("D", "Democratic party", "", "0.6000", "0.6000"), market("R", "Republican party", "", "0.4100", "0.4100")] } }),
  "/candlesticks": () => ({ candlesticks: [{ end_period_ts: Math.floor(NOW / 1000) - 31 * 86400, price: { close_dollars: "0.1200" } }] }),
  "metric=spend": () => ({ data: [
    { model_permaslug: "anthropic/model-big", rankingMetricValue: 0.3 },
    { model_permaslug: "cheap/model-fast", rankingMetricValue: 0.05 },
  ] }),
  "/rankings/models": () => ({ data: [
    { date: "2026-11-13 00:00:00", model_permaslug: "cheap/model-fast", total_prompt_tokens: 9e12, total_completion_tokens: 1e12 },
    { date: "2026-11-13 00:00:00", model_permaslug: "cheap/model-fast", total_prompt_tokens: 5e11, total_completion_tokens: 0 },
    { date: "2026-11-13 00:00:00", model_permaslug: "anthropic/model-big", total_prompt_tokens: 1e12, total_completion_tokens: 2e11 },
  ] }),
  "/api/v1/models": () => ({ data: [
    { id: "cheap/model-fast", canonical_slug: "cheap/model-fast", name: "Cheapco: Model Fast", created: NOW / 1000 - 30 * 86400 },
    { id: "anthropic/model-big", canonical_slug: "anthropic/model-big", name: "Anthropic: Model Big", created: NOW / 1000 - 2 * 86400 },
  ] }),
};
function mockFetch({ fail = [], log = [] } = {}) {
  globalThis.fetch = async (url, options) => {
    log.push({ url: String(url), signal: options?.signal });
    if (fail.some(part => String(url).includes(part))) return { ok: false, status: 503, json: async () => ({}) };
    // Most specific keys first ("metric=spend" before "/rankings/models").
    const key = Object.keys(FIXTURES).find(part => String(url).includes(part));
    if (!key) throw new Error(`unexpected URL ${url}`);
    return { ok: true, status: 200, json: async () => FIXTURES[key](String(url)) };
  };
  return log;
}

test("returns oil, odds and LLM sections with sources, as-of dates and a spoken summary", async () => {
  const log = mockFetch();
  const r = await keyStats({ now: NOW });
  assert.equal(r.ok, true);assert.equal(r.status, "ok");assert.deepEqual(r.sections, ["oil", "odds", "llm"]);
  assert.equal(r.oil.brent.as_of, "2026-11-13");assert.equal(r.oil.brent.price_usd, 95.6);
  assert.match(r.oil.brent.source, /CNBC @LCO\.1/);assert.equal(r.oil.brent.trend_1m, "up");
  assert.equal(r.oil.wti.price_usd, 85.4);
  assert.deepEqual(r.odds.candidates.map(c => c.name), ["Alex Example", "Blair Sample", "Casey Fixture"]);
  assert.equal(r.odds.candidates[0].chance_pct, 20);assert.equal(r.odds.candidates[0].change_1d_pts, 1);assert.equal(r.odds.candidates[0].change_1m_pts, 8);
  assert.deepEqual(r.odds.party, { market: r.odds.party.market, democratic: 60, republican: 41 });
  assert.equal(r.llm.day, "2026-11-13");
  assert.deepEqual(r.llm.by_tokens.map(x => [x.model, x.maker, x.tokens_trillions]), [["Model Fast", "Cheapco", 10.5], ["Model Big", "Anthropic", 1.2]]);
  assert.deepEqual(r.llm.by_spend.map(x => [x.model, x.spend_share_pct]), [["Model Big", 30], ["Model Fast", 5]]);
  assert.deepEqual(r.llm.new_models_7d.map(x => x.model), ["Model Big"]);
  assert.match(r.answer_text, /Brent crude is about \$96 a barrel at the Fri, Nov 13 close/);
  assert.match(r.answer_text, /Democrat Alex Example 20%/);assert.match(r.answer_text, /Democrats 60% and Republicans 41%/);
  assert.match(r.answer_text, /Model Big from Anthropic \(30%\)/);
  assert.ok(log.every(x => x.signal), "every request carries a timeout signal");
  assert.ok(JSON.stringify(r).length < 12_000, "compact enough for the voice result budget");
});

test("each section fails independently with an error note", async () => {
  mockFetch({ fail: ["api.elections.kalshi.com"] });
  const r = await keyStats({ now: NOW });
  assert.equal(r.ok, true);assert.equal(r.status, "partial");
  assert.ok(r.oil && r.llm);assert.equal(r.odds, undefined);
  assert.match(r.errors.odds, /HTTP 503/);assert.match(r.answer_text, /couldn't get election odds/);
});

test("oil falls back to Yahoo when CNBC is down, and everything down is not ok", async () => {
  const yahoo = { chart: { result: [{ timestamp: Array.from({ length: 60 }, (_, i) => NOW / 1000 - (60 - i) * 86400), indicators: { quote: [{ close: Array.from({ length: 60 }, (_, i) => 70 + i * 0.1) }] } }] } };
  FIXTURES["query1.finance.yahoo.com"] = () => yahoo;
  try {
    mockFetch({ fail: ["ts-api.cnbc.com"] });
    const r = await keyStats({ only: ["oil"], now: NOW });
    assert.equal(r.ok, true);assert.match(r.oil.brent.source, /Yahoo/);assert.deepEqual(r.sections, ["oil"]);
    resetKeyStatsCache();
    mockFetch({ fail: ["cnbc", "yahoo", "kalshi", "openrouter"] });
    const down = await keyStats({ now: NOW });
    assert.equal(down.ok, false);assert.equal(down.status, "keystats_unavailable");
    assert.deepEqual(Object.keys(down.errors).sort(), ["llm", "odds", "oil"]);
  } finally { delete FIXTURES["query1.finance.yahoo.com"]; }
});

test("slow sources hit the section deadline instead of hanging the call", async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
  const started = Date.now();
  const r = await keyStats({ only: "llm", timeoutMs: 3000, now: NOW });
  assert.equal(r.ok, false);assert.match(r.errors.llm, /timed out/);
  assert.ok(Date.now() - started < 6000);
});

test("section selection accepts aliases and rejects unknown names", async () => {
  assert.deepEqual(parseSections("brent, president").sections, ["oil", "odds"]);
  assert.deepEqual(parseSections(["AI", "tokens"]).sections, ["llm"]);
  assert.deepEqual(parseSections(undefined).sections, ["oil", "odds", "llm"]);
  const bad = await keyStats({ only: ["weather"] });
  assert.equal(bad.ok, false);assert.equal(bad.status, "invalid_arguments");
  assert.deepEqual(splitModelName("OpenAI: GPT Fixture (free)"), { maker: "OpenAI", model: "GPT Fixture" });
});

test("results are cached for five minutes unless fresh is requested", async () => {
  const log = mockFetch();
  await keyStats({ only: "odds", now: NOW });
  const calls = log.length;
  const cached = await keyStats({ only: "odds", now: NOW + 60_000 });
  assert.equal(log.length, calls);assert.equal(cached.odds.cached, true);
  await keyStats({ only: "odds", now: NOW + 60_000, fresh: true });
  assert.ok(log.length > calls);
});

test("universal CLI exposes keystats as a read-only phoneclaw command and a bare alias", async () => {
  assert.ok(CLI_COMMAND_CATALOG.some(x => x.command === "keystats get" && x.parameters.includes("only")));
  mockFetch();
  for (const args of [["keystats", "get", "--json", '{"only":["llm"]}'], ["keystats", "--json", '{"only":"llm"}']]) {
    const r = await runUniversalCli({ command: "phoneclaw", args });
    assert.equal(r.ok, true, JSON.stringify(r));assert.equal(r.status, "ok");
    assert.equal(r.data.llm.by_tokens[0].model, "Model Fast");assert.match(r.answer_text, /OpenRouter/);
  }
  const help = await runUniversalCli({ command: "phoneclaw", args: ["keystats", "--help"] });
  assert.equal(help.data.command, "keystats get");
});
