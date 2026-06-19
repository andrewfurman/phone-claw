# Twilio Setup

## CLI

Install and authenticate the Twilio CLI outside the repository:

```bash
npm install -g twilio-cli
twilio login
```

Or use environment variables outside committed files. The CLI supports either Account SID/Auth Token or Account SID/API Key/API Secret:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
```

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_API_KEY=SK...
export TWILIO_API_SECRET=...
```

The saved `twilio profiles:create` flow requires the account Auth Token. If you only have an API Key SID and API Secret, load those environment variables before running CLI commands.

## Number

Search for a voice-capable number:

```bash
twilio api:core:available-phone-numbers:local:list \
  --country-code US \
  --voice-enabled \
  --limit 5
```

Buy one:

```bash
twilio api:core:incoming-phone-numbers:create \
  --phone-number +15555550123
```

List active numbers:

```bash
twilio api:core:incoming-phone-numbers:list \
  --properties sid,phoneNumber,friendlyName,voiceUrl
```

## Webhook

Point the number's voice webhook at the public Worker:

```bash
twilio api:core:incoming-phone-numbers:update \
  --sid PNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --voice-url "https://YOUR_WEBHOOK_DOMAIN/twilio/inbound?token=YOUR_TWILIO_WEBHOOK_TOKEN" \
  --voice-method POST
```

Also point the number's call status callback at the Worker for disconnect diagnostics:

```bash
twilio api:core:incoming-phone-numbers:update \
  --sid PNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --status-callback "https://YOUR_WEBHOOK_DOMAIN/twilio/call-status?token=YOUR_TWILIO_WEBHOOK_TOKEN" \
  --status-callback-method POST
```

The Worker injects the separate Media Streams `statusCallback` into the ElevenLabs `<Stream>` TwiML for each call.

For a simple phone-line test, temporarily point the number at:

```text
https://YOUR_WEBHOOK_DOMAIN/twilio/test-say?token=YOUR_TWILIO_WEBHOOK_TOKEN
```

Then switch it back to `/twilio/inbound` for ElevenLabs.

## Caller Allow-List

The webhook can restrict inbound calls to known caller IDs with `ALLOWED_CALLER_NUMBERS`.

Use E.164 format:

```text
+15555550123
```

For Cloudflare Workers, store the real value as a secret:

```bash
wrangler secret put ALLOWED_CALLER_NUMBERS
```

Non-allowlisted callers hear a short outside-coverage message and are not connected to ElevenLabs.
