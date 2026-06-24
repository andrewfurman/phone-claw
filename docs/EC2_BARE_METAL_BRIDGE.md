# EC2 Bare-Metal CLI Bridge

The long-running CLI bridge can run directly on an EC2 VM without Docker.

## Architecture

```text
Twilio -> ElevenLabs -> Cloudflare Worker -> Cloudflare Tunnel -> EC2 Fastify bridge
```

The EC2 instance runs:

- `phoneclaw-bridge.service`: Fastify app bound to `127.0.0.1:8000`.
- `phoneclaw-cloudflared.service`: Cloudflare Tunnel connector.
- CLI tools under the `phoneclaw` service user:
  - `himalaya`
  - `otter`
  - `gh`
  - `aws`
  - `railway`
  - `vercel`
  - `wrangler`
  - `claude`

The Fastify port is not opened to the internet. Cloudflare Tunnel publishes the bridge hostname and forwards traffic to localhost on the VM.

## Provisioning

Use `deploy/ec2-user-data.sh` as EC2 user data when launching an Ubuntu 24.04 instance.

Recommended baseline:

- Ubuntu 24.04 LTS, x86_64.
- `t3.small` or larger.
- 20 GB encrypted gp3 root volume.
- Security group with SSH restricted to Andrew's current IP only.
- No inbound HTTP/HTTPS ports.
- UFW enabled with default deny incoming, allow outgoing, and SSH restricted to Andrew's current IP only.

## Secrets

Do not commit any of these:

- AWS access keys.
- SSH private keys.
- Cloudflare tunnel token.
- `CLI_BRIDGE_TOKEN`.
- `GH_TOKEN`.
- Himalaya config.
- Otter config.
- Claude Code auth files or Anthropic API keys.

Runtime secrets live on the host:

- `/etc/phoneclaw/bridge.env`
- `/etc/cloudflared/phoneclaw.env`
- `/home/phoneclaw/.config/himalaya/config.toml`
- `/home/phoneclaw/.otterai/config.json`
- `/home/phoneclaw/.claude/` or `ANTHROPIC_API_KEY` in `/etc/phoneclaw/bridge.env`
- `/home/phoneclaw/.aws/`
- `/var/lib/phoneclaw/claude-jobs/`

Common bridge environment settings include:

```text
HIMALAYA_SEND_TIMEOUT_MS=8000
```

For the Gmail-backed Himalaya account, configure Gmail's real folder aliases and avoid the extra sent-copy save:

```toml
folder.aliases.inbox = "INBOX"
folder.aliases.sent = "[Gmail]/Sent Mail"
folder.aliases.drafts = "[Gmail]/Drafts"
folder.aliases.trash = "[Gmail]/Trash"
message.send.save-copy = false
```

phone-claw sends raw emergency messages to `himalaya message send` through stdin. Passing raw MIME as a positional argument can trigger a Himalaya/mail-parser panic, and Gmail SMTP already stores sent mail, so `message.send.save-copy = false` avoids both parser and sent-copy failures.

## Services

Check status:

```bash
sudo systemctl status phoneclaw-bridge
sudo systemctl status phoneclaw-cloudflared
```

Restart after config changes:

```bash
sudo systemctl restart phoneclaw-bridge
sudo systemctl restart phoneclaw-cloudflared
```

View logs:

```bash
journalctl -u phoneclaw-bridge -f
journalctl -u phoneclaw-cloudflared -f
```

## Worker Settings

The Worker needs:

```text
CLI_BRIDGE_URL=https://cli-bridge.aifurman.com
CLI_BRIDGE_TOKEN=<same token as /etc/phoneclaw/bridge.env>
```

The Worker validates the ElevenLabs tool bearer token first, then forwards bridge calls to EC2 with `CLI_BRIDGE_TOKEN`.

## Current Validation

Validation should cover:

- `GET https://cli-bridge.aifurman.com/health`
- Worker proxy call to `/cli/himalaya/email-list`
- Worker proxy call to `/cli/himalaya/email-send` validation path; SMTP timeouts should return an explicit unconfirmed-send result within `HIMALAYA_SEND_TIMEOUT_MS`, not a gateway timeout.
- Worker proxy call to `/cli/otter/speeches-list`
- Worker proxy call to `/cli/otter/speech-get`
- Worker proxy call to `/cli/github/common`
- Worker proxy call to `/cli/claude-code` with `{"action":"auth_status"}`
- ElevenLabs WebSocket conversation using `otter_speeches_list` and `himalaya_email_list`

