const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const TOOL_NAME = "github_cli_common";
const question =
  "Use your GitHub CLI repo_list capability to list my ten most recently worked-on GitHub repositories across both my personal Andrew Furman repos and CoverNode work repos. Keep the answer short.";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const wiring = await verifyRepoListWiring();
const direct = await fetchDirectRepoList();
const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      conversation_status: details?.status || null,
      wiring,
      direct_repo_list: direct,
      user_message: question,
      tool_result: verification.toolResultSummary,
      agent_response_preview: verification.agentResponse.slice(0, 800),
      checks: verification.checks,
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function verifyRepoListWiring() {
  const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
  const tools = agent.conversation_config?.agent?.prompt?.tools || [];
  const commonTool = tools.find((tool) => tool.name === TOOL_NAME);
  const actionValues =
    commonTool?.api_schema?.request_body_schema?.properties?.action?.enum || [];
  const itemsSchema =
    commonTool?.api_schema?.response_body_schema?.properties?.items?.items?.properties || {};

  if (!commonTool) throw new Error("ElevenLabs agent is missing github_cli_common.");
  if (!actionValues.includes("repo_list")) {
    throw new Error("github_cli_common action enum is missing repo_list.");
  }
  if (!itemsSchema.name_with_owner || !itemsSchema.pushed_at) {
    throw new Error("github_cli_common repo_list response schema is missing repo item fields.");
  }

  return {
    url: commonTool.api_schema?.url || "",
    action_values: actionValues,
    has_repo_items_schema: true,
  };
}

async function fetchDirectRepoList() {
  const result = await postGithubCommon({
    action: "repo_list",
    limit: 10,
    sort: "pushed",
  });
  const owners = new Set((result.items || []).map((item) => item.owner));
  if (!owners.has("andrewfurman") || !owners.has("cover-node")) {
    throw new Error(
      `Direct repo_list did not include both owners: ${JSON.stringify([...owners])}`
    );
  }
  return {
    returned_count: result.returned_count,
    total_count: result.total_count,
    has_more: result.has_more,
    repos: (result.items || []).slice(0, 10).map((item) => item.name_with_owner),
  };
}

async function postGithubCommon(body) {
  const response = await fetch(`${workerBaseUrl}/cli/github/common`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);
  if (!response.ok || parsed?.ok !== true) {
    throw new Error(`github_cli_common failed (${response.status}): ${text}`);
  }
  return parsed;
}

async function runConversation(messageText) {
  const signed = await requestJson(
    `${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`
  );

  const ws = new WebSocket(signed.signed_url);
  let conversationId = null;
  let sentUserMessage = false;
  let sawToolResponse = false;
  let sawAgentAnswerAfterTool = false;
  let done;
  let settleTimer;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 90_000);
  const settle = (delay = 5_000) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => done({ reason: "settled" }), delay);
  };

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
  });

  ws.addEventListener("message", (event) => {
    const message = parseMaybeJson(event.data);
    if (!message || typeof message !== "object") return;

    if (message.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
      return;
    }

    if (message.type === "conversation_initiation_metadata") {
      conversationId =
        message.conversation_initiation_metadata_event?.conversation_id || null;
      if (!sentUserMessage) {
        sentUserMessage = true;
        ws.send(JSON.stringify({ type: "user_message", text: messageText }));
      }
      return;
    }

    if (!sentUserMessage) return;

    if (message.type === "agent_tool_response") {
      sawToolResponse = true;
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (sawToolResponse && isRealAgentMessage(text)) {
        sawAgentAnswerAfterTool = true;
        settle(5_000);
      }
    }

    if (message.type === "agent_response_complete") {
      settle(sawAgentAnswerAfterTool ? 3_000 : 10_000);
    }
  });

  ws.addEventListener("error", () => done({ reason: "websocket_error" }));

  const result = await donePromise;
  clearTimeout(hardTimeout);
  clearTimeout(settleTimer);
  try {
    ws.close();
  } catch {}

  if (!conversationId) {
    throw new Error(`No ElevenLabs conversation ID returned: ${JSON.stringify(result)}`);
  }

  return { conversationId };
}

async function fetchConversationDetails(conversationId) {
  const deadline = Date.now() + 60_000;
  let last;

  while (Date.now() < deadline) {
    last = await requestJson(`${apiBase}/v1/convai/conversations/${conversationId}`);
    if (conversationHasPostToolAnswer(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasPostToolAnswer(details) {
  const transcript = details?.transcript || [];
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === TOOL_NAME)
  );
  if (toolResultIndex < 0) return false;
  return transcript
    .slice(toolResultIndex + 1)
    .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message));
}

function verifyConversation(details) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const toolCall = toolCalls.find((call) => call.tool_name === TOOL_NAME);
  const params = parseMaybeJson(toolCall?.params_as_json);
  const toolResult = toolResults.find((result) => result.tool_name === TOOL_NAME);
  const value = parseMaybeJson(toolResult?.result_value);
  const items = Array.isArray(value?.items) ? value.items : [];
  const owners = new Set(items.map((item) => item.owner));
  const toolResultIndex = transcript.findIndex((turn) =>
    (turn.tool_results || []).some((result) => result.tool_name === TOOL_NAME)
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, toolResultIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    used_github_cli_common: Boolean(toolCall),
    requested_repo_list: params?.action === "repo_list",
    requested_concise_limit: Number(params?.limit || params?.max_results || 0) <= 10,
    tool_returned_without_error: Boolean(toolResult) && toolResult.is_error === false,
    returned_repositories: items.length > 0,
    returned_personal_repo: owners.has("andrewfurman"),
    returned_covernode_repo: owners.has("cover-node"),
    result_not_noisy: Number(value?.returned_count || items.length) <= 10,
    agent_answered_after_tool: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    toolResultSummary: {
      action: value?.action,
      returned_count: value?.returned_count,
      total_count: value?.total_count,
      has_more: value?.has_more,
      repos: items.map((item) => item.name_with_owner),
    },
    agentResponse,
  };
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${text}`);
  }

  return parsed;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
