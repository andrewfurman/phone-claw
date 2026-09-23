# Universal CLI runner

PhoneClaw exposes one application tool, `run_cli`, at `POST /cli/run`. The agent's
command reference is [universal-cli.md](../elevenlabs-setup/prompt-templates/universal-cli.md).
Adding an installed CLI does not require another Fastify route, Worker route,
ElevenLabs function schema, or JavaScript adapter.

## Calling a native CLI

```json
{"command":"gh","args":["repo","list","--limit","5","--json","nameWithOwner"],"confirmed":true}
```

`args` is a literal argument array. Quotes, semicolons, `$()`, pipes and wildcards
are not interpreted by a shell. An unknown executable is permitted after exact
confirmation, with the filtered generic environment. An executable that is not
installed returns `cli_not_installed`.

The optional operator-owned `GENERIC_CLI_PROGRAMS_PATH` JSON file can configure
an executable's path, credential environment **names**, exact `readOnlyArgs`, and
blocked argument prefixes. Start with [cli-programs.example.json](../config/cli-programs.example.json).
Never put secrets in that JSON file or let the agent choose its path. Keep the
live file outside Git, owned by the operator. The sample's executable is fictional.

```json
{
  "mycli": {
    "executable": "/usr/local/bin/mycli",
    "env": ["MYCLI_API_KEY"],
    "readOnlyArgs": [["items", "list", "--limit", "5", "--output", "json"]],
    "blockedArgs": [["auth", "export"]]
  }
}
```

The complete argument array must match an approved read; adding another flag
requires confirmation. An empty `readOnlyArgs` list approves nothing. Provider
credentials are passed only to that directly executed program. Raw shell
commands never inherit these program-specific credentials. Shell injection
variables and bridge/telephony control credentials cannot be added to a program
environment. Caller `env` overrides remain limited to permitted display/locale
variables. The built-in policies cover `gh`, `himalaya`, `otter`, `gws`, and
`claude`; these entries do not install or authenticate those programs.

