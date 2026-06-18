# Cloudflare Worker Webhook

This Worker is the preferred public webhook layer for the phone prototype. It accepts Twilio webhook calls, registers each call with the ElevenLabs Twilio register-call API, and returns the TwiML that connects the live phone call to the agent.

## Configure

Copy the example config to the repo root:

```bash
cp cloudflare-worker/wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` with your own Cloudflare account, route, ElevenLabs agent ID, and Twilio phone number. Keep `wrangler.toml` uncommitted.

Set secrets:

```bash
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put COMMAND_BRIDGE_TOKEN
wrangler secret put TWILIO_WEBHOOK_TOKEN
```

Deploy from the repo root:

```bash
npm run worker:deploy
```

## Endpoints

- `GET /health`
- `POST /twilio/inbound`
- `POST /twilio/outbound`
- `GET|POST /twilio/test-say`
- `POST /agent-command`
