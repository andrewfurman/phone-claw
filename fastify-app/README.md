# Fastify App

The Fastify app is the local development version of the webhook. It mirrors the Worker flow and is useful for local testing with a tunnel.

## Run

From the repo root:

```bash
npm install
cp .env.example .env
npm start
```

Health check:

```bash
curl http://localhost:8000/health
```

The application tool interface is `POST /cli/run`. It accepts an executable `command`, literal `args`, optional `cwd`, exact `confirmed`, timeout and output limits. Native executables run directly; `phoneclaw` commands preserve existing provider workflows through the shared registry.

Twilio webhooks, diagnostics, call-memory context and archive endpoints remain infrastructure. Old specialized tool URLs are deprecated compatibility aliases, enabled until `PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES=false`. They are not needed for new integrations.

See [Universal CLI setup and migration](../docs/UNIVERSAL_CLI.md), the [command guide](../elevenlabs-setup/prompt-templates/universal-cli.md), and [security rules](../docs/CLI_BRIDGE_SECURITY.md).

## Expose Locally

Twilio needs a public HTTPS URL. For local experiments:

```bash
npm run tunnel
```

Then point Twilio at:

```text
https://YOUR_PUBLIC_TUNNEL_URL/twilio/inbound
```

For anything beyond quick testing, prefer the Cloudflare Worker.
