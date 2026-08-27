const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;
const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;
const EMAIL_IMAGES_TOOL_NAME = "himalaya_email_images";
const URL_FETCH_TOOL_NAME = "url_fetch";

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const wiring = await verifyToolWiring();
const direct = await verifyDirectWorkerTools();
const question = [
  "For validation, use the himalaya_email_images tool on this exact email envelope id:",
  direct.email_candidate.id,
  "in the INBOX folder with include_data false.",
  "Then use the url_fetch tool to fetch https://example.com.",
  "In your final answer, start with Email image inspection complete and briefly say whether the email image inspection and URL fetch worked.",
].join(" ");
const conversation = await runConversation(question);
const details = await fetchConversationDetails(conversation.conversationId);
const verification = verifyConversation(details, direct.email_candidate);

console.log(
  JSON.stringify(
    {
      ok: verification.ok,
      conversation_id: conversation.conversationId,
      conversation_status: details?.status || null,
      wiring,
      direct_checks: direct.checks,
      direct_email_candidate: {
        folder: direct.email_candidate.folder,
        returned_count: direct.email_candidate.returned_count,
        html_image_count: direct.email_candidate.html_image_count,
      },
      tool_results: verification.toolResultsSummary,
      agent_response_preview: verification.agentResponse.slice(0, 700),
      checks: verification.checks,
    },
    null,
    2
  )
);

process.exit(verification.ok ? 0 : 1);

async function verifyToolWiring() {
  const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
  const tools = agent.conversation_config?.agent?.prompt?.tools || [];
  const emailImagesTool = tools.find((tool) => tool.name === EMAIL_IMAGES_TOOL_NAME);
  const urlFetchTool = tools.find((tool) => tool.name === URL_FETCH_TOOL_NAME);

  const expectedEmailImagesUrl = `${workerBaseUrl}/cli/himalaya/email-images`;
  const expectedUrlFetchUrl = `${workerBaseUrl}/cli/url-fetch`;
  if (emailImagesTool?.api_schema?.url !== expectedEmailImagesUrl) {
    throw new Error(
      `ElevenLabs ${EMAIL_IMAGES_TOOL_NAME} URL mismatch. Expected ${expectedEmailImagesUrl}, got ${emailImagesTool?.api_schema?.url || "(missing)"}.`
    );
  }
  if (urlFetchTool?.api_schema?.url !== expectedUrlFetchUrl) {
    throw new Error(
      `ElevenLabs ${URL_FETCH_TOOL_NAME} URL mismatch. Expected ${expectedUrlFetchUrl}, got ${urlFetchTool?.api_schema?.url || "(missing)"}.`
    );
  }

  const imageResponseProperties =
    emailImagesTool?.api_schema?.response_body_schema?.properties || {};
  const urlResponseProperties =
    urlFetchTool?.api_schema?.response_body_schema?.properties || {};
  if (!imageResponseProperties.images || !imageResponseProperties.html_images) {
    throw new Error(`${EMAIL_IMAGES_TOOL_NAME} schema is missing image arrays.`);
  }
  if (!urlResponseProperties.body_text || !urlResponseProperties.links) {
    throw new Error(`${URL_FETCH_TOOL_NAME} schema is missing body_text or links.`);
  }

  return {
    email_images_url: emailImagesTool.api_schema.url,
    url_fetch_url: urlFetchTool.api_schema.url,
    has_email_images_schema: true,
    has_url_fetch_schema: true,
  };
}

async function verifyDirectWorkerTools() {
  const urlFetch = await workerJson("/cli/url-fetch", {
    url: "https://example.com",
    max_body_chars: 2_000,
  });
  const blockedPrivate = await workerJson("/cli/url-fetch", {
    url: "http://127.0.0.1:8000/health",
  }, { allowHttpError: true });
  const emailCandidate = await findEmailImageCandidate();

  const checks = {
    url_fetch_ok:
      urlFetch.ok === true &&
      urlFetch.status_code === 200 &&
      /example domain/i.test(urlFetch.title || urlFetch.body_text || ""),
    private_url_blocked: blockedPrivate.status === "blocked_private_url",
    email_candidate_found:
      Boolean(emailCandidate.id) &&
      (Number(emailCandidate.returned_count || 0) > 0 ||
        Number(emailCandidate.html_image_count || 0) > 0),
  };

  if (!Object.values(checks).every(Boolean)) {
    throw new Error(
      `Direct Worker preflight failed: ${JSON.stringify({
        checks,
        urlFetch: compactUrlResult(urlFetch),
        blockedPrivate,
        emailCandidate,
      })}`
    );
  }

  return {
    checks,
    email_candidate: emailCandidate,
  };
}

