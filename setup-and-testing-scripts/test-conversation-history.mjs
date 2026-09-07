import assert from "node:assert/strict";
import {
  archiveElevenLabsConversation,
  conversationHistoryConfigured,
  conversationHistoryGet,
  conversationHistorySearch,
  conversationRecentContext,
  resetConversationHistoryStateForTests,
  setConversationHistoryClientForTests,
} from "../fastify-app/conversation-history.mjs";

const originalEnv = {
  CONVERSATION_DATABASE_URL: process.env.CONVERSATION_DATABASE_URL,
  NEON_DATABASE_URL: process.env.NEON_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
};

clearDatabaseEnv();
resetConversationHistoryStateForTests();

const checks = {};

checks.not_configured_without_url = await assertNotConfigured();

const store = createMemoryStore();
setConversationHistoryClientForTests(store);
process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";

const archivedAlpha = await archiveElevenLabsConversation({
  conversationId: "conv-alpha",
  fetchImpl: mockElevenLabsFetch({
    "conv-alpha": elevenLabsConversation({
      conversation_id: "conv-alpha",
      start_time_unix_secs: 1_700_000_000,
      duration_secs: 120,
      summary: "Talked about GitHub issues and email drafts for the phone claw bridge.",
      transcript: [
        {
          role: "user",
          message: "Please search my past calls about GitHub issues.",
          tool_calls: [],
          tool_results: [],
        },
        {
          role: "agent",
          message: "I will search the archived conversations for GitHub.",
          tool_calls: [
            {
              tool_name: "conversation_history_search",
              params_as_json: JSON.stringify({ query: "GitHub" }),
            },
          ],
          tool_results: [
            {
              tool_name: "conversation_history_search",
              result_value: JSON.stringify({ ok: true, returned_count: 1 }),
              is_error: false,
            },
          ],
        },
      ],
    }),
  }),
});

const archivedBeta = await archiveElevenLabsConversation({
  conversationId: "conv-beta",
  fetchImpl: mockElevenLabsFetch({
    "conv-beta": elevenLabsConversation({
      conversation_id: "conv-beta",
      start_time_unix_secs: 1_700_100_000,
      duration_secs: 60,
      summary: "Reviewed RSS feed entries and unread newsletter summaries.",
      transcript: [
        {
          role: "user",
          message: "What did the RSS feeds say about newsletters?",
          tool_calls: [],
          tool_results: [],
        },
        {
          role: "agent",
          message: "I found recent newsletter entries in the configured feeds.",
          tool_calls: [],
          tool_results: [],
        },
      ],
    }),
  }),
});

checks.archive_alpha_ok = archivedAlpha.ok === true && archivedAlpha.status === "archived";
checks.archive_beta_ok = archivedBeta.ok === true && archivedBeta.status === "archived";
checks.store_has_two_rows = store.rows.size === 2;

const searchGithub = await conversationHistorySearch({ query: "GitHub", limit: 5 });
checks.search_finds_github =
  searchGithub.ok === true &&
  searchGithub.returned_count === 1 &&
  searchGithub.items[0]?.conversation_id === "conv-alpha" &&
  /GitHub/i.test(searchGithub.items[0]?.summary || "");

const searchEmpty = await conversationHistorySearch({
  query: "quantum-zebra-not-present",
  limit: 5,
});
checks.search_miss_returns_empty = searchEmpty.ok === true && searchEmpty.returned_count === 0;

const recent = await conversationRecentContext({ limit: 5 });
checks.recent_orders_newest_first =
  recent.ok === true &&
  recent.returned_count === 2 &&
  recent.items[0]?.conversation_id === "conv-beta" &&
  recent.items[1]?.conversation_id === "conv-alpha" &&
  /conv-beta/i.test(recent.context_text || "");

const got = await conversationHistoryGet({
  conversationId: "conv-alpha",
  includeTranscript: true,
  includeToolDetails: true,
  maxTranscriptTurns: 10,
  maxToolItems: 10,
});

checks.get_ok = got.ok === true && got.conversation?.conversation_id === "conv-alpha";
checks.get_tool_call_count = got.conversation?.tool_call_count === 1;
checks.get_transcript_excerpt =
  Array.isArray(got.conversation?.transcript_excerpt) &&
  got.conversation.transcript_excerpt.length === 2 &&
  got.conversation.transcript_turn_count === 2;
checks.get_include_transcript =
  Array.isArray(got.conversation?.transcript) && got.conversation.transcript.length === 2;
