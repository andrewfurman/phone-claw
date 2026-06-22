import pg from "pg";

const { Pool } = pg;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_CONTEXT_CONVERSATIONS = 10;
const MAX_KEYWORDS = 50;
const MAX_SUMMARY_WORDS = 100;
const DEFAULT_TRANSCRIPT_EXCERPT_TURNS = 12;
const MAX_TRANSCRIPT_EXCERPT_TURNS = 50;
const DEFAULT_TOOL_DETAIL_ITEMS = 12;
const MAX_TOOL_DETAIL_ITEMS = 50;
const MAX_TRANSCRIPT_TURN_WORDS = 80;
const MAX_TOOL_RESULT_PREVIEW_WORDS = 50;

let pool;
let schemaReady;

export function conversationHistoryConfigured() {
  return Boolean(databaseUrl());
}

export async function ensureConversationHistorySchema() {
  if (!conversationHistoryConfigured()) return false;
  if (schemaReady) return true;

  await db().query(`
    CREATE TABLE IF NOT EXISTS phoneclaw_conversations (
      conversation_id TEXT PRIMARY KEY,
      twilio_call_sid TEXT,
      caller_number TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      status TEXT,
      transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary TEXT NOT NULL DEFAULT '',
      keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
      tool_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS phoneclaw_conversations_started_at_idx
      ON phoneclaw_conversations (started_at DESC);

    CREATE INDEX IF NOT EXISTS phoneclaw_conversations_keywords_idx
      ON phoneclaw_conversations USING GIN (keywords);

  `);

  schemaReady = true;
  return true;
}

export async function archiveElevenLabsConversation({
  apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io",
  apiKey = process.env.ELEVENLABS_API_KEY,
  conversationId,
  fetchImpl = fetch,
} = {}) {
  if (!conversationHistoryConfigured()) return notConfiguredResponse();
  if (!apiKey) return missingField("elevenlabs_api_key", "ELEVENLABS_API_KEY is not configured.");

  const id = normalizeString(conversationId);
  if (!id) return missingField("conversation_id", "An ElevenLabs conversation_id is required.");

  const response = await fetchImpl(`${apiBase}/v1/convai/conversations/${encodeURIComponent(id)}`, {
    headers: { "xi-api-key": apiKey },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: "elevenlabs_conversation_fetch_failed",
      conversation_id: id,
      upstream_status: response.status,
      message: body.detail || body.message || "ElevenLabs conversation fetch failed.",
      answer_text: "I could not fetch that ElevenLabs conversation.",
    };
  }

  const record = normalizeElevenLabsConversation(body, id);
  await upsertConversation(record);

  return {
    ok: true,
    status: "archived",
    conversation_id: record.conversation_id,
    started_at: record.started_at,
    duration_seconds: record.duration_seconds,
    keyword_count: record.keywords.length,
    tool_call_count: record.tool_calls.length,
    answer_text: `Archived conversation ${record.conversation_id}.`,
  };
}

