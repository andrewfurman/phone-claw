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
- `/var/lib/phoneclaw/claude-jobs/`

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
CLAUDE_CODE_ALLOWED_DIRS=/opt/phoneclaw
```

The `claude_code` voice tool is intentionally explicit. It can check auth, create a session id, submit a confirmed async job, and poll job status. It should not be used as the default path for ordinary questions.