To add a CLI: install it for the service user, configure its login or scoped
credential names, add useful examples to the Markdown guide, and apply the guide
to ElevenLabs after testing. Use exact operator-approved reads only after
checking the installed CLI's behavior. Other invocations retain confirmation.
Google Workspace Calendar `gws calendar +agenda` exact argv lists are operator-approved reads (#114); other `gws` mutations still require confirmation. Installation/auth was completed in #102. Apple Photos (`photos` / `mac-photos`, #112) runs the read-only `mac-tools/photos` script on the Mac (install at `~/.local/bin/photos`; bridge wrapper `deploy/mac-photos` at `/home/phoneclaw/bin/mac-photos`). It queries Photos.sqlite with `mode=ro&immutable=1` (seconds, versus ~15 minutes for an osxphotos load) and returns dates in each photo's own time zone, people, favorites, titles/descriptions and album names, never GPS or file paths. `isPhotosSafeReadArgs` allows `recent`, `person`, `date`, `on-this-day`, `people`, `albums`, `stats` with bounded limits; raw `export` is blocked for `run_cli`. `phoneclaw photos email` (confirmation required) exports one photo's local JPEG (preview, else thumbnail; iCloud-only photos are refused) and sends it via SendGrid from `photos@aifurman.com` (`PHOTOS_EMAIL_FROM`) to `aifurman@gmail.com` (`PHOTOS_EMAIL_TO`) only. Apple Notes (`notes` / `mac-notes`) uses exact `readOnlyArgs` for `recent` (alone and with limits 1/2/3/5/10/20) plus a notes-only safe pattern for `read <numeric-id>` and `search <query>` with optional `-l`/`--limit` and `-f`/`--folder`; `create`/`delete`/`edit`/`index` stay blocked or confirmation-gated.

## Existing workflows through the phoneclaw CLI

```json
{"command":"phoneclaw","args":["github","common","--json","{\"action\":\"issue_list\",\"repo\":\"andrewfurman/phone-claw\",\"limit\":5}"]}
```

`phoneclaw help` lists all commands; `phoneclaw <group> <action> --help` lists its
accepted options. Existing workflows are retained as CLI commands because they
provide behavior beyond a native binary: compact email pagination, preserved
HTML drafts, SendGrid sender/CC/preview rules, private RSS feeds, conversation
history, safe public URL fetching, search fallbacks, and durable Claude jobs.

These commands share a registry, execution envelope, and output cap. Their
trusted adapters run in the bridge process so RSS caches and asynchronous Claude
jobs survive individual requests. Provider-specific behavior stays in its
existing modules; the HTTP server has no separate handler for each workflow.

The included terminal client speaks the same protocol:

```bash
npm run cli -- github common --json '{"action":"issue_list","repo":"andrewfurman/phone-claw","limit":5}'
# Or install the package's phoneclaw executable on PATH and run:
phoneclaw rss feeds
```

Configure `PHONECLAW_CLI_URL` (localhost by default) and `CLI_BRIDGE_TOKEN` in the
terminal's protected environment. Never pass tokens as command arguments. The
client accepts `--confirmed` as its final argument for an already approved action.
In an HTTP/voice call, confirmation belongs on `run_cli.confirmed`; embedding
`confirmed` inside `--json` cannot authorize anything.

## Results and limits

Every command returns `ok`, `status`, `stdout`, `stderr`, `answer_text`, and
execution metadata. Built-in workflows also return their existing structured
result under `data`. Native commands return text in `stdout`. The visualizer
reads `data` for existing issue, draft, and article links.

- Structured calls default to a 32,000-byte primary result budget, configurable
  up to 750,000 bytes. Stderr and spoken summaries have separate 4,000-byte caps.
- If a domain result exceeds the budget, `data` is omitted and a bounded preview
  goes in `stdout` with `data_truncated` and `stdout_truncated`. Narrow the query;
  truncated JSON is not a complete result.
- Native output collection stops at 1 MB and kills the process group. Native
  timeouts also kill descendants on the POSIX bridge. Default timeout is 25
  seconds, maximum 60 seconds. Missing binaries and output-limit failures have
  explicit statuses.
- Compatibility endpoints keep their domain output limits and use the 750,000-byte
  outer cap and 60-second response deadline, so ordinary Otter raw/parsed JSON
  responses are not reduced to the smaller default voice budget.
- Existing in-process workflows retain their own cancellation/timeout behavior.
  The outer response deadline does not cancel an already-running provider write.
  A timeout is an unknown outcome; do not retry writes automatically.
- Use `phoneclaw claude code` with `submit_task`, `job_status`, `start_session`,
  `steer_session`, or `auth_status` for durable coding work.
- Raw `command` strings with `args` omitted keep the #100 shell policy, including
  exact confirmation, the tiny `pwd`/`ls` exception, environment filtering and
  real-path working-directory checks.

Confirmed arbitrary programs remain trusted code with service-user filesystem
permissions, not an OS sandbox. Credential redaction and sensitive-command
blocks are defense in depth; do not authorize a command to dump credentials.


## Live agent tool attachment (post-#123 audit)

Conversation sampling (2026-09-11 → 2026-09-18 ET, N=50 Twilio calls) showed **9/50** conversations still invoking legacy dedicated ElevenLabs tools (`web_search`, `github_*`, `himalaya_*`, `rss_*`, `url_fetch`, …) even though this runner and the command guide assume a single `run_cli` application tool. See [CONVERSATION_ARCHITECTURE_AUDIT.md](CONVERSATION_ARCHITECTURE_AUDIT.md).

Operator checklist:

1. Run `npm run elevenlabs:tools:configure` (preview), then `-- --apply`, so the Andrew Assistant Agent attaches **only** `run_cli` plus system `end_call`.
2. Re-export the public-safe agent snapshot; confirm the prompt uses [universal-cli.md](../elevenlabs-setup/prompt-templates/universal-cli.md), not the older specialized-tool template files alone.
3. After a short soak with Twilio smokes, set `PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES=false` on bridge and Worker.
4. Do not re-add specialized webhook tools when exporting or cloning agents.

## Migration and rollback

1. Run `npm ci`, `npm run test:offline`, `npm run check`, `npm run worker:check`,
   and `npm run visualizer:build` on the candidate revision.
2. Deploy the bridge candidate with the existing protected environment. Add
   `TAVILY_API_KEY` on the bridge if Tavily was previously configured only on the
   Worker; the universal search command executes on the bridge. Without that key
   it uses the existing no-key fallbacks. Do not copy API values through logs.
3. Deploy the matching Worker/visualizer assets. The previous Worker already
   proxies `/cli/run`, allowing a staged rollout; the new Worker also marks
   compatibility routes deprecated. Twilio lifecycle and memory archive/context
   endpoints remain infrastructure, not additional agent tools.
4. Run `npm run elevenlabs:tools:configure` to preview the migration. Then pass
   `-- --apply` to apply it. The script checks the deployed runner version, saves
   a mode-0600 backup in a private temporary directory outside Git, creates a new
   `run_cli` tool record, and attaches only that application tool plus system call
   controls. Other agents' shared tools are not modified. The guide is inserted
   once; voice, model, personalization and unrelated settings are preserved.
5. Run the [automated phone test](AUTOMATED_CALL_TESTING.md), review tool results
   and the finalized transcript, and record the tested revision in the PR.
6. After old clients have migrated, set `PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES=false`
   on the bridge and Worker. Until then, old URLs are deprecated compatibility
   aliases over the same registry. No new CLI needs an alias.

If agent migration fails, the configure script attempts to restore its original
prompt/tool IDs and removes the newly created tool only after restoration. Keep
the private backup until the rollout is verified. For a service rollback, restore
the previous clean checkout and original agent prompt/tool IDs together, then
restart the bridge. Do not submit both inline `tools` and `tool_ids` in one
ElevenLabs PATCH. Never commit the private agent backup: it can contain tool auth.

The old `elevenlabs:github:configure` command delegates to the new configure script
and previews by default. Older live tests that assert specialized tool names test
the compatibility configuration; use the universal scenarios for the new agent.
