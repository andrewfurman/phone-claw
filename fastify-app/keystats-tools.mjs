// "Key stats" in one read-only call: Brent/WTI oil, Kalshi 2028 presidential odds and
// OpenRouter's leading LLMs by tokens and by share of spend. Ported from the family
// newspaper's dashboard gatherer so the voice agent answers with the same numbers the
// Daily Dad prints, without a chain of web searches. All sources are public and keyless.
// Each section fails on its own: one source down still returns the others.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const PRES_SERIES = "KXPRESPERSON";
const PRES_EVENT = "KXPRESPERSON-28"; // "2028 U.S. Presidential Election winner?" by person
const PARTY_SERIES = "KXPRESPARTY";
const PARTY_EVENT = "KXPRESPARTY-2028";
const OPENROUTER_RANKINGS = "https://openrouter.ai/api/frontend/v1/rankings/models?view=day";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const DAY = 86_400_000;

export const KEYSTATS_SECTIONS = ["oil", "odds", "llm"];
const ALIASES = {
  oil: "oil", brent: "oil", wti: "oil", crude: "oil", energy: "oil",
  odds: "odds", election: "odds", elections: "odds", president: "odds", presidential: "odds", kalshi: "odds", politics: "odds",
  llm: "llm", llms: "llm", ai: "llm", models: "llm", openrouter: "llm", tokens: "llm", spend: "llm",
};
const CACHE_MS = 5 * 60_000;
const cache = new Map();

export function resetKeyStatsCache() { cache.clear(); }

class SourceError extends Error {}