export async function archiveLatestElevenLabsConversations({
  apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io",
  apiKey = process.env.ELEVENLABS_API_KEY,
  agentId = process.env.ELEVENLABS_AGENT_ID,
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
} = {}) {
  if (!conversationHistoryConfigured()) return notConfiguredResponse();
  if (!apiKey) return missingField("elevenlabs_api_key", "ELEVENLABS_API_KEY is not configured.");
  if (!agentId) return missingField("elevenlabs_agent_id", "ELEVENLABS_AGENT_ID is not configured.");

  const boundedLimit = clampInteger(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const url = new URL(`${apiBase}/v1/convai/conversations`);
  url.searchParams.set("agent_id", agentId);
  url.searchParams.set("page_size", String(boundedLimit));

  const response = await fetchImpl(url.toString(), {
    headers: { "xi-api-key": apiKey },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: "elevenlabs_conversation_list_failed",
      upstream_status: response.status,
      message: body.detail || body.message || "ElevenLabs conversation list failed.",
      answer_text: "I could not fetch the latest ElevenLabs conversations.",
    };
  }

  const conversations = body.conversations || body.items || body.data || [];
  const archived = [];
  for (const conversation of conversations.slice(0, boundedLimit)) {
    const conversationId = conversation.conversation_id || conversation.id;
    if (!conversationId) continue;
    archived.push(await archiveElevenLabsConversation({ apiBase, apiKey, conversationId, fetchImpl }));
  }

  return {
    ok: true,
    status: "archived_latest",
    requested_count: boundedLimit,
    archived_count: archived.filter((item) => item.ok).length,
    results: archived,
    answer_text: `Archived ${archived.filter((item) => item.ok).length} recent ElevenLabs conversations.`,
  };
}

export async function conversationRecentContext({ limit = MAX_CONTEXT_CONVERSATIONS } = {}) {
  if (!conversationHistoryConfigured()) return notConfiguredResponse();
  await ensureConversationHistorySchema();

  const boundedLimit = clampInteger(limit, 1, MAX_CONTEXT_CONVERSATIONS, MAX_CONTEXT_CONVERSATIONS);
  const result = await db().query(
    `
      SELECT conversation_id, started_at, summary, keywords
      FROM phoneclaw_conversations
      ORDER BY started_at DESC NULLS LAST, updated_at DESC
      LIMIT $1
    `,
    [boundedLimit]
  );
  const items = result.rows.map(compactConversationRow);

  return {
    ok: true,
    status: "ok",
    returned_count: items.length,
    items,
    context_text: formatRecentContext(items),
    answer_text: `Loaded ${items.length} recent conversation summaries.`,
  };
}

export async function conversationHistorySearch({
  query = "",
  startDate,
  endDate,
  limit = DEFAULT_LIMIT,
} = {}) {
  if (!conversationHistoryConfigured()) return notConfiguredResponse();
  await ensureConversationHistorySchema();

  const boundedLimit = clampInteger(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const values = [];
  const conditions = [];
  const normalizedQuery = normalizeString(query);

  if (normalizedQuery) {
    values.push(`%${normalizedQuery}%`);
    const queryIndex = values.length;
    conditions.push(`(
      summary ILIKE $${queryIndex}
      OR transcript::text ILIKE $${queryIndex}
      OR EXISTS (
        SELECT 1 FROM unnest(keywords) AS keyword
        WHERE keyword ILIKE $${queryIndex}
      )
    )`);
  }

  const start = normalizeDate(startDate);
  if (start) {
    values.push(start);
    conditions.push(`started_at >= $${values.length}`);
  }

  const end = normalizeDate(endDate);
  if (end) {
    values.push(end);
    conditions.push(`started_at <= $${values.length}`);
  }

  values.push(boundedLimit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db().query(
    `
      SELECT conversation_id, twilio_call_sid, caller_number, started_at, ended_at,
        duration_seconds, status, summary, keywords,
        jsonb_array_length(tool_calls) AS tool_call_count
      FROM phoneclaw_conversations
      ${where}
      ORDER BY started_at DESC NULLS LAST, updated_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  const items = result.rows.map(compactConversationRow);
  return {
    ok: true,
    status: "ok",
    query: normalizedQuery,
    start_date: start || "",
    end_date: end || "",
    returned_count: items.length,
    items,
    answer_text: `Found ${items.length} matching archived conversations.`,
  };
}

export async function conversationHistoryGet({
  conversationId,
  includeTranscript = false,
  includeToolDetails = false,
  maxTranscriptTurns = DEFAULT_TRANSCRIPT_EXCERPT_TURNS,
  maxToolItems = DEFAULT_TOOL_DETAIL_ITEMS,
} = {}) {
  if (!conversationHistoryConfigured()) return notConfiguredResponse();
  await ensureConversationHistorySchema();

  const id = normalizeString(conversationId);
  if (!id) return missingField("conversation_id", "A conversation_id is required.");

  const result = await db().query(
    `
      SELECT conversation_id, twilio_call_sid, caller_number, started_at, ended_at,
        duration_seconds, status, transcript, summary, keywords, tool_calls,
        tool_results, metadata
      FROM phoneclaw_conversations
      WHERE conversation_id = $1
    `,
    [id]
  );

  if (result.rowCount === 0) {
    return {
      ok: false,
      status: "conversation_not_found",
      conversation_id: id,
      answer_text: `I could not find archived conversation ${id}.`,
    };
  }

  const row = result.rows[0];
  const transcript = Array.isArray(row.transcript) ? row.transcript : [];
  const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  const toolResults = Array.isArray(row.tool_results) ? row.tool_results : [];
  const transcriptLimit = clampInteger(
    maxTranscriptTurns,
    1,
    MAX_TRANSCRIPT_EXCERPT_TURNS,
    DEFAULT_TRANSCRIPT_EXCERPT_TURNS
  );
  const toolLimit = clampInteger(
    maxToolItems,
    1,
    MAX_TOOL_DETAIL_ITEMS,
    DEFAULT_TOOL_DETAIL_ITEMS
  );
  const transcriptExcerpt = compactTranscriptTurns(transcript, transcriptLimit);

  const conversation = {
    ...compactConversationRow(row),
    transcript_turn_count: transcript.length,
    transcript_excerpt: transcriptExcerpt,
    transcript_truncated: transcript.length > transcriptExcerpt.length,
    tool_calls: compactToolCalls(toolCalls, toolLimit),
    tool_call_truncated: toolCalls.length > toolLimit,
    tool_result_count: toolResults.length,
    tool_results: toBoolean(includeToolDetails)
      ? compactToolResults(toolResults, toolLimit)
      : [],
    tool_results_truncated: toolResults.length > toolLimit,
    metadata: compactConversationMetadata(row.metadata),
  };

  if (toBoolean(includeTranscript)) {
    conversation.transcript = transcriptExcerpt;
  }

  return {
    ok: true,
    status: "ok",
    conversation,
    answer_text: "Retrieved the archived conversation summary and a compact transcript excerpt.",
  };
}

function db() {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      ssl: databaseUrl().includes("sslmode=require") ? undefined : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

function databaseUrl() {
  return (
    process.env.CONVERSATION_DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  );
}

async function upsertConversation(record) {
  await ensureConversationHistorySchema();
  await db().query(
    `
      INSERT INTO phoneclaw_conversations (
        conversation_id, twilio_call_sid, caller_number, started_at, ended_at,
        duration_seconds, status, transcript, summary, keywords, tool_calls,
        tool_results, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb)
      ON CONFLICT (conversation_id) DO UPDATE SET
        twilio_call_sid = EXCLUDED.twilio_call_sid,
        caller_number = EXCLUDED.caller_number,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        duration_seconds = EXCLUDED.duration_seconds,
        status = EXCLUDED.status,
        transcript = EXCLUDED.transcript,
        summary = EXCLUDED.summary,
        keywords = EXCLUDED.keywords,
        tool_calls = EXCLUDED.tool_calls,
        tool_results = EXCLUDED.tool_results,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      record.conversation_id,
      record.twilio_call_sid,
      record.caller_number,
      record.started_at,
      record.ended_at,
      record.duration_seconds,
      record.status,
      JSON.stringify(record.transcript),
      record.summary,
      record.keywords,
      JSON.stringify(record.tool_calls),
      JSON.stringify(record.tool_results),
      JSON.stringify(record.metadata),
    ]
  );
}

function normalizeElevenLabsConversation(body, fallbackId) {
  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  const metadata = body.metadata || {};
  const startedAt = unixSecondsToIso(
    body.start_time_unix_secs || metadata.start_time_unix_secs || body.created_at_unix_secs
  );
  const duration = Number(metadata.call_duration_secs || body.duration_secs || body.call_duration_secs);
  const durationSeconds = Number.isFinite(duration) ? Math.round(duration) : null;
  const endedAt =
    startedAt && durationSeconds !== null
      ? new Date(new Date(startedAt).getTime() + durationSeconds * 1000).toISOString()
      : null;
  const toolCalls = transcript.flatMap((turn, index) =>
    (turn.tool_calls || []).map((call) => ({
      transcript_index: index,
      tool_name: call.tool_name || "",
      params: parseMaybeJson(call.params_as_json) || call.params || {},
    }))
  );
  const toolResults = transcript.flatMap((turn, index) =>
    (turn.tool_results || []).map((result) => ({
      transcript_index: index,
      tool_name: result.tool_name || "",
      is_error: Boolean(result.is_error),
      result: parseMaybeJson(result.result_value) || result.result_value || null,
    }))
  );
  const summary =
    body.analysis?.transcript_summary ||
    body.summary ||
    summarizeTranscript(transcript, MAX_SUMMARY_WORDS);
  const transcriptText = transcript
    .map((turn) => `${turn.role || "unknown"}: ${turn.message || ""}`)
    .join("\n");

  return {
    conversation_id: body.conversation_id || body.id || fallbackId,
    twilio_call_sid: metadata.twilio_call_sid || metadata.call_sid || "",
    caller_number: metadata.caller_number || "",
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    status: body.status || "",
    transcript,
    summary: limitWords(summary, MAX_SUMMARY_WORDS),
    keywords: extractKeywords(transcriptText, MAX_KEYWORDS),
    tool_calls: toolCalls,
    tool_results: toolResults,
    metadata: body,
  };
}

function summarizeTranscript(transcript, maxWords) {
  const userTurns = transcript
    .filter((turn) => turn.role === "user" && turn.message)
    .map((turn) => turn.message);
  const source = userTurns.length > 0 ? userTurns.join(" ") : transcript.map((turn) => turn.message || "").join(" ");
  return limitWords(source, maxWords);
}

function extractKeywords(text, maxKeywords) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "andrew",
    "because",
    "before",
    "could",
    "from",
    "have",
    "just",
    "like",
    "make",
    "that",
    "this",
    "what",
    "when",
    "with",
    "would",
    "yeah",
    "your",
  ]);
  const counts = new Map();
  for (const word of String(text || "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) {
    if (stopWords.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

function compactConversationRow(row) {
  return {
    conversation_id: row.conversation_id,
    twilio_call_sid: row.twilio_call_sid || "",
    caller_number: row.caller_number || "",
    started_at: row.started_at ? new Date(row.started_at).toISOString() : "",
    ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : "",
    duration_seconds: row.duration_seconds ?? null,
    status: row.status || "",
    summary: row.summary || "",
    keywords: row.keywords || [],
    tool_call_count: Number(row.tool_call_count || 0),
  };
}

function compactTranscriptTurns(transcript, maxTurns) {
  return transcript.slice(-maxTurns).map((turn, index) => ({
    excerpt_index: index,
    role: turn.role || "unknown",
    message: limitWords(turn.message || "", MAX_TRANSCRIPT_TURN_WORDS),
    tool_calls: (turn.tool_calls || []).map((call) => ({
      tool_name: call.tool_name || "",
    })),
    tool_results: (turn.tool_results || []).map((result) => ({
      tool_name: result.tool_name || "",
      is_error: Boolean(result.is_error),
    })),
  }));
}

function compactToolCalls(toolCalls, maxItems) {
  return toolCalls.slice(0, maxItems).map((call) => ({
    transcript_index: call.transcript_index,
    tool_name: call.tool_name || "",
    param_keys: Object.keys(call.params || {}).slice(0, 20),
  }));
}

function compactToolResults(toolResults, maxItems) {
  return toolResults.slice(0, maxItems).map((toolResult) => {
    const result = toolResult.result;
    const resultObject = result && typeof result === "object" ? result : {};
    return {
      transcript_index: toolResult.transcript_index,
      tool_name: toolResult.tool_name || "",
      is_error: Boolean(toolResult.is_error),
      status: normalizeString(resultObject.status),
      action: normalizeString(resultObject.action),
      returned_count: resultObject.returned_count ?? null,
      answer_text: limitWords(resultObject.answer_text || "", MAX_TOOL_RESULT_PREVIEW_WORDS),
      result_preview: limitWords(
        typeof result === "string" ? result : JSON.stringify(resultObject),
        MAX_TOOL_RESULT_PREVIEW_WORDS
      ),
    };
  });
}

function compactConversationMetadata(metadata) {
  const value = metadata && typeof metadata === "object" ? metadata : {};
  return {
    termination_reason: value.metadata?.termination_reason || value.termination_reason || "",
    error_code: value.metadata?.error?.code || value.error?.code || null,
    error_reason: value.metadata?.error?.reason || value.error?.reason || "",
    phone_call: {
      direction: value.metadata?.phone_call?.direction || value.phone_call?.direction || "",
      type: value.metadata?.phone_call?.type || value.phone_call?.type || "",
    },
  };
}

function formatRecentContext(items) {
  if (items.length === 0) return "No prior phone conversations are archived yet.";
  return items
    .map((item, index) => {
      const keywords = item.keywords?.length ? ` Keywords: ${item.keywords.slice(0, 12).join(", ")}.` : "";
      return `${index + 1}. ${item.started_at || "unknown date"} ${item.conversation_id}: ${item.summary}${keywords}`;
    })
    .join("\n");
}

function notConfiguredResponse() {
  return {
    ok: false,
    status: "conversation_history_not_configured",
    message:
      "CONVERSATION_DATABASE_URL, NEON_DATABASE_URL, or DATABASE_URL is not configured on the bridge.",
    answer_text: "Conversation history is not configured on the bridge yet.",
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

function unixSecondsToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number * 1000).toISOString();
}

function limitWords(value, maxWords) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}

function normalizeDate(value) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
