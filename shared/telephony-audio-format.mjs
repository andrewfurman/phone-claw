export const ELEVENLABS_TELEPHONY_AUDIO_FORMAT =
  typeof process === "undefined"
    ? "ulaw_8000"
    : process.env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || "ulaw_8000";

export function audioFormatStatus({ asrFormat, ttsFormat }) {
  const expected = ELEVENLABS_TELEPHONY_AUDIO_FORMAT;

  return {
    expected,
    asr_user_input_audio_format: asrFormat || null,
    tts_agent_output_audio_format: ttsFormat || null,
    asr_matches_expected: asrFormat === expected,
    tts_matches_expected: ttsFormat === expected,
    formats_match_each_other: Boolean(asrFormat) && asrFormat === ttsFormat,
  };
}
