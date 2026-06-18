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
wrangler secret put ALLOWED_CALLER_NUMBERS
wrangler secret put OUTSIDE_COVERAGE_MESSAGE
wrangler secret put WEB_SEARCH_TOKEN
wrangler secret put GITHUB_READ_TOKEN
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
- `POST /web-search`
- `POST /github-summary`
- `POST /agent-command`

## Caller Allow-List

Set `ALLOWED_CALLER_NUMBERS` to a comma-separated list of E.164 phone numbers that may reach the ElevenLabs agent. Store real personal phone numbers as Worker secrets, not in committed config.

When an inbound caller is not allow-listed, the Worker returns a short TwiML message and does not call ElevenLabs.

## Web Search Tool

`POST /web-search` is a basic authenticated webhook tool for ElevenLabs. It uses DuckDuckGo public endpoints and returns compact search results plus an `answer_text` field for voice responses.

When the query clearly asks for FIFA World Cup soccer schedules or scores, the tool also adds a small structured `sports_events` enrichment from ESPN's public scoreboard endpoint. Treat that as a prototype convenience, not a long-term sports-data contract.

For production-quality search, replace this with a paid search API such as Tavily, Exa, Brave Search, Bing, or Google Programmable Search.

## GitHub Summary Tool

`POST /github-summary` is an authenticated ElevenLabs webhook tool for read-only GitHub issue and pull request summaries. The Worker calls GitHub with `GITHUB_READ_TOKEN`, which must be stored as a Worker secret.

Supported request fields:

- `item_type`: `issues` or `pull_requests`
- `scope`: `involved`, `assigned`, `authored`, `mentioned`, or `review_requested`
- `max_results`: 1 to 8

The response includes `total_count`, compact `items`, and a voice-friendly `answer_text`.
