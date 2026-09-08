# Automated call and functionality testing

Use this guide when a pull request changes voice behavior, tools, the Worker, or the EC2 bridge. The existing `elevenlabs:*:test` scripts mostly open **direct ElevenLabs WebSocket sessions**. They do not dial a phone number. Passing one does not prove Twilio routing or phone audio works.

## Choose the right test

| Test | Command | Coverage | Requirements / effects |
| --- | --- | --- | --- |
| Offline regressions | `npm run test:offline` | CLI confirmation, environment, paths, real Fastify HTTP auth, Worker proxy, SendGrid mocks, history, env loading, search fallbacks | Local fixtures; no provider credentials or real emails/calls |
| Syntax/build | `npm run check && npm run worker:check && npm run visualizer:build` | Server/scripts/Worker syntax and dashboard build | Dependencies installed |
| Generic CLI live PR test | `npm run elevenlabs:generic-cli:test` | Temporary ElevenLabs agent → HTTPS preview → PR command code; checks exact revision, directory, confirmation and synthetic environment preflights | ElevenLabs key; authenticated preview endpoint; billable direct text conversation; creates then deletes a temporary agent |
| Existing voice tests | e.g. `npm run elevenlabs:github:audio:test` | Synthesized audio → ElevenLabs ASR → tools → reply | ElevenLabs/Worker credentials; several scripts use macOS `/usr/bin/say`; these bypass Twilio |
| Full phone test | `npm run twilio:call:test -- --place-call` | Twilio outbound synthetic caller → PhoneClaw number → Worker → ElevenLabs → deployed `run_cli` | Real Twilio credentials and configured caller/target; one billable call; no human should answer |
| Audio/stream diagnostics | `npm run elevenlabs:audio:check` and `npm run audio:diagnose` | Audio format configuration and recent Twilio stream errors | ElevenLabs/Worker credentials; diagnostics alone do not place a call |

