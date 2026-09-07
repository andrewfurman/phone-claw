# Easy Virtual Machine / Bridge Setup Guide

This guide walks through standing up the private Fastify CLI bridge on an Ubuntu VM so ElevenLabs webhook tools can reach local CLIs through Cloudflare Tunnel. It is the short how-to companion to [EC2_BARE_METAL_BRIDGE.md](EC2_BARE_METAL_BRIDGE.md) and [CLI_BRIDGE_SECURITY.md](CLI_BRIDGE_SECURITY.md).

Target shape:

```text
Twilio -> ElevenLabs -> Cloudflare Worker -> Cloudflare Tunnel -> VM Fastify bridge
```

The Fastify app listens on `127.0.0.1:8000` only. Cloudflare Tunnel is the public ingress. Do not open inbound HTTP/HTTPS on the VM.

## What You Need

- An Ubuntu 24.04 LTS x86_64 VM (`t3.small` or larger, 20 GB encrypted disk is a good baseline).
- SSH access restricted to your current public IP.
- A Cloudflare account that can create a Tunnel hostname such as `https://cli-bridge.example.com`.
- Placeholders ready for secrets (never commit real values):
  - `CLI_BRIDGE_TOKEN=<long-random-bridge-token>`
  - Cloudflare tunnel token
  - Optional: `GH_TOKEN`, Anthropic/Claude auth, Himalaya/Otter configs, `CONVERSATION_DATABASE_URL`

## 1. Launch The VM

1. Create an Ubuntu 24.04 instance.
2. Attach a security group that allows SSH from your IP only.
3. Leave HTTP/HTTPS closed.
4. Paste `deploy/ec2-user-data.sh` as EC2 user data (or run the same steps manually on a non-AWS Ubuntu host).

The user-data script installs Node.js, `gh`, `cloudflared`, creates the `phoneclaw` service user, clones the repo under `/opt/phoneclaw`, writes a starter `/etc/phoneclaw/bridge.env`, installs Himalaya/Otter via Cargo when possible, and enables `phoneclaw-bridge.service`.

## 2. Lock Down The Host

On the VM:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR.PUBLIC.IP.HERE to any port 22 proto tcp
sudo ufw enable
```

Confirm Fastify is bound to localhost only:

```bash
ss -ltnp | grep 8000 || true
curl -sS http://127.0.0.1:8000/health
```

## 3. Configure Bridge Secrets

Edit the bridge env as root:

```bash
sudoedit /etc/phoneclaw/bridge.env
```

Minimum production values:

```text
HOST=127.0.0.1
PORT=8000
CLI_BRIDGE_TOKEN=<long-random-bridge-token>
HIMALAYA_BIN=/home/phoneclaw/.cargo/bin/himalaya
OTTER_BIN=/home/phoneclaw/.cargo/bin/otter
GH_BIN=/usr/bin/gh
GITHUB_USERNAME=<your-github-username>
HIMALAYA_SEND_TIMEOUT_MS=8000
```

Optional Claude Code / memory settings (placeholders only):

```text
ANTHROPIC_API_KEY=<anthropic-api-key-or-omit-if-using-claude-login>
CLAUDE_BIN=claude
CLAUDE_CODE_JOB_DIR=/var/lib/phoneclaw/claude-jobs
CLAUDE_CODE_STEERING_DIR=/var/lib/phoneclaw/claude-steering
CLAUDE_CODE_ALLOWED_DIRS=/opt/phoneclaw
CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true
CLAUDE_CODE_PERMISSION_MODE=bypassPermissions
AWS_PROFILE=phoneclaw-personal
CONVERSATION_DATABASE_URL=postgres://USER:PASSWORD@HOST/DB?sslmode=require
RSS_FEEDS_CONFIG_PATH=/etc/phoneclaw/rss-feeds.json
```

Then:

```bash
sudo chown root:phoneclaw /etc/phoneclaw/bridge.env
sudo chmod 0640 /etc/phoneclaw/bridge.env
sudo systemctl restart phoneclaw-bridge
sudo systemctl status phoneclaw-bridge
```

## 4. Authenticate CLI Tools As `phoneclaw`

Run each login as the service user so credentials land in the right home directory:

```bash
sudo -iu phoneclaw
gh auth login
# Optional Claude first-party login:
claude auth login
# Himalaya and Otter: configure under ~/.config/himalaya and ~/.otterai
exit
```

For Gmail-backed Himalaya, set folder aliases and disable the extra sent-copy save:

```toml
folder.aliases.inbox = "INBOX"
folder.aliases.sent = "[Gmail]/Sent Mail"
folder.aliases.drafts = "[Gmail]/Drafts"
folder.aliases.trash = "[Gmail]/Trash"
message.send.save-copy = false
```

Do not copy laptop keyrings into images or into Cloudflare Worker secrets. Prefer host-local files under `/home/phoneclaw/` and `/etc/phoneclaw/`.

## 5. Connect Cloudflare Tunnel

1. Create a Cloudflare Tunnel that routes `https://cli-bridge.example.com` to `http://127.0.0.1:8000`.
2. Store the tunnel token in `/etc/cloudflared/phoneclaw.env` (mode `0640`, owned so only the connector can read it).
3. Enable and start `phoneclaw-cloudflared.service`.