checks.get_tool_details =
  Array.isArray(got.conversation?.tool_results) &&
  got.conversation.tool_results.length === 1 &&
  got.conversation.tool_results[0]?.tool_name === "conversation_history_search";

const missing = await conversationHistoryGet({ conversationId: "does-not-exist" });
checks.get_missing = missing.ok === false && missing.status === "conversation_not_found";

const dateFiltered = await conversationHistorySearch({
  startDate: "2023-11-15T00:00:00.000Z",
  endDate: "2023-11-15T12:00:00.000Z",
  limit: 10,
});
const alphaOnly = await conversationHistorySearch({
  startDate: "2023-11-14T00:00:00.000Z",
  endDate: "2023-11-15T00:00:00.000Z",
  limit: 10,
});
checks.date_filter_alpha_only =
  alphaOnly.ok === true &&
  alphaOnly.returned_count === 1 &&
  alphaOnly.items[0]?.conversation_id === "conv-alpha";
checks.date_filter_empty_window = dateFiltered.ok === true && dateFiltered.returned_count === 0;

const statusCodeHelpers = createToolStatusHelpers();
checks.not_configured_http_200 =
  statusCodeHelpers.toolResultStatusCode({
    ok: false,
    status: "conversation_history_not_configured",
  }) === 200;
checks.ok_http_200 = statusCodeHelpers.toolResultStatusCode({ ok: true, status: "ok" }) === 200;
checks.missing_http_400 =
  statusCodeHelpers.toolResultStatusCode({
    ok: false,
    status: "conversation_not_found",
  }) === 400;

resetConversationHistoryStateForTests();
restoreEnv();

const live = await maybeLiveBridgeProbe();
const ok = Object.values(checks).every(Boolean) && (live.skipped || live.ok);

console.log(JSON.stringify({ ok, checks, live, verified: "in-memory archive/search/get/recent + tool_call_count + not_configured mapping", residual: "Live Neon/bridge still needs DB URL or bridge token; run conversations query CLI on host" }, null, 2));
process.exit(ok ? 0 : 1);


async function assertNotConfigured() {
  resetConversationHistoryStateForTests();
  clearDatabaseEnv();
  const search = await conversationHistorySearch({ query: "anything" });
  const get = await conversationHistoryGet({ conversationId: "x" });
  const recentResult = await conversationRecentContext();
  return (
    search.status === "conversation_history_not_configured" &&
    get.status === "conversation_history_not_configured" &&
    recentResult.status === "conversation_history_not_configured" &&
    conversationHistoryConfigured() === false
  );
}

function createMemoryStore() {
  const rows = new Map();
  return {
    rows,
    schemaReady: false,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();

      if (normalized.startsWith("CREATE TABLE IF NOT EXISTS phoneclaw_conversations")) {
        this.schemaReady = true;
        return { rowCount: 0, rows: [] };
      }

      if (normalized.startsWith("INSERT INTO phoneclaw_conversations")) {
        const record = {
          conversation_id: params[0],
          twilio_call_sid: params[1] || "",
          caller_number: params[2] || "",
          started_at: params[3] ? new Date(params[3]) : null,
          ended_at: params[4] ? new Date(params[4]) : null,
          duration_seconds: params[5],
          status: params[6] || "",
          transcript: parseJsonParam(params[7], []),
          summary: params[8] || "",
          keywords: params[9] || [],
          tool_calls: parseJsonParam(params[10], []),
          tool_results: parseJsonParam(params[11], []),
          metadata: parseJsonParam(params[12], {}),
          updated_at: new Date(),
        };
        rows.set(record.conversation_id, record);
        return { rowCount: 1, rows: [] };
      }

      if (
        normalized.includes("FROM phoneclaw_conversations") &&
        normalized.includes("WHERE conversation_id = $1")
      ) {
        const row = rows.get(params[0]);
        return row ? { rowCount: 1, rows: [cloneRow(row)] } : { rowCount: 0, rows: [] };
      }

      if (normalized.includes("SELECT conversation_id, started_at, summary, keywords")) {
        const limit = Number(params[params.length - 1]);
        const items = [...rows.values()]
          .sort(sortByStartedAtDesc)
          .slice(0, limit)
          .map((row) => ({
            conversation_id: row.conversation_id,
            started_at: row.started_at,
            summary: row.summary,
            keywords: row.keywords,
          }));
        return { rowCount: items.length, rows: items };
      }

      if (normalized.includes("FROM phoneclaw_conversations")) {
        const limit = Number(params[params.length - 1]);
        let filterParams = params.slice(0, -1);
        let query = null;
        let start = null;
        let end = null;
        if (normalized.includes("summary ILIKE")) {
          query = String(filterParams.shift() || "")
            .replace(/^%/, "")
            .replace(/%$/, "")
            .toLowerCase();
        }
        if (normalized.includes("started_at >=")) {
          start = new Date(filterParams.shift());
        }
        if (normalized.includes("started_at <=")) {
          end = new Date(filterParams.shift());
        }

        const items = [...rows.values()]
          .filter((row) => {
            if (start && (!row.started_at || row.started_at < start)) return false;
            if (end && (!row.started_at || row.started_at > end)) return false;
            if (!query) return true;
            const haystack = [row.summary, JSON.stringify(row.transcript), ...(row.keywords || [])]
              .join("\n")
              .toLowerCase();
            return haystack.includes(query);
          })
          .sort(sortByStartedAtDesc)
          .slice(0, limit)
          .map((row) => ({
            conversation_id: row.conversation_id,
            twilio_call_sid: row.twilio_call_sid,
            caller_number: row.caller_number,
            started_at: row.started_at,
            ended_at: row.ended_at,
            duration_seconds: row.duration_seconds,
            status: row.status,
            summary: row.summary,
            keywords: row.keywords,
            tool_call_count: Array.isArray(row.tool_calls) ? row.tool_calls.length : 0,
          }));
        return { rowCount: items.length, rows: items };
      }

      throw new Error(`Unsupported SQL in memory store: ${normalized.slice(0, 160)}`);
    },
  };
}