The direct WebSocket path is documented by [ElevenLabs](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets). Real outbound calls use the [Twilio Calls API](https://www.twilio.com/docs/voice/api/call-resource); the test caller speaks using [TwiML Say](https://www.twilio.com/docs/voice/twiml/say).

## Before every PR merge

1. Record the candidate revision with `git rev-parse HEAD`. Run `npm ci`, the offline suite, syntax checks, and build. GitHub Actions runs these checks on Node 22 and 24 without secrets.
2. Deploy that exact revision to an isolated preview or staging service. A local checkout does not change the EC2 bridge. Confirm the revision serving tool requests; testing production's previous commit does not validate the PR.
3. Run the most relevant live agent test. Review the tool arguments, returned status/results, and the agent's answer. A successful HTTP response, completed call, or fluent answer alone is insufficient.
4. For Twilio routing/audio changes, also run the full phone test. Review the Twilio Call SID, correlated ElevenLabs conversation, Worker `/twilio/events`, and bridge logs for timeouts, failed tools, or dropped streams.
5. Add the revision, commands, outcomes, sanitized conversation/Call SIDs, and any untested layer to the PR. Keep tokens, full transcripts containing personal data, phone numbers, and provider logs out of public PRs.
6. After approval/merge, deploy the merged revision, apply any matching agent schema/prompt changes, and rerun a relevant smoke test. A PR merge alone does not deploy this repository.

For changes to agent behavior, this supplements the merge policy in [README](../README.md#pr-and-merge-policy). Use the matching existing test for GitHub, RSS, email, search, end-call, or Claude steering. Read each script first: some live email/draft/demo tests create real mail, drafts, or GitHub issues. Do not run every live script as a blanket suite.

## Credentials and the personal EC2 host

Use the personal AWS profile explicitly:

```bash
aws ec2 describe-instances --profile personal --region us-east-1 \
  --filters Name=tag:Name,Values=phoneclaw-bridge Name=instance-state-name,Values=running
aws ssm describe-instance-information --profile personal --region us-east-1
```

Runtime credentials are in `/etc/phoneclaw/bridge.env`. The file can be readable only by root: systemd reads an `EnvironmentFile` before switching to the service user. `sudo -u phoneclaw node ...` cannot necessarily read the file itself. Use a transient systemd service with `User=phoneclaw`, the appropriate working directory, and `EnvironmentFile=/etc/phoneclaw/bridge.env` for credentialed test scripts. Give the transient test a bounded runtime and capture only sanitized results. Do not print/cat the file or put credentials in SSM command text, process arguments, or public logs.

The JavaScript loader in `shared/load-env-file.mjs` can load authorized files without shell-sourcing them. Do not `source bridge.env`: unquoted database URLs containing `&` are valid in this file and have previously broken shell-sourcing workflows. For local tests, use an ignored `.env` with mode `0600`; never commit it.

As inspected on September 8, 2026, the personal bridge had ElevenLabs and Worker tool credentials, but **no Twilio Account SID/Auth Token/API-key pair**. The ElevenLabs account had no imported phone number; the application uses the [register-call integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call). Do not assume an ElevenLabs API key can originate Twilio calls in this configuration.

## Isolated generic CLI preview

Check out the PR on the test host. Install dependencies, choose a real child directory under that checkout (for example its `docs/` directory), and run the preview as a restricted user with:

```text
PORT=18000
GENERIC_CLI_ALLOWED_DIRS=/path/to/pr-checkout
PHONECLAW_TEST_REVISION=<full git commit SHA>
PHONECLAW_TEST_TOOL_TOKEN=<fresh random token with at least 32 characters>
PHONECLAW_TEST_MARKER=<synthetic marker only>
```

Start `node setup-and-testing-scripts/serve-generic-cli-preview.mjs`. It binds to localhost, authenticates every route, and exposes only `/health` and `/cli/run`. Run it with a minimal environment, no production service `EnvironmentFile`, and a short lifetime. Expose it using a temporary HTTPS tunnel. Keep port 18000 closed in the security group. The preview response includes its revision and CLI policy version.

For the live test process, load the ElevenLabs credentials separately and provide:

```text
ELEVENLABS_API_KEY=<existing key>
ELEVENLABS_AGENT_ID=<source agent to obtain voice/model settings>
PHONECLAW_TEST_TOOL_URL=https://<preview-host>/cli/run
PHONECLAW_TEST_TOOL_TOKEN=<same preview token>
PHONECLAW_TEST_CWD=/path/to/pr-checkout/docs
PHONECLAW_TEST_REVISION=<same full git commit SHA>
```

Run `npm run elevenlabs:generic-cli:test`. It first checks the preview's revision/policy, rejects a harmless unconfirmed write, and verifies the synthetic environment marker is excluded. It then creates a temporary agent with only `run_cli`, opens a direct text WebSocket conversation, asks it to execute `pwd` in the child directory, and verifies the actual tool arguments/result. It deletes the temporary agent in `finally`; stop the preview and tunnel afterward. If interrupted forcibly, inspect and remove the temporary agent named `PhoneClaw PR CLI test <SHA>` and stop the transient services.

This checks live ElevenLabs tool execution with the PR code. It does not validate the production agent's full prompt/tool combination, ASR, or Twilio. Run the relevant production smoke test after the approved deployment and agent update.

## Real automated Twilio call

Configure a **dedicated automated destination**: the PhoneClaw number owned by the same Twilio account, already pointing to the intended Worker's `/twilio/inbound` route. The caller must be an owned/verified Twilio caller ID and permitted by PhoneClaw's existing caller allowlist. Do not use a person's phone as the test destination, buy numbers automatically, or rewrite the normal voice webhook just to pass a test.

Set these in the protected test environment:

```text
TWILIO_ACCOUNT_SID=<account SID>
TWILIO_AUTH_TOKEN=<auth token>
# Alternatively: TWILIO_API_KEY and TWILIO_API_SECRET
TWILIO_TEST_FROM=<owned or verified allowed caller, E.164>
TWILIO_TEST_TO=<PhoneClaw automated number, E.164>
ELEVENLABS_API_KEY=<key>
ELEVENLABS_AGENT_ID=<agent serving the phone number>
WEB_SEARCH_TOKEN=<Worker tool token>
PHONECLAW_WORKER_BASE_URL=https://<worker-host>
PHONECLAW_TEST_PROJECT_ROOT=/opt/phoneclaw
PHONECLAW_TEST_CWD=/opt/phoneclaw/docs
PHONECLAW_TEST_REVISION=<deployed full commit SHA>
```

Run:

```bash
npm run twilio:call:test -- --place-call
```

The script verifies account ownership and the destination's voice webhook, checks the live CLI policy and deployed Git revision, then places one call. Inline TwiML pauses for the greeting, speaks a `pwd` request, waits for the answer, and hangs up. The call has a 90-second limit; the script also attempts to end a still-active call during cleanup. Automatic create retries are disabled because a lost response may still mean a call was placed.

Success requires a completed Twilio call, an unambiguously matched inbound call, an ElevenLabs transcript correlated by Call SID, a transcribed user turn, and a successful `run_cli` result for the expected directory and policy. Missing or ambiguous evidence fails the test. Inspect speech recognition and timing if a spoken path is misunderstood; do not weaken assertions just to obtain a pass. The initial scenario covers `run_cli`; extend its prompt and result assertions together for new functionalities.

This driver must be live-validated with the deployment's actual Twilio configuration before relying on it as a release gate. If credentials are missing, report “Twilio test not run” separately from any passing direct ElevenLabs test.

## Troubleshooting

- **401:** wrong Worker/bridge/preview token; these tokens serve different boundaries.
- **`working_directory_not_allowed`:** directory missing, outside the configured root, or a symlink leading outside. Legitimate child directories now work.
- **`confirmation_required`:** generic CLI only permits `pwd` and limited `ls` forms without confirmation. Use specialized tools for other reads, or confirm the exact command.
- **A CLI no longer sees a key:** generic subprocesses intentionally exclude server credentials and shell startup files. Use the specialized integration or service-user CLI login; do not restore full environment inheritance.
- **Phone answers with outside-coverage message:** test caller is not allowlisted. Fix the explicit test configuration; do not disable access control.
- **Busy/no-answer/failed or no transcript:** inspect Twilio status/errors, inbound webhook, and Worker stream events. A direct WebSocket pass cannot diagnose the phone network.
