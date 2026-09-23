import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import {
  archiveElevenLabsConversation,
  archiveLatestElevenLabsConversations,
  conversationHistoryConfigured,
  conversationRecentContext,
} from "./conversation-history.mjs";
import { runUniversalCli } from "./universal-cli.mjs";
import { CLI_COMMAND_CATALOG } from "../shared/cli-command-catalog.mjs";
import { sendgridConfigured } from "./sendgrid-tools.mjs";
import { configuredRssFeedsConfigured } from "./rss-feed-tools.mjs";
import {
  isAllowedCaller,
  lastFourDigits,
  parseAllowedCallerNumbers,
} from "../shared/phone-numbers.mjs";
import { ELEVENLABS_TELEPHONY_AUDIO_FORMAT } from "../shared/telephony-audio-format.mjs";
import {
  attachStreamStatusCallback,
  buildTwilioEvent,
} from "../shared/twilio-events.mjs";

const { validateRequest } = twilio;

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const elevenLabsApiBase =
  process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsAgentId = process.env.ELEVENLABS_AGENT_ID;
const commandBridgeToken = process.env.COMMAND_BRIDGE_TOKEN;
const webSearchToken = process.env.WEB_SEARCH_TOKEN || commandBridgeToken;
const cliBridgeToken = process.env.CLI_BRIDGE_TOKEN;
const claudeBridgeUrl = process.env.CLAUDE_BRIDGE_URL;
const claudeBridgeToken = process.env.CLAUDE_BRIDGE_TOKEN;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const enforceTwilioSignature =
  process.env.ENFORCE_TWILIO_SIGNATURE === "true" && Boolean(twilioAuthToken);
const outsideCoverageMessage =
  process.env.OUTSIDE_COVERAGE_MESSAGE ||
  "Thanks for calling Andrew's assistance line. Sorry we haven't set up outside coverage yet.";
const twilioEvents = [];

const app = Fastify({
  logger: {
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: redactUrlForLogs(request.url),
          host: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  },
  trustProxy: true,
  bodyLimit: 1_000_000,
});

await app.register(formbody);

app.get("/", async () => ({
  ok: true,
  endpoints: {
    twilio_inbound: "POST /twilio/inbound",
    twilio_outbound: "POST /twilio/outbound",
    twilio_stream_status: "POST /twilio/stream-status",
    twilio_call_status: "POST /twilio/call-status",
    twilio_events: "GET /twilio/events",
    run_cli: "POST /cli/run",
    conversation_history_recent_context: "POST /conversation-history/recent-context",
    conversation_history_archive: "POST /conversation-history/archive-elevenlabs",
    future_claude_tool: "POST /agent-command",
    health: "GET /health",
  },
}));

app.get("/health", async () => ({
  ok: true,
  elevenlabs_agent_configured: Boolean(elevenLabsAgentId),
  command_bridge_configured: Boolean(claudeBridgeUrl),
  web_search_configured: Boolean(webSearchToken),
  cli_bridge_token_configured: Boolean(cliBridgeToken),
  github_cli_bridge_configured: Boolean(cliBridgeToken || webSearchToken),
  claude_code_bridge_configured: true,
  configured_rss_feeds_configured: configuredRssFeedsConfigured(),
  sendgrid_configured: sendgridConfigured(),
  conversation_history_configured: conversationHistoryConfigured(),
  expected_elevenlabs_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
  allowed_caller_numbers_configured:
    parseAllowedCallerNumbers(process.env.ALLOWED_CALLER_NUMBERS).length > 0,
  twilio_signature_enforced: enforceTwilioSignature,
  twilio_event_log_configured: true,
}));

app.post("/twilio/inbound", async (request, reply) =>
  handleTwilioCall(request, reply, "inbound")
);

app.post("/twilio/outbound", async (request, reply) =>
  handleTwilioCall(request, reply, "outbound")
);

app.post("/twilio/stream-status", async (request, reply) =>
  handleTwilioStatusCallback(request, reply, "twilio_stream_status")
);

app.post("/twilio/call-status", async (request, reply) =>
  handleTwilioStatusCallback(request, reply, "twilio_call_status")
);

app.get("/twilio/events", async (request, reply) => handleTwilioEvents(request, reply));

app.post("/agent-command", async (request, reply) => handleAgentCommand(request, reply));

app.post("/cli/run", async (request, reply) => handleRunCli(request, reply));