async function getJson(url, timeoutMs) {
  let response;
  try {
    response = await globalThis.fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (error) {
    throw new SourceError(error?.name === "TimeoutError" || error?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : "network error");
  }
  if (!response.ok) throw new SourceError(`HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new SourceError("invalid JSON"); }
}

const round = (value, digits = 0) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const pct = value => round(Number(value || 0) * 100, 1);
export function spokenDate(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
const signed = (value, unit = "") => `${value > 0 ? "up" : value < 0 ? "down" : "flat"}${value ? ` ${Math.abs(value)}${unit}` : ""}`;

// ---------- Oil ----------

async function cnbcBars(symbol, timeoutMs) {
  const data = await getJson(`https://ts-api.cnbc.com/harmony/app/charts/1Y.json?symbol=${encodeURIComponent(symbol)}`, timeoutMs);
  return (data?.barData?.priceBars || [])
    .filter(bar => bar?.close && bar.tradeTime)
    .map(bar => [`${bar.tradeTime.slice(0, 4)}-${bar.tradeTime.slice(4, 6)}-${bar.tradeTime.slice(6, 8)}`, round(Number(bar.close), 2)]);
}

async function yahooBars(symbol, timeoutMs) {
  const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`, timeoutMs);
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return (result?.timestamp || []).map((t, i) => [isoDay(t * 1000), closes[i]]).filter(([, c]) => c != null).map(([d, c]) => [d, round(Number(c), 2)]);
}

function closeOnOrBefore(bars, day) {
  for (let i = bars.length - 1; i >= 0; i -= 1) if (bars[i][0] <= day) return bars[i];
  return null;
}

export function summarizeOilSeries(bars, today) {
  if (bars.length < 25) throw new SourceError(`only ${bars.length} daily closes`);
  const [date, price] = bars.at(-1);
  const back = days => closeOnOrBefore(bars, isoDay(Date.parse(`${date}T00:00:00Z`) - days * DAY));
  const change = ref => ref ? { from: ref[1], date: ref[0], change_usd: round(price - ref[1], 2), change_pct: round((price / ref[1] - 1) * 100, 1) } : null;
  const recent3m = bars.filter(([d]) => d >= isoDay(Date.parse(`${date}T00:00:00Z`) - 91 * DAY)).map(([, c]) => c);
  const month = change(back(30));
  return {
    price_usd: price, as_of: date, intraday: date >= today,
    previous_close: bars.length > 1 ? { date: bars.at(-2)[0], price_usd: bars.at(-2)[1] } : null,
    change_1d: change(bars.at(-2)), change_1w: change(back(7)), change_1m: month, change_3m: change(back(91)),
    high_3m: Math.max(...recent3m), low_3m: Math.min(...recent3m),
    trend_1m: !month ? "unknown" : month.change_pct >= 2 ? "up" : month.change_pct <= -2 ? "down" : "flat",
    recent_closes: bars.slice(-5),
  };
}

async function oilInstrument(name, cnbc, yahoo, { timeoutMs, today }) {
  const failures = [];
  for (const [source, load] of [[`CNBC ${cnbc} front-month futures (daily bars)`, () => cnbcBars(cnbc, timeoutMs)], [`Yahoo Finance ${yahoo} front-month futures`, () => yahooBars(yahoo, timeoutMs)]]) {
    try { return { name, source, ...summarizeOilSeries(await load(), today) }; } catch (error) { failures.push(`${source.split(" ")[0]}: ${error instanceof SourceError ? error.message : "parse error"}`); }
  }
  throw new SourceError(`${name} unavailable (${failures.join("; ")})`);
}

async function oilSection(options) {
  const [brent, wti] = await Promise.allSettled([oilInstrument("Brent", "@LCO.1", "BZ=F", options), oilInstrument("WTI", "@CL.1", "CL=F", options)]);
  if (brent.status === "rejected") throw brent.reason;
  return { units: "USD per barrel", brent: brent.value, wti: wti.status === "fulfilled" ? wti.value : null, ...(wti.status === "rejected" ? { wti_error: wti.reason.message } : {}) };
}

function oilSpoken(oil) {
  const b = oil.brent;
  const when = b.intraday ? `trading ${spokenDate(b.as_of)}` : `at the ${spokenDate(b.as_of)} close`;
  const parts = [`Brent crude is about $${Math.round(b.price_usd)} a barrel ${when}`];
  const moves = [["week", b.change_1w], ["month", b.change_1m]].filter(([, c]) => c).map(([label, c]) => `${signed(Math.round(c.change_pct), "%")} over the past ${label}`);
  if (moves.length) parts[0] += `, ${moves.join(" and ")}`;
  parts[0] += `; three-month range $${Math.round(b.low_3m)} to $${Math.round(b.high_3m)}`;
  if (oil.wti) parts.push(`US WTI is about $${Math.round(oil.wti.price_usd)}`);
  return `${parts.join(". ")}. (Source: ${b.source.split(" ")[0]} front-month futures.)`;
}

// ---------- Kalshi odds ----------

async function kalshiMonthAgo(series, ticker, { timeoutMs, nowMs }) {
  const end = Math.floor(nowMs / 1000);
  const data = await getJson(`${KALSHI}/series/${series}/markets/${ticker}/candlesticks?start_ts=${end - 40 * 86400}&end_ts=${end}&period_interval=1440`, timeoutMs);
  const target = end - 30 * 86400;
  const candles = (data?.candlesticks || []).filter(c => c?.price?.close_dollars && c.end_period_ts <= target);
  const last = candles.at(-1);
  return last ? { date: isoDay(last.end_period_ts * 1000), pct: pct(last.price.close_dollars) } : null;
}

async function oddsSection({ timeoutMs, nowMs, top }) {
  const [people, parties] = await Promise.allSettled([
    getJson(`${KALSHI}/events/${PRES_EVENT}?with_nested_markets=true`, timeoutMs),
    getJson(`${KALSHI}/events/${PARTY_EVENT}?with_nested_markets=true`, timeoutMs),
  ]);
  if (people.status === "rejected") throw new SourceError(`Kalshi ${PRES_EVENT}: ${people.reason.message}`);
  const markets = (people.value?.event?.markets || []).filter(m => m.status === "active");
  if (!markets.length) throw new SourceError("Kalshi returned no active 2028 presidential markets");
  const rank = m => [pct(m.last_price_dollars), Number(m.yes_bid_dollars || 0) + Number(m.yes_ask_dollars || 0), Number(m.volume_fp || 0)];
  const leaders = [...markets].sort((a, b) => { const x = rank(a), y = rank(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; }).slice(0, top);
  const updated = markets.map(m => m.updated_time).filter(Boolean).sort().at(-1) || null;
  const monthAgo = await Promise.allSettled(leaders.map(m => kalshiMonthAgo(PRES_SERIES, m.ticker, { timeoutMs, nowMs })));
  const candidates = leaders.map((m, i) => {
    const now = pct(m.last_price_dollars);
    const prior = m.previous_price_dollars != null ? pct(m.previous_price_dollars) : null;
    const month = monthAgo[i].status === "fulfilled" ? monthAgo[i].value : null;
    return {
      name: m.yes_sub_title, party: String(m.subtitle || "").replace(/^[:\s]+|[:\s]+$/g, "") || null, ticker: m.ticker,
      chance_pct: now, bid_pct: m.yes_bid_dollars != null ? pct(m.yes_bid_dollars) : null, ask_pct: m.yes_ask_dollars != null ? pct(m.yes_ask_dollars) : null,
      change_1d_pts: prior == null ? null : round(now - prior, 1),
      ...(month ? { month_ago: month, change_1m_pts: round(now - month.pct, 1) } : {}),
    };
  });
  const out = { market: "Kalshi: 2028 U.S. Presidential Election winner (by person)", event: PRES_EVENT, market_updated: updated, candidates };
  if (parties.status === "fulfilled") {
    const party = {};
    for (const m of parties.value?.event?.markets || []) party[String(m.yes_sub_title || "").toLowerCase().startsWith("dem") ? "democratic" : "republican"] = pct(m.last_price_dollars);
    out.party = { market: `Kalshi ${PARTY_EVENT}: which party wins the 2028 presidency`, ...party };
  } else out.party_error = `Kalshi ${PARTY_EVENT}: ${parties.reason.message}`;
  return out;
}

function oddsSpoken(odds) {
  const names = odds.candidates.map(c => {
    const move = c.change_1m_pts != null && Math.abs(c.change_1m_pts) >= 1 ? ` (${signed(Math.round(c.change_1m_pts), " points")} in a month)` : "";
    const who = /^democrat/i.test(c.party || "") ? "Democrat " : /^republican/i.test(c.party || "") ? "Republican " : "";
    return `${who}${c.name} ${Math.round(c.chance_pct)}%${move}`;
  });
  let text = `On Kalshi, the 2028 presidential favorites are ${names.join("; ")}`;
  if (odds.party?.democratic != null && odds.party?.republican != null) text += `. By party, Democrats ${Math.round(odds.party.democratic)}% and Republicans ${Math.round(odds.party.republican)}% to win the White House`;
  return `${text}.`;
}

// ---------- OpenRouter LLM rankings ----------

export function splitModelName(name) {
  const clean = String(name).replace(/ \((batch|free|beta)\)/g, "");
  const at = clean.indexOf(": ");
  return at >= 0 ? { maker: clean.slice(0, at), model: clean.slice(at + 2) } : { maker: "maker not listed", model: clean };
}

async function llmSection({ timeoutMs, nowMs, top }) {
  const [rankings, models] = await Promise.allSettled([getJson(OPENROUTER_RANKINGS, timeoutMs), getJson(OPENROUTER_MODELS, timeoutMs)]);
  if (rankings.status === "rejected") throw new SourceError(`OpenRouter rankings: ${rankings.reason.message}`);
  const rows = rankings.value?.data || [];
  if (!rows.length) throw new SourceError("OpenRouter rankings returned no rows");
  const catalog = models.status === "fulfilled" ? models.value?.data || [] : [];
  const names = new Map();
  for (const m of catalog) {
    if (!names.has(m.canonical_slug || m.id)) names.set(m.canonical_slug || m.id, m.name);
    if (!names.has(m.id)) names.set(m.id, m.name);
  }
  const tokens = new Map(), spend = new Map();
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
  const days = [...new Set(rows.map(r => String(r.date).slice(0, 10)))].sort();
  for (const r of rows) {
    add(tokens, r.model_permaslug, (r.total_prompt_tokens || 0) + (r.total_completion_tokens || 0));
    add(spend, r.model_permaslug, r.total_usage || 0);
  }
  // Since Oct 2026 the rankings rows carry no dollars; metric=spend gives each model's share of spend.
  const share = ![...spend.values()].some(Boolean);
  let spendError = null;
  if (share) {
    spend.clear();
    try {
      for (const r of (await getJson(`${OPENROUTER_RANKINGS}&metric=spend`, timeoutMs))?.data || []) add(spend, r.model_permaslug, r.rankingMetricValue || 0);
    } catch (error) { spendError = `OpenRouter spend share: ${error.message}`; }
  }
  const describe = slug => {
    const { maker, model } = splitModelName(names.get(slug) || slug);
    return {
      model, maker: slug.startsWith("stealth/") ? "stealth" : maker, slug,
      tokens_trillions: round((tokens.get(slug) || 0) / 1e12, 2),
      ...(share ? { spend_share_pct: spend.size ? round((spend.get(slug) || 0) * 100, 1) : null } : { spend_usd: Math.round(spend.get(slug) || 0) }),
    };
  };
  const leaders = map => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([slug]) => describe(slug));
  const weekAgo = (nowMs - 7 * DAY) / 1000;
  const newModels = [];
  for (const m of [...catalog].sort((a, b) => b.created - a.created)) {
    if (m.created < weekAgo || newModels.length >= 5) break;
    const { maker, model } = splitModelName(m.name);
    if (String(m.id).includes(":") || String(m.name).includes("(free)") || newModels.some(x => x.model === model)) continue;
    newModels.push({ model, maker, added: isoDay(m.created * 1000) });
  }
  const total = [...tokens.values()].reduce((a, b) => a + b, 0);
  return {
    source: "OpenRouter public rankings (latest full day)", day: days.at(-1), window: [days[0], days.at(-1)],
    total_tokens_trillions: round(total / 1e12, 1),
    ...(share ? {} : { total_spend_usd: Math.round([...spend.values()].reduce((a, b) => a + b, 0)) }),
    by_tokens: leaders(tokens), by_spend: spend.size ? leaders(spend) : [], spend_metric: share ? "share of spend (%)" : "USD",
    new_models_7d: newModels,
    ...(spendError ? { spend_error: spendError } : {}),
    ...(models.status === "rejected" ? { names_error: `OpenRouter model list: ${models.reason.message}; showing slugs` } : {}),
  };
}

function trillions(value) { return value >= 1 ? `${round(value, 1)} trillion` : `${Math.round(value * 1000)} billion`; }

function llmSpoken(llm) {
  const label = x => `${x.model} from ${x.maker}`;
  const parts = [`On OpenRouter for ${spokenDate(llm.day)}, the top models by tokens were ${llm.by_tokens.slice(0, 3).map(x => `${label(x)} (${trillions(x.tokens_trillions)})`).join(", ")}`];
  if (llm.by_spend.length) {
    const spendText = x => x.spend_share_pct != null ? `${Math.round(x.spend_share_pct)}%` : `$${Math.round(x.spend_usd).toLocaleString("en-US")}`;
    parts.push(`By ${llm.spend_metric === "USD" ? "spend" : "share of spend"}, the leaders were ${llm.by_spend.slice(0, 3).map(x => `${label(x)} (${spendText(x)})`).join(", ")}`);
  }
  parts.push(`About ${trillions(llm.total_tokens_trillions)} tokens in total that day`);
  return `${parts.join(". ")}.`;
}

// ---------- Entry point ----------

export function parseSections(only) {
  if (only == null || only === "" || (Array.isArray(only) && !only.length)) return { sections: [...KEYSTATS_SECTIONS] };
  const items = Array.isArray(only) ? only : String(only).split(/[,\s]+/);
  const sections = [], unknown = [];
  for (const item of items) {
    const key = ALIASES[String(item).trim().toLowerCase()];
    if (key) { if (!sections.includes(key)) sections.push(key); } else if (String(item).trim()) unknown.push(String(item));
  }
  return { sections, unknown };
}

const SECTION_RUNNERS = { oil: oilSection, odds: oddsSection, llm: llmSection };
const SPOKEN = { oil: oilSpoken, odds: oddsSpoken, llm: llmSpoken };

export async function keyStats({ only, top, fresh = false, timeoutMs, now = Date.now() } = {}) {
  const { sections, unknown = [] } = parseSections(only);
  if (!sections.length || unknown.length) {
    return { ok: false, status: "invalid_arguments", answer_text: `Unknown key stats section${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ") || "(none)"}. Use only: oil, odds, llm.` };
  }
  const deadline = Math.min(Math.max(Number(timeoutMs) || 20_000, 3_000), 55_000);
  const requestTimeout = Math.min(10_000, deadline);
  const limit = Math.min(Math.max(Math.trunc(Number(top)) || 3, 1), 10);
  const options = { timeoutMs: requestTimeout, nowMs: now, today: isoDay(now), top: limit };
  const result = { ok: true, status: "ok", as_of: new Date(now).toISOString(), sections };
  const errors = {};
  await Promise.all(sections.map(async section => {
    const key = `${section}:${section === "oil" ? "" : limit}`;
    const hit = cache.get(key);
    if (!fresh && hit && now - hit.at < CACHE_MS) { result[section] = { ...hit.value, fetched_at: new Date(hit.at).toISOString(), cached: true }; return; }
    let timer;
    try {
      const value = await Promise.race([
        SECTION_RUNNERS[section](options),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new SourceError(`timed out after ${deadline} ms`)), deadline); }),
      ]);
      cache.set(key, { at: now, value });
      result[section] = { ...value, fetched_at: new Date(now).toISOString() };
    } catch (error) {
      errors[section] = error instanceof SourceError ? error.message : "unexpected response format";
    } finally { clearTimeout(timer); }
  }));
  const sentences = sections.filter(s => result[s]).map(s => SPOKEN[s](result[s]));
  const failed = sections.filter(s => errors[s]);
  const label = { oil: "oil prices", odds: "election odds", llm: "OpenRouter model rankings" };
  if (failed.length) {
    result.errors = errors;
    sentences.push(`I couldn't get ${failed.map(s => label[s]).join(" or ")} right now.`);
  }
  if (failed.length === sections.length) { result.ok = false; result.status = "keystats_unavailable"; }
  else if (failed.length) result.status = "partial";
  result.answer_text = sentences.join(" ");
  return result;
}