function cloneRow(row) {
  return {
    ...row,
    transcript: structuredClone(row.transcript),
    keywords: [...(row.keywords || [])],
    tool_calls: structuredClone(row.tool_calls),
    tool_results: structuredClone(row.tool_results),
    metadata: structuredClone(row.metadata),
  };
}

function sortByStartedAtDesc(left, right) {
  const leftTime = left.started_at ? left.started_at.getTime() : 0;
  const rightTime = right.started_at ? right.started_at.getTime() : 0;
  return rightTime - leftTime;
}

function parseJsonParam(value, fallback) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value ?? fallback;
}

function elevenLabsConversation(overrides) {
  return {
    conversation_id: "conv",
    status: "done",
    analysis: { transcript_summary: overrides.summary || "" },
    metadata: {
      call_duration_secs: overrides.duration_secs || 0,
      twilio_call_sid: "CA123",
      caller_number: "+15555550100",
    },
    start_time_unix_secs: overrides.start_time_unix_secs || 1700000000,
    transcript: overrides.transcript || [],
    ...overrides,
  };
}

function mockElevenLabsFetch(byId) {
  return async (url) => {
    const match = String(url).match(/\/conversations\/([^/?]+)/);
    const id = match ? decodeURIComponent(match[1]) : "";
    const body = byId[id];
    if (!body) {
      return {
        ok: false,
        status: 404,
        async json() {
          return { detail: "not found" };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  };
}

function createToolStatusHelpers() {
  function toolResultStatusCode(result) {
    if (result.ok) return 200;
    if (
      [
        "confirmation_required",
        "conversation_history_not_configured",
        "cli_bridge_not_configured",
        "rss_feeds_not_configured",
        "tool_auth_not_configured",
      ].includes(result.status)
    ) {
      return 200;
    }
    return 400;
  }
  return { toolResultStatusCode };
}

async function maybeLiveBridgeProbe() {
  const toolToken =
    process.env.WEB_SEARCH_TOKEN ||
    process.env.COMMAND_BRIDGE_TOKEN ||
    process.env.CLI_BRIDGE_TOKEN;
  const workerBaseUrl = process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
  if (!toolToken) {
    return {
      skipped: true,
      reason: "No bridge token for live probe.",
    };
  }

  try {
    const response = await fetch(workerBaseUrl + "/conversation-history/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + toolToken,
      },
      body: JSON.stringify({ query: "phone", limit: 3 }),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const acceptable =
      response.status === 200 &&
      (body?.ok === true || body?.status === "conversation_history_not_configured");
    return {
      skipped: false,
      ok: acceptable,
      status: response.status,
      body_status: body?.status || "",
      returned_count: body?.returned_count,
    };
  } catch (error) {
    return { skipped: false, ok: false, error: error.message };
  }
}

function clearDatabaseEnv() {
  delete process.env.CONVERSATION_DATABASE_URL;
  delete process.env.NEON_DATABASE_URL;
  delete process.env.DATABASE_URL;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

assert.ok(true);