// Temporary compatibility for deployed clients. No new integration needs a route.
if (process.env.PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES !== "false") {
  for (const { command, legacy_path } of CLI_COMMAND_CATALOG) {
    app.post(legacy_path, async (request, reply) => {
      const authenticated = legacy_path === "/web-search"
        ? validateToolAuth(request, reply) : validateCliToolAuth(request, reply);
      if (!authenticated) return;
      reply.header("Deprecation", "@1789387200");
      reply.header("Link", '</cli/run>; rel="successor-version"');
      const body = request.body || {};
      const result = await runUniversalCli({
        command: "phoneclaw", args: [...command.split(" "), "--json", JSON.stringify(body)],
        // Legacy payload limits belong to the domain command. Do not also apply
        // the smaller default voice envelope to its raw + parsed JSON copies.
        confirmed: body.confirmed, maxRawBytes: 750_000, timeoutMs: 60_000,
      });
      const legacy = result.data || result;
      const claudeOutcome = command === "claude code" && ["claude_auth_expired", "claude_auth_probe_failed", "claude_not_authenticated", "job_not_found", "session_ready", "steering_recorded", "opencode_not_installed", "opencode_not_configured", "opencode_auth_failed", "opencode_out_of_credit", "opencode_auth_probe_failed"].includes(legacy.status);
      return reply.code(claudeOutcome ? 200 : toolResultStatusCode(legacy)).send(legacy);
    });
  }
}

app.post("/conversation-history/recent-context", async (request, reply) =>
  handleConversationRecentContext(request, reply)
);

app.post("/conversation-history/archive-elevenlabs", async (request, reply) =>
  handleConversationArchiveElevenLabs(request, reply)
);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

async function handleTwilioCall(request, reply, direction) {
  try {
    if (!isValidTwilioRequest(request)) {
      return reply.code(403).type("application/xml").send(sayTwiml("Unauthorized."));
    }

    const body = request.body || {};
    const fromNumber = body.From || body.from_number || body.fromNumber;
    const toNumber =
      body.To || body.to_number || body.toNumber || process.env.TWILIO_PHONE_NUMBER;

    if (!fromNumber || !toNumber) {
      return reply
        .code(200)
        .type("application/xml")
        .send(sayTwiml("The call did not include the phone number details this bridge needs."));
    }

    if (
      direction === "inbound" &&
      !isAllowedCaller(fromNumber, process.env.ALLOWED_CALLER_NUMBERS)
    ) {
      request.log.info(
        {
          event: "twilio_call_rejected",
          direction,
          from_last4: lastFourDigits(fromNumber),
          to_last4: lastFourDigits(toNumber),
          call_sid: body.CallSid,
        },
        "rejected non-allowlisted Twilio call"
      );
      return reply.code(200).type("application/xml").send(sayTwiml(outsideCoverageMessage));
    }

    if (!elevenLabsAgentId || !elevenLabsApiKey) {
      return reply
        .code(200)
        .type("application/xml")
        .send(sayTwiml("The ElevenLabs voice agent is not configured on this server yet."));
    }

    request.log.info(
      {
        event: "twilio_call",
        direction,
        from_last4: lastFourDigits(fromNumber),
        to_last4: lastFourDigits(toNumber),
        call_sid: body.CallSid,
      },
      "received Twilio call"
    );

    const twiml = await registerElevenLabsTwilioCall({
      direction,
      fromNumber,
      toNumber,
      callSid: body.CallSid,
      streamStatusCallbackUrl: twilioCallbackUrl(request, "/twilio/stream-status"),
    });

    return reply.code(200).type("application/xml").send(twiml);
  } catch (error) {
    request.log.error(error, "Twilio call handling failed");
    return reply
      .code(200)
      .type("application/xml")
      .send(sayTwiml("The voice agent connection failed. Please try again later."));
  }
}

async function registerElevenLabsTwilioCall({
  direction,
  fromNumber,
  toNumber,
  callSid,
  streamStatusCallbackUrl,
}) {
  const response = await fetch(
    `${elevenLabsApiBase}/v1/convai/twilio/register-call`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": elevenLabsApiKey,
      },
      body: JSON.stringify({
        agent_id: elevenLabsAgentId,
        from_number: fromNumber,
        to_number: toNumber,
        direction,
        conversation_initiation_client_data: {
          dynamic_variables: {
            caller_number: fromNumber,
            twilio_number: toNumber,
            twilio_call_sid: callSid || "",
            telephony_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
          },
        },
      }),
    }
  );

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `ElevenLabs register-call failed (${response.status}): ${text.slice(0, 800)}`
    );
  }

  return attachStreamStatusCallback(
    extractTwiml(text, contentType),
    streamStatusCallbackUrl
  );
}

