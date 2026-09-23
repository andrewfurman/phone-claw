# CLI Bridge Security

phone-claw exposes public ElevenLabs webhook tools through the Cloudflare Worker. A normal Worker cannot run local binaries such as `himalaya`, `otter`, or `gh`, and it should not store copied CLI credential files from a laptop.

## Recommended Shape

Use two layers:

1. Public Cloudflare Worker at `https://webhooks.aifurman.com`.
2. Private Fastify CLI bridge running on a VM/container that has the CLIs installed and authenticated.

The Worker validates the ElevenLabs tool bearer token, then proxies CLI calls to the private bridge with a separate `CLI_BRIDGE_TOKEN`.

## Credential Placement

Do not commit or log these files:

- `~/.config/himalaya`
- `~/.otterai`
- `~/.config/gh`
- `~/.claude`
- system keychain exports
- `.env`

For the bridge host, authenticate each CLI under a restricted service user:

- `himalaya account configure` or copy a minimal Himalaya config through an encrypted secret channel.
- `otter login` on the host, or copy only the required Otter config through an encrypted secret channel.
- `gh auth login` as the service user, with only the scopes and organization approvals required for the repositories the assistant should access.
- `claude auth login` as the service user, or an Anthropic API key in the bridge env.

Prefer a VM/container secret manager over baking credentials into an image.

## Required Environment

On the Worker:

```text
WEB_SEARCH_TOKEN=...
CLI_BRIDGE_URL=https://private-cli-bridge.example.com
CLI_BRIDGE_TOKEN=...
```

On the Fastify bridge:

```text
CLI_BRIDGE_TOKEN=...
HIMALAYA_BIN=himalaya
HIMALAYA_SEND_TIMEOUT_MS=8000
OTTER_BIN=otter
GH_BIN=gh
GITHUB_USERNAME=andrewfurman
CLAUDE_BIN=claude
CLAUDE_CODE_JOB_DIR=/var/lib/phoneclaw/claude-jobs
CLAUDE_CODE_STEERING_DIR=/var/lib/phoneclaw/claude-steering
CLAUDE_CODE_ALLOWED_DIRS=/opt/phoneclaw
CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true
AWS_PROFILE=phoneclaw-personal
CONVERSATION_DATABASE_URL=postgres://...
```

For local development only, the bridge can fall back to `WEB_SEARCH_TOKEN` if `CLI_BRIDGE_TOKEN` is unset. Production should set `CLI_BRIDGE_TOKEN`.

## Who can reach PhoneClaw (verified 2026-09-23)

Three independent gates; keep all of them on.

1. **Phone calls go only through the Cloudflare Worker** (`webhooks.aifurman.com/twilio/inbound`).
   - `TWILIO_WEBHOOK_TOKEN` is required: a request without the token baked into the Twilio webhook URL gets 403 (a forged POST with any From/To was rejected).
   - `ALLOWED_CALLER_NUMBERS` is set: only listed callers reach the agent; others hear the outside-coverage message. Andrew's cell (ending 9996) is on the list and is also the verified caller ID the automated Twilio tests use (`TWILIO_TEST_FROM`), so keep it listed or both break. In the 30 days before verification, the only other caller (ending 6413, six short calls on Sep 7) never reached the agent.
2. **The bridge's own Twilio call routes are off** (#138). `cli-bridge.aifurman.com` is public through the tunnel; its `/twilio/inbound|outbound|stream-status|call-status` routes exist only with `PHONECLAW_BRIDGE_TWILIO_ROUTES=true`, because that code path has no token or allowlist on the bridge. `/health` reports `bridge_twilio_routes_enabled`.
3. **The ElevenLabs agent requires authorization** (`platform_settings.auth.enable_auth: true`). The agent id is in this public repo, so without this anyone could open a conversation (and use its tools) directly through ElevenLabs. With it, a public connection closes with "This agent requires conversations to be authorized"; Twilio `register-call` (server-side, API key) and the live test scripts (signed URLs) keep working. A backup of the previous platform settings is at `/var/lib/phoneclaw/agent-backups/` on the bridge.

Re-verify after any Worker, agent, or tunnel change: unauthenticated POST to both hostnames' `/twilio/inbound` (expect 403/404), the public agent WebSocket (expect close code 3000), then `npm run twilio:call:test -- --universal --place-call`.

## Lockdown Checklist

