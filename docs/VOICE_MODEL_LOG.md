# Voice model and turn-timing log

Changes to the ElevenLabs agent's voice (TTS) and turn-timing settings, which live in the ElevenLabs dashboard/API
rather than in code. The repo snapshot is `elevenlabs-setup/andrew-assistant-agent.config.json`; refresh it with
`setup-and-testing-scripts/export-elevenlabs-agent-config.mjs` after dashboard edits.

## 2026-10-05: back to Flash v2, fixed "One moment." filler after 3 seconds

**Why.** Andrew switched the agent to Eleven v4 in the dashboard (no commit) and heard "uh/um" fillers and echoey
audio on calls. Two dashboard changes explained it:

| Setting | Before (v4 trial) | After |
| --- | --- | --- |
| `tts.model_id` | `eleven_v4` | `eleven_flash_v2` |
| `tts.expressive_mode` | `true` | `false` |
| `tts.similarity_boost` | `0.75` | `0.9` |
| `turn.soft_timeout_config.timeout_seconds` | `2` | `3` |
| `turn.soft_timeout_config.use_llm_generated_message` | `true` (LLM wrote its own filler) | `false` |
| `turn.soft_timeout_config.message` | `Hhmmmm...yeah.` | `One moment.` |

Unchanged: voice `wfJ7pHCS3lXZdaz77rIG` (Jessi), `stability` 0.75, `speed` 1.0, `optimize_streaming_latency` 3,
`agent_output_audio_format` `ulaw_8000` (Twilio's 8 kHz μ-law).

- **Fillers:** the soft timeout with `use_llm_generated_message: true` let the LLM invent a filler whenever a reply took
  more than 2 seconds, and Eleven v4's expressive mode adds hesitations of its own. ElevenLabs has no v4 "no
  disfluencies" switch. Andrew still wants a cue when the agent is thinking, so the timeout stays on at 3 seconds with
  a fixed, plain line.
- **Echo:** no published reports; likely v4's expressive, breathy delivery losing quality at 8 kHz μ-law, plus a voice
  whose high-quality models are the v2 family. Flash v2 (about 75 ms to first audio) is still ElevenLabs' recommended
  low-latency agent model and is not deprecated.
- **Applied** with `PATCH /v1/convai/agents/{agent_id}` run on the bridge (key from `/etc/phoneclaw/bridge.env`, never
  printed), then read back.
- **If v4 is tried again:** use `eleven_v4_turbo` with `expressive_mode: false`, keep the fixed soft-timeout message, and
  A/B it against Flash v2 on a real call.

**Test.** Full phone test `test-twilio-call.mjs --place-call` from the bridge (deployed revision `17e0624`): all checks
passed (`twilio_completed`, `conversation_correlated`, `conversation_finalized`, `run_cli_ok`, `expected_policy`,
`expected_directory`, `user_audio_transcribed`). Conversation `conv_8101m45ysq2petr953b6cxzhs49h`, 57 s. The agent
said "One moment." while the tool ran and no filler words appeared in its lines. Audio quality still needs Andrew's
own call to judge.