async function handleTwilioStatusCallback(request, reply, source) {
  if (!isValidTwilioCallbackRequest(request)) {
    return reply.code(403).send({ ok: false, status: "unauthorized" });
  }

  const event = buildTwilioEvent({ source, payload: request.body || {} });
  twilioEvents.unshift(event);
  twilioEvents.splice(100);

  request.log.info(
    {
      event: "twilio_status_callback",
      id: event.id,
      source: event.source,
      event_type: event.event_type,
      call_sid: event.call_sid,
      stream_sid: event.stream_sid,
      stream_event: event.stream_event,
      call_status: event.call_status,
      from_last4: event.from_last4,
      to_last4: event.to_last4,
    },
    "received Twilio status callback"
  );

  return reply.code(200).send({ ok: true });
}

async function handleTwilioEvents(request, reply) {
  if (!isValidDiagnosticsRequest(request)) {
    return reply.code(401).send({ ok: false, status: "unauthorized" });
  }

  const query = request.query || {};
  const callSid = query.call_sid || query.callSid || "";
  const limit = clampInteger(query.limit, 1, 100, 30);
  const events = twilioEvents
    .filter((event) => !callSid || event.call_sid === callSid)
    .slice(0, limit);

  return reply.code(200).send({
    ok: true,
    call_sid: callSid || null,
    returned_count: events.length,
    events,
  });
}

async function handleAgentCommand(request, reply) {
  if (!commandBridgeToken) {
    return reply.code(503).send({
      ok: false,
      status: "tool_auth_not_configured",
      message: "COMMAND_BRIDGE_TOKEN is not set on this server.",
    });
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${commandBridgeToken}`)) {
    return reply.code(401).send({ ok: false, status: "unauthorized" });
  }

  const body = request.body || {};
  if (!body.command || typeof body.command !== "string") {
    return reply.code(400).send({
      ok: false,
      status: "missing_command",
      message: "A string command is required.",
    });
  }

  if (body.confirmed !== true && body.confirmed !== "true") {
    return reply.code(200).send({
      ok: false,
      status: "confirmation_required",
      message:
        "Ask the caller to confirm the exact command before sending it to Claude Code.",
    });
  }

  if (!claudeBridgeUrl) {
    return reply.code(200).send({
      ok: false,
      status: "bridge_not_configured",
      message: "The Claude Code bridge is not connected yet.",
    });
  }

  const headers = { "content-type": "application/json" };
  if (claudeBridgeToken) {
    headers.authorization = `Bearer ${claudeBridgeToken}`;
  }

  const upstreamResponse = await fetch(claudeBridgeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command: body.command,
      working_directory: body.working_directory || body.workingDirectory || null,
      session_id: body.session_id || body.sessionId || null,
      caller_number: body.caller_number || body.callerNumber || null,
      source: "elevenlabs_voice_agent",
    }),
  });

  const upstreamText = await upstreamResponse.text();
  const upstreamBody = parseMaybeJson(upstreamText);

  if (!upstreamResponse.ok) {
    return reply.code(502).send({
      ok: false,
      status: "bridge_error",
      upstream_status: upstreamResponse.status,
      upstream_body: upstreamBody,
    });
  }

  return reply.code(200).send({
    ok: true,
    status: "forwarded",
    upstream_body: upstreamBody,
  });
}

async function handleRunCli(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;
  const body = request.body || {};
  const result = await runUniversalCli({
    command: body.command || body.cmd || body.shell_command || body.shellCommand,
    args: body.args,
    cwd: body.cwd || body.working_directory || body.workingDirectory,
    timeoutMs: body.timeout_ms || body.timeoutMs,
    confirmed: body.confirmed,
    env: body.env || body.environment,
    maxRawBytes: body.max_raw_bytes || body.maxRawBytes,
  });
  // Command outcomes are data; auth/transport failures use HTTP errors.
  return reply.code(200).send(result);
}

async function handleConversationRecentContext(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = await conversationRecentContext({
    limit: body.limit || body.max_results || body.maxResults,
  });

  return reply.code(toolResultStatusCode(result)).send(result);
}

async function handleConversationArchiveElevenLabs(request, reply) {
  if (!validateCliToolAuth(request, reply)) return;

  const body = request.body || {};
  const result = body.latest || body.latest_conversations || body.latestConversations
    ? await archiveLatestElevenLabsConversations({
        limit: body.limit || body.max_results || body.maxResults,
      })
    : await archiveElevenLabsConversation({
        conversationId: body.conversation_id || body.conversationId || body.id,
      });

  return reply.code(toolResultStatusCode(result)).send(result);
}

function toolResultStatusCode(result) {
  if (result.ok) return 200;
  if (
    [
      "confirmation_required",
      "conversation_history_not_configured",
      "cli_bridge_not_configured",
      "rss_feeds_not_configured",
      "tool_auth_not_configured",
      "command_blocked",
      "working_directory_not_allowed",
    ].includes(result.status)
  ) {
    return 200;
  }
  return 400;
}

function validateToolAuth(request, reply) {
  if (!webSearchToken) {
    reply.code(503).send({
      ok: false,
      status: "tool_auth_not_configured",
      message: "WEB_SEARCH_TOKEN is not configured on this server.",
    });
    return false;
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${webSearchToken}`)) {
    reply.code(401).send({ ok: false, status: "unauthorized" });
    return false;
  }

  return true;
}