Check both services:

```bash
sudo systemctl status phoneclaw-bridge
sudo systemctl status phoneclaw-cloudflared
journalctl -u phoneclaw-bridge -f
journalctl -u phoneclaw-cloudflared -f
```

Public health check (replace the hostname):

```bash
curl -sS https://cli-bridge.example.com/health
```

## 6. Point The Worker At The Bridge

On the Cloudflare Worker, set:

```text
CLI_BRIDGE_URL=https://cli-bridge.example.com
CLI_BRIDGE_TOKEN=<same-token-as-bridge.env>
```

Use `wrangler secret put` for both. The Worker must validate the ElevenLabs tool bearer token first, then forward bridge calls with `CLI_BRIDGE_TOKEN`. Keep `CLI_BRIDGE_TOKEN` different from `WEB_SEARCH_TOKEN`.

## 7. Smoke-Test Bridge Routes

From a machine that can reach the Worker (or with a temporary authenticated probe), verify at least:

- `GET /health` on the tunnel hostname
- Himalaya list path through the Worker proxy
- Otter speeches list
- GitHub common / summary
- `claude_code` with `{"action":"auth_status"}` if Claude is configured

If a tool returns `cli_bridge_not_configured`, the public Worker is up but `CLI_BRIDGE_URL` / tunnel / bridge auth is still missing.

## 8. Optional Add-Ons

### Configured RSS feeds

```bash
sudo install -d -m 0750 -o phoneclaw -g phoneclaw /etc/phoneclaw
sudo install -m 0640 -o phoneclaw -g phoneclaw /dev/null /etc/phoneclaw/rss-feeds.json
```

Use placeholder private URLs only in the host file, never in Git. See the RSS section in [EC2_BARE_METAL_BRIDGE.md](EC2_BARE_METAL_BRIDGE.md).

### Conversation archive timer

```bash
sudo cp deploy/phoneclaw-conversation-archive.service /etc/systemd/system/
sudo cp deploy/phoneclaw-conversation-archive.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phoneclaw-conversation-archive.timer
```

## Checklist

- [ ] Ubuntu VM running with SSH locked to your IP
- [ ] No public bridge HTTP/HTTPS ports
- [ ] `phoneclaw-bridge` healthy on `127.0.0.1:8000`
- [ ] Cloudflare Tunnel publishing the bridge hostname
- [ ] Matching `CLI_BRIDGE_TOKEN` on Worker and VM
- [ ] `gh` / Himalaya / Otter / Claude authenticated as `phoneclaw` as needed
- [ ] ElevenLabs tools still pointing at the Worker (not directly at the VM)
- [ ] Prompt templates reviewed under [../elevenlabs-setup/prompt-templates/](../elevenlabs-setup/prompt-templates/)

## Related Docs

- [EC2_BARE_METAL_BRIDGE.md](EC2_BARE_METAL_BRIDGE.md) — full EC2 architecture and validation notes
- [CLI_BRIDGE_SECURITY.md](CLI_BRIDGE_SECURITY.md) — credential placement and lockdown checklist
- [SETUP_LOG.md](SETUP_LOG.md) — prototype chronology without live secrets
- [../elevenlabs-setup/README.md](../elevenlabs-setup/README.md) — agent/tool configuration
- [../elevenlabs-setup/prompt-templates/](../elevenlabs-setup/prompt-templates/) — sample ElevenLabs prompt snippets for VM CLI tools
