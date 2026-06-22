import {
  ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
  audioFormatStatus,
} from "../shared/telephony-audio-format.mjs";

const shouldFix = process.argv.includes("--fix");
const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const status = getStatus(agent);

if (isGood(status)) {
  console.log(JSON.stringify({ ok: true, ...status }, null, 2));
  process.exit(0);
}

if (!shouldFix) {
  console.error(JSON.stringify({ ok: false, ...status }, null, 2));
  process.exit(2);
}

const conversationConfig = agent.conversation_config || {};
const body = {
  conversation_config: {
    ...conversationConfig,
    asr: {
      ...(conversationConfig.asr || {}),
      user_input_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
    },
    tts: {
      ...(conversationConfig.tts || {}),
      agent_output_audio_format: ELEVENLABS_TELEPHONY_AUDIO_FORMAT,
    },
  },
  version_description: `Set Twilio telephony audio formats to ${ELEVENLABS_TELEPHONY_AUDIO_FORMAT}`,
};

await requestJson(`${apiBase}/v1/convai/agents/${agentId}`, {
  method: "PATCH",
  body: JSON.stringify(body),
});

const updatedAgent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const updatedStatus = getStatus(updatedAgent);
console.log(JSON.stringify({ ok: isGood(updatedStatus), ...updatedStatus }, null, 2));
process.exit(isGood(updatedStatus) ? 0 : 2);

function getStatus(agent) {
  const config = agent.conversation_config || {};
  return audioFormatStatus({
    asrFormat: config.asr?.user_input_audio_format,
    ttsFormat: config.tts?.agent_output_audio_format,
  });
}

function isGood(status) {
  return (
    status.asr_matches_expected &&
    status.tts_matches_expected &&
    status.formats_match_each_other
  );
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const parsed = parseMaybeJson(text);

  if (!response.ok) {
    throw new Error(
      `ElevenLabs request failed (${response.status}): ${JSON.stringify(parsed)}`
    );
  }

  return parsed;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