function validateCliToolAuth(request, reply) {
  const expectedToken = cliBridgeToken || webSearchToken;
  if (!expectedToken) {
    reply.code(503).send({
      ok: false,
      status: "cli_tool_auth_not_configured",
      message:
        "CLI_BRIDGE_TOKEN is not configured on this server. WEB_SEARCH_TOKEN can be used only for local development.",
    });
    return false;
  }

  const authHeader = request.headers.authorization || "";
  if (!secureEquals(authHeader, `Bearer ${expectedToken}`)) {
    reply.code(401).send({ ok: false, status: "unauthorized" });
    return false;
  }

  return true;
}

function githubToolError(error) {
  return {
    ok: false,
    status: "github_tool_error",
    message: error?.message || "GitHub tool request failed.",
    entries: [],
  };
}

function isValidTwilioRequest(request) {
  if (!enforceTwilioSignature) return true;

  const signature = request.headers["x-twilio-signature"];
  if (!signature) return false;

  return validateRequest(
    twilioAuthToken,
    signature,
    publicRequestUrl(request),
    request.body || {}
  );
}

function isValidTwilioCallbackRequest(request) {
  if (process.env.TWILIO_WEBHOOK_TOKEN) {
    const token = request.query?.token;
    if (token !== process.env.TWILIO_WEBHOOK_TOKEN) return false;
  }

  return isValidTwilioRequest(request);
}

function isValidDiagnosticsRequest(request) {
  if (request.query?.token && request.query.token === process.env.TWILIO_WEBHOOK_TOKEN) {
    return true;
  }

  if (!webSearchToken) return false;

  const authHeader = request.headers.authorization || "";
  return secureEquals(authHeader, `Bearer ${webSearchToken}`);
}

function twilioCallbackUrl(request, pathname) {
  const url = new URL(publicRequestUrl(request));
  url.pathname = pathname;
  url.search = "";

  if (process.env.TWILIO_WEBHOOK_TOKEN) {
    url.searchParams.set("token", process.env.TWILIO_WEBHOOK_TOKEN);
  }

  return url.toString();
}

function publicRequestUrl(request) {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto || request.protocol || "https";
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const hostHeader = forwardedHost || request.headers.host;
  return `${proto}://${hostHeader}${request.url}`;
}

function redactUrlForLogs(value) {
  try {
    const url = new URL(String(value || ""), "https://phoneclaw.local");
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|key|password|signature/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value || "").replace(
      /([?&][^=]*(?:token|secret|key|password|signature)[^=]*=)[^&]*/gi,
      "$1[redacted]"
    );
  }
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value?.split(",")[0]?.trim();
}

function extractTwiml(text, contentType) {
  if (contentType.includes("application/json")) {
    const parsed = parseMaybeJson(text);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.twiml === "string") return parsed.twiml;
  }

  return text;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sayTwiml(message) {
  return `<Response><Say>${escapeXml(message)}</Say></Response>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
