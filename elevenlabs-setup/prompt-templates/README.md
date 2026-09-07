# ElevenLabs Prompt Templates

Sample markdown snippets you can paste into an ElevenLabs Conversational AI agent prompt. They describe the configured virtual-machine CLI tools behind phone-claw (including the additive generic run_cli tool) and the common command patterns the voice agent should follow.

These templates are grounded in the live public-safe agent snapshot (`andrew-assistant-agent.config.json`), the Fastify bridge tools, and the docs under `docs/`. They are not a full replacement for the exported agent prompt; use them when bootstrapping a new agent or refreshing one capability section.

## Files

| File | Use when |
| --- | --- |
| [vm-cli-tools.md](vm-cli-tools.md) | You need a compact description of which CLI tools run on the private VM bridge and how auth works. |
| [common-command-patterns.md](common-command-patterns.md) | You need reusable voice-safe patterns for GitHub, email, Otter, RSS, URL fetch, conversation memory, and Claude Code. |
| [confirmation-and-safety.md](confirmation-and-safety.md) | You need the confirmation gates, id-speaking rules, and emergency-send constraints. |

## How To Apply

1. Open the ElevenLabs agent prompt editor for your Conversational AI agent.
2. Paste the relevant section(s) into the system prompt. Prefer merging one capability block at a time.
3. Keep webhook tools attached and authenticated against the Cloudflare Worker, not directly against the VM.
4. After editing, export a public-safe agent snapshot with the repo export script (`elevenlabs:agent:export`).
5. For telephony agents, keep ASR/TTS at `ulaw_8000` (audio check script: `elevenlabs:audio:check`).

## Prerequisites

The CLI-backed tools only work when the private bridge is deployed:

- VM + Fastify bridge on `127.0.0.1:8000`
- Cloudflare Tunnel hostname in Worker `CLI_BRIDGE_URL`
- Matching `CLI_BRIDGE_TOKEN` on Worker and bridge
- CLI auth as the `phoneclaw` service user where needed

See [../../docs/VM_BRIDGE_SETUP_GUIDE.md](../../docs/VM_BRIDGE_SETUP_GUIDE.md).

## Placeholders Only

Do not paste real secrets, bridge tokens, phone numbers, private feed URLs, or CLI auth files into these templates or into Git. Use placeholders such as `<cli-bridge-token>` and `https://cli-bridge.example.com`.