async function findEmailImageCandidate() {
  const list = await workerJson("/cli/himalaya/email-list", {
    folder: "INBOX",
    page_size: 25,
  });

  if (!list.ok || !Array.isArray(list.items)) {
    throw new Error(`Email list failed: ${JSON.stringify(list)}`);
  }

  for (const item of list.items) {
    if (!item.id) continue;
    const images = await workerJson("/cli/himalaya/email-images", {
      id: item.id,
      folder: "INBOX",
      include_data: false,
      max_images: 12,
    });

    if (
      images.ok === true &&
      (Number(images.returned_count || 0) > 0 ||
        Number(images.html_image_count || 0) > 0)
    ) {
      return {
        id: item.id,
        folder: "INBOX",
        returned_count: Number(images.returned_count || 0),
        html_image_count: Number(images.html_image_count || 0),
      };
    }
  }

  return {
    id: "",
    folder: "INBOX",
    returned_count: 0,
    html_image_count: 0,
  };
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
  let sawEmailImagesResult = false;
  let sawUrlFetchResult = false;
  let done;
  let settleTimer;
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });

  const hardTimeout = setTimeout(() => done({ reason: "hard_timeout" }), 120_000);
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
      const toolName = message.agent_tool_response_event?.tool_name || "";
      if (toolName === EMAIL_IMAGES_TOOL_NAME) sawEmailImagesResult = true;
      if (toolName === URL_FETCH_TOOL_NAME) sawUrlFetchResult = true;
      return;
    }

    if (message.type === "agent_response") {
      const text = message.agent_response_event?.agent_response || "";
      if (sawEmailImagesResult && sawUrlFetchResult && isRealAgentMessage(text)) {
        settle();
      }
      return;
    }

    if (message.type === "agent_response_complete") {
      settle(sawEmailImagesResult && sawUrlFetchResult ? 2_500 : 12_000);
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
    if (conversationHasExpectedToolResults(last)) return last;
    await wait(1_500);
  }

  return last;
}

function conversationHasExpectedToolResults(details) {
  const transcript = details?.transcript || [];
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const hasEmailImages = toolResults.some(
    (result) => result.tool_name === EMAIL_IMAGES_TOOL_NAME
  );
  const hasUrlFetch = toolResults.some((result) => result.tool_name === URL_FETCH_TOOL_NAME);
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) =>
      [EMAIL_IMAGES_TOOL_NAME, URL_FETCH_TOOL_NAME].includes(result.tool_name)
    )
  );

  return (
    hasEmailImages &&
    hasUrlFetch &&
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .some((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
  );
}

function verifyConversation(details, expectedEmailCandidate) {
  const transcript = details?.transcript || [];
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []);
  const toolResults = transcript.flatMap((turn) => turn.tool_results || []);
  const emailImagesCall = toolCalls.find((call) => call.tool_name === EMAIL_IMAGES_TOOL_NAME);
  const urlFetchCall = toolCalls.find((call) => call.tool_name === URL_FETCH_TOOL_NAME);
  const emailImagesResult = toolResults.find(
    (result) => result.tool_name === EMAIL_IMAGES_TOOL_NAME
  );
  const urlFetchResult = toolResults.find((result) => result.tool_name === URL_FETCH_TOOL_NAME);
  const emailImagesValue = parseMaybeJson(emailImagesResult?.result_value);
  const urlFetchValue = parseMaybeJson(urlFetchResult?.result_value);
  const emailImagesParams = parseMaybeJson(emailImagesCall?.params_as_json);
  const urlFetchParams = parseMaybeJson(urlFetchCall?.params_as_json);
  const latestToolIndex = transcript.findLastIndex((turn) =>
    (turn.tool_results || []).some((result) =>
      [EMAIL_IMAGES_TOOL_NAME, URL_FETCH_TOOL_NAME].includes(result.tool_name)
    )
  );
  const agentResponse =
    transcript
      .slice(Math.max(0, latestToolIndex + 1))
      .filter((turn) => turn.role === "agent" && isRealAgentMessage(turn.message))
      .map((turn) => turn.message)
      .at(-1) || "";

  const checks = {
    transcript_available: transcript.length > 0,
    used_email_images_tool: Boolean(emailImagesCall),
    used_url_fetch_tool: Boolean(urlFetchCall),
    requested_expected_email_id: String(emailImagesParams?.id || "") === expectedEmailCandidate.id,
    left_image_data_disabled:
      emailImagesParams?.include_data === false || emailImagesParams?.includeData === false,
    email_images_returned_without_error:
      Boolean(emailImagesResult) && emailImagesResult.is_error === false,
    email_images_found_image_content:
      emailImagesValue?.ok === true &&
      (Number(emailImagesValue?.returned_count || 0) > 0 ||
        Number(emailImagesValue?.html_image_count || 0) > 0),
    url_fetch_returned_without_error:
      Boolean(urlFetchResult) && urlFetchResult.is_error === false,
    url_fetch_used_expected_url:
      String(urlFetchParams?.url || urlFetchValue?.url || "").startsWith("https://example.com"),
    url_fetch_succeeded:
      urlFetchValue?.ok === true &&
      urlFetchValue?.status_code === 200 &&
      /example domain/i.test(urlFetchValue?.title || urlFetchValue?.body_text || ""),
    agent_answered_after_tools: agentResponse.length > 0,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    agentResponse,
    toolResultsSummary: {
      email_images: {
        ok: emailImagesValue?.ok,
        returned_count: emailImagesValue?.returned_count,
        html_image_count: emailImagesValue?.html_image_count,
        include_data: emailImagesValue?.include_data,
      },
      url_fetch: compactUrlResult(urlFetchValue),
    },
  };
}

async function workerJson(path, body, options = {}) {
  const response = await fetch(`${workerBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok && !options.allowHttpError) {
    throw new Error(`Worker request failed (${response.status}) ${path}: ${text}`);
  }

  return parsed;
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

function compactUrlResult(value) {
  return {
    ok: value?.ok,
    status: value?.status,
    status_code: value?.status_code,
    title: value?.title,
    link_count: Array.isArray(value?.links) ? value.links.length : 0,
  };
}

function isRealAgentMessage(value) {
  const text = String(value || "").trim();
  return text.length > 5 && text !== "...";
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