## Claude Code

Install Claude Code on the bridge host and authenticate it as the `phoneclaw` service user:

```bash
sudo npm install -g @anthropic-ai/claude-code
sudo -iu phoneclaw claude auth login
```

Alternatively, store an Anthropic API key in `/etc/phoneclaw/bridge.env`:

```text
ANTHROPIC_API_KEY=...
CLAUDE_BIN=claude
CLAUDE_CODE_JOB_DIR=/var/lib/phoneclaw/claude-jobs
CLAUDE_CODE_STEERING_DIR=/var/lib/phoneclaw/claude-steering
CLAUDE_CODE_ALLOWED_DIRS=/opt/phoneclaw
CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true
CLAUDE_CODE_PERMISSION_MODE=bypassPermissions
AWS_PROFILE=phoneclaw-personal
```

The `claude_code` voice tool is intentionally explicit. It can check auth, create a session id, submit a confirmed async job, append confirmed steering instructions to an existing session or job, and poll job status. It should not be used as the default path for ordinary questions.

Steering instructions are stored as session-scoped JSONL records under `CLAUDE_CODE_STEERING_DIR`. When a job starts, the bridge includes that file path in the Claude Code prompt and instructs Claude to re-read it before planning, editing, verification, and final response. This gives Andrew a way to keep shaping an active Claude Code session from the phone agent instead of submitting a task once and losing the thread.

Run-mode jobs use Claude Code `bypassPermissions` plus `--dangerously-skip-permissions` when `CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true`, so they do not stall on permission prompts.

## Configured RSS Feeds

phone-claw can expose any public or private RSS/Atom feed to the voice agent through generic tools. Store private URLs in a host-local JSON file, not in Git:

```bash
sudo install -d -m 0750 -o phoneclaw -g phoneclaw /etc/phoneclaw
sudo install -m 0640 -o phoneclaw -g phoneclaw /dev/null /etc/phoneclaw/rss-feeds.json
```

Example file shape:

```json
{
  "feeds": [
    {
      "id": "private-news",
      "title": "Private News Feed",
      "url": "https://feeds.example.com/latest.atom?token=replace-with-private-token",
      "private": true,
      "cache_seconds": 900
    }
  ]
}
```

Then set the bridge env and restart:

```bash
RSS_FEEDS_CONFIG_PATH=/etc/phoneclaw/rss-feeds.json
RSS_FEEDS_CACHE_SECONDS=900
RSS_FEEDS_TIMEOUT_MS=12000
```

The generic RSS tools fetch feed XML only and cache it on the phone-claw bridge. They do not run publisher-specific scrapers, browser sessions, or article extraction code.

## External RSS Feed Services

Run publisher-specific RSS generation on separate infrastructure from the core phone-claw EC2 bridge. For example, a separate EC2 instance or service can own subscriber cookies, browser automation, article extraction, or publisher-specific retry logic, then expose a private RSS/Atom URL.

phone-claw should consume that output only through `RSS_FEEDS_CONFIG_PATH` or `RSS_FEEDS_JSON`. This keeps the core voice/CLI bridge free of publisher credentials and lets each feed service be secured, scaled, rotated, and audited independently.

## Conversation Memory

The bridge has config-gated Postgres support for archived phone conversations. Set `CONVERSATION_DATABASE_URL` in `/etc/phoneclaw/bridge.env`, restart `phoneclaw-bridge`, then backfill recent calls:

```bash
cd /opt/phoneclaw
npm run conversations:archive
```

For automatic post-call logging, install the timer units from the repo:

```bash
sudo cp deploy/phoneclaw-conversation-archive.service /etc/systemd/system/
sudo cp deploy/phoneclaw-conversation-archive.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phoneclaw-conversation-archive.timer
```

The Worker also best-effort triggers `conversation-history/archive-elevenlabs` when Twilio reports a terminal call status. The timer is the retry backstop so late ElevenLabs transcripts are still archived.

If the database URL is missing, conversation-history endpoints return `conversation_history_not_configured` with HTTP 200 so the voice agent can explain the missing setup without treating it as a transport failure.