- Keep the bridge off the public internet when possible. Put it behind a Cloudflare Tunnel, private network, or firewall rule that only allows Cloudflare egress.
- Use a long random `CLI_BRIDGE_TOKEN` that is different from `WEB_SEARCH_TOKEN`.
- Run the bridge as a non-admin service user with only the CLI config files it needs.
- Keep CLI tools read-only by default. Any write tool must be narrowly scoped and confirmation-gated. Email archive/draft tools cannot send mail; `create_reply_all_draft` and `create_forward_draft` save drafts only, preserve original content inline, and do not send or attach the original `.eml`. `himalaya_email_images` is a separate read-only inspection tool and returns image bytes only when explicitly requested. `url_fetch` is limited to public HTTP/HTTPS URLs, blocks localhost/private-network destinations, and requires confirmation for unsubscribe or preference-management URLs. Emergency sends are isolated in `himalaya_email_send` and require `emergency=true`, an exact verbal preview, and a second confirmation. The emergency send path should use a short `HIMALAYA_SEND_TIMEOUT_MS` so SMTP hangs fail with an explicit unconfirmed-send result instead of tying up a voice turn. Claude Code task submission is also confirmation-gated and runs asynchronously.
- For Gmail-backed emergency sends, set Himalaya `message.send.save-copy = false` and point `folder.aliases.sent` at `[Gmail]/Sent Mail`. Gmail SMTP stores sent mail automatically; the extra IMAP sent-copy step can fail or hang after a successful SMTP send.
- Cap command output and timeouts. Specialized tools use fixed `execFile` invocations. The `run_cli` / `POST /cli/run` path requires confirmation by default. Only `pwd` (optionally `-L` or `-P`) and `ls` with flags `a`, `A`, `l`, `h`, `1`, `d` run without confirmation; select paths through `cwd`. These unconfirmed commands execute directly from `/bin`, without shell or PATH lookup. All other commands, including other reads, need exact confirmation. Confirmed commands use Bash with `--noprofile --norc -c`, a real environment allowlist, bounded output/timeouts, and best-effort secret blocks/redaction. Real-path checks accept roots/descendants and reject symlinks outside them. This constrains the starting directory, not all filesystem access: a confirmed arbitrary command is trusted code running with the service user's permissions, not an OS sandbox.
- Rotate Otter, email, GitHub, and bridge tokens if they are ever pasted into chat, logs, or a public issue.

## Current EC2 Hardening

The live bridge host is configured so the Fastify service listens on `127.0.0.1:8000`, not a public interface. Cloudflare Tunnel is the public ingress path for bridge traffic, and the bridge still requires `CLI_BRIDGE_TOKEN` on every CLI/Claude/conversation-history request.

Inbound network access is restricted at two layers:

- AWS security group: SSH only from Andrew's current public IP.
- UFW on the instance: default deny incoming, allow outgoing, SSH only from Andrew's current public IP.

There are no public inbound HTTP or HTTPS ports for the Fastify bridge.

Claude Code run jobs are intentionally configured with `CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true` on this host so confirmed jobs do not hang on permission prompts. That setting is acceptable only because tool access is behind the Worker, Cloudflare Tunnel, bearer-token bridge auth, an allow-listed working directory, and explicit voice confirmation before task submission.

Interactive unsubscribe and preference-center flows use that same `claude_code` async job path instead of a separate browser-job API. The ElevenLabs prompt requires the agent to identify the exact email/link, get Andrew's confirmation, try `url_fetch` for static verification, and only then submit a Claude Code task that uses Playwright/headless browser. Those jobs should stop on login walls, CAPTCHA, payment/checkout flows, account deletion, security settings, or ambiguous destructive actions.

## Why Not Put CLI Credentials Into A Worker?

Workers are good for request routing, auth checks, and API calls. They are not a good fit for these CLI tools because they cannot spawn local processes or rely on a local keyring/home directory. Copying laptop CLI state into Worker secrets would also make credential rotation and auditing harder.


## Universal runner migration

`run_cli` is now the only application tool. Existing protected workflows are
`phoneclaw` CLI commands over the same adapter registry; legacy URLs are temporary
compatibility aliases. Literal native `args` never enter a shell. Exact approved
argument lists may run unconfirmed; every other native invocation requires exact
confirmation. Per-program credential names are operator configuration, with
bridge control credentials and runtime injection keys forbidden. Unknown programs
and raw shell invocations retain the filtered generic environment. Embedded JSON
cannot supply confirmation. The universal layer also gates email mark-seen.

Native process groups are killed on timeout/output overflow. Domain workflows
retain provider-specific timeouts and persistent async jobs; an outer deadline
cannot establish whether a remote write occurred. Redaction covers known provider
secret values as well as token patterns. See [UNIVERSAL_CLI.md](UNIVERSAL_CLI.md)
for output budgets, credential configuration, migration and rollback details.
