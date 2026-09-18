# Conversation architecture audit

Issue: [#123](https://github.com/andrewfurman/phone-claw/issues/123)  
Audit date: 2026-09-18 (America/New_York)  
Primary sample: ElevenLabs agent `Andrew Assistant Agent` (`agent_0901kve1zxf8eg281mx3ng82m7y3`), last **50** conversations with summaries (`summary_mode=include`).

## Method

| Source | What was used | Notes |
| --- | --- | --- |
| ElevenLabs conversation list + summaries | **N=50** Twilio calls, 2026-09-11 05:57 ET → 2026-09-18 09:18 ET | Primary quantitative evidence. Tool names from per-conversation `tool_names`. Themes from `transcript_summary` keyword multi-label. |
| Issue / PR history | Closed work #84/#95/#106 (universal CLI), #109/#114/#116/#118/#119 (confirm friction), #104/#121 (image inspect), #111 (Economist), #103 (Mac Notes bridge) | Explains which failures already shipped fixes vs remaining debt. |
| Architecture docs & prompts | `docs/UNIVERSAL_CLI.md`, `docs/CLI_BRIDGE_SECURITY.md`, `elevenlabs-setup/prompt-templates/*`, `shared/cli-command-catalog.mjs` | Compared intended `run_cli`-only shape to live tool attachments. |
| Neon / Postgres archive on bridge | Not queried in this pass | Authorized SSM path exists (`phoneclaw-bridge` / `i-09ee74d7aff8b154d`), but this audit environment lacked a working AWS CLI / SSM `SendCommand` client. Treat Neon as a **follow-up verification** source (`phoneclaw history search/get`, `query-conversation-history.mjs`), not as missing evidence for the recommendations below. |
| Known Twilio smokes (from summaries) | USPS Informed Delivery image inspect **PASS**; `gws calendar +agenda` + `notes recent` unconfirmed reads **PASS** after #114/#119 | Used as qualitative corroboration. |

PII policy: no full phone numbers, email addresses, or API keys in this document. Family first names that appear in public issue titles are omitted from examples here.

### Sample quality

- `call_successful`: **49 success / 1 failure**
- Status: 49 `done` / 1 `failed`
- All 50 initiated via **Twilio**
- Mean duration ≈ **494 s** (~8.2 min); range 7 s – 2313 s
- 45/50 conversations reported at least one tool name; 5 were greetings / no-tool hangups

## Top intents / recurring themes

Keyword hits in summaries (multi-label; a call can count in several buckets):

| Theme | Approx. hits (of 50) | What Andrew actually does |
| --- | --- | --- |
| Confirmation friction | 24 | Asked to “approve” calendar/notes/help; led to #114 and later allowlist smokes |
| RSS / Economist | 21 | World in Brief, paywall / full-text gaps, ASR “Weldon Brief” ↔ “World in Brief” |
| GitHub / issues | ~20–27 | Triage, create/update issues from phone (including this audit issue #123), family-newspaper work |
| Email / mail | ~13–15 | List/read/archive, drafts, USPS digests |
| Calendar / agenda | 13 | `gws calendar +agenda` day/weekend checks |
| Notes / lists | 8 | Supplements, Trader Joe’s, recent notes — often misrouted before Notes allowlists stuck |
| Search / product research | ~3–12 | Printers, USB-C wattage, swim lessons, current events when RSS insufficient |
| Otter / Claude Code / send | ≤4 each | Present but not dominant in this window |
| Image / OCR | 2–3 | USPS Informed Delivery smoke; email image path |

**Executive pattern:** the voice product is already a **personal ops console** (calendar + notes + mail + GitHub + RSS), not a chat novelty. Latency and confirmation theater hurt more than missing exotic tools.

## Tool-use frequency and failure modes

### Tool attachment mix (conversations mentioning each tool)

| Tool | Conversations (of 50) |
| --- | --- |
| `run_cli` | 37 |
| `end_call` | 31 |
| `web_search` | 7 |
| `github_cli_common` | 6 |
| `github_issue_create` | 6 |
| `himalaya_email_list` | 4 |
| `rss_search_entries` | 4 |
| `himalaya_email_read` / `rss_get_article_text` / `github_issue_update` | 3 each |
| Other legacy (`himalaya_*`, `rss_*`, `url_fetch`, `github_cli_ls/cat`, drafts, `github_summary`) | 1–2 each |

### Migration signal (critical)

Despite the universal-CLI redesign (#84/#95/#106) and docs that say the agent’s only application tool is `run_cli`:

- **37/50** calls used `run_cli`
- **9/50** still invoked **legacy dedicated ElevenLabs tools** (`web_search`, `github_*`, `himalaya_*`, `rss_*`, `url_fetch`, drafts, …)
- **6/50** used legacy tools **without** `run_cli`
- **3/50** mixed both in one call
- **34/50** were `run_cli`-only (ignoring `end_call`)

Older conversations in the 50-window predate full migration; newer ones skew `run_cli`. The architecture problem is not “agents refuse `run_cli`” — it is that **stale specialized tools remain attached**, so the model can (and does) bypass the universal path and the single command guide.

### Qualitative failure modes (from summaries; no secrets)

1. **Wrong store for personal lists:** Agent searched email/RSS for “supplements” instead of Apple Notes; claimed lack of Notes access even after Mac bridge work; ASR typo `map-notes` / `map-imp` → `cli_not_installed`.
2. **Confirmation theater on allowlisted reads:** Asked confirmation for `gws calendar +agenda` (spawned #114). Later automated smokes show agenda + `notes recent` succeeding with `confirmed=false`.
3. **Economist / RSS friction:** Full-text and paywall pain (#111); ASR confusion between “World in Brief” and similar-sounding titles.
4. **Web-search heavy product research:** Printers, cable wattage, odds — fine when intentional; costly when RSS already had the article.
5. **GitHub-from-phone works:** family-newspaper issues, printer research issue, and **#123 itself** created on a call — keep write confirmation, but do not add friction to reads/triage.
6. **USPS image inspect smoke PASS** via `phoneclaw` image inspect path (#121) — keep folder fallback guidance (digests often not only in INBOX).

## Prompt gaps

| Gap | Evidence | Prompt / config fix |
| --- | --- | --- |
| Notes vs email/RSS routing | Supplements / Trader Joe’s calls | Strengthen Notes-before-email; forbid “I don’t have Notes access” when `notes` CLI is configured |
| Fake confirmation on agenda/notes/help | Calendar approval call → #114 | Already tightened in #116/#118/#119; keep in guide; re-apply agent prompt after tool prune |
| Legacy tool names still callable | 9/50 calls | Finish `elevenlabs:tools:configure --apply`; detach specialized tools; prefer `phoneclaw web search` via `run_cli` |
| USPS digest folder | Smoke needed image inspect | Prefer INBOX then `[Gmail]/All Mail` (or configured archive) when digest missing |
| ASR CLI misspellings | `map-notes` / `map-imp` | Map common ASR errors to `notes` / `imsg`; never invent uninstalled binary names |
| Economist ASR | Weldon / World in Brief | Prefer configured Economist feed + `rss search` for “brief” / “world in brief” |

## Architecture recommendations

### Quick wins (ship soon; hours–1 day)

1. **Finish live agent migration to `run_cli` + `end_call` only.** Re-run `npm run elevenlabs:tools:configure -- --apply`, export snapshot, verify no `github_*` / `himalaya_*` / `rss_*` / `web_search` / `url_fetch` tool IDs remain on Andrew Assistant Agent. Then set `PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES=false` after a short soak.
2. **Re-paste / refresh the universal command guide** on the agent after prune so the model cannot fall back to old tool schemas still in the prompt.
3. **Prompt tightening (this PR):** Notes-before-email/RSS; never claim missing Notes when CLI exists; USPS All Mail fallback; ASR alias hint for notes/imsg.
4. **Document legacy retirement** in `UNIVERSAL_CLI.md` + prompt-template README so future exports do not re-attach specialized tools.
5. **Neon archive verification:** From an environment with SSM/AWS CLI, run `query-conversation-history.mjs recent` and compare tool_calls JSON to ElevenLabs `tool_names` (catches archive gaps).

### Structural (follow-up issues; multi-day)

6. **Intent → default CLI router table** in the command guide (and optionally a tiny catalog hint in `shared/cli-command-catalog.mjs`): calendar→`gws`, lists→`notes`, mail→`himalaya`, news→`rss`, tasks→`github`, vision→`image inspect`. Reduces wrong-tool paths without new HTTP routes.
7. **Confirmation UX:** Keep writes gated; expand operator `readOnlyArgs` only for proven voice verbs (already done for agenda/notes/help). Avoid per-call “approve Google Workspace” language forever.
8. **RSS full-text reliability** for Economist (#111 closed but summaries still show friction) — monitor `rss article-text` `full_article_available` / `access_note`; consider reader-session health check in smokes.
9. **Apple Photos** — already tracked as **#112**; do not duplicate.
10. **Rename / BashPhone** — already **#85**; out of scope for call UX.
11. **Telemetry dashboard:** Aggregate `tool_names` + Neon `tool_calls` weekly (success rate, confirmation_required rate, cli_not_installed) so the next audit is continuous, not a 50-call dump.

## Recommendation → files to change

| Recommendation | Files / surfaces |
| --- | --- |
| Prune legacy ElevenLabs tools | `setup-and-testing-scripts/configure-elevenlabs-universal-cli.mjs`; live agent via `npm run elevenlabs:tools:configure -- --apply`; export under `elevenlabs-setup/` |
| Disable legacy HTTP aliases after soak | Bridge + Worker env `PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES=false`; `docs/UNIVERSAL_CLI.md` migration section |
| Notes / USPS / ASR prompt fixes | `elevenlabs-setup/prompt-templates/universal-cli.md` (and re-apply to agent) |
| Legacy retirement guidance | `docs/UNIVERSAL_CLI.md`, `elevenlabs-setup/prompt-templates/README.md` |
| Intent router table | `elevenlabs-setup/prompt-templates/universal-cli.md`; optional notes in `shared/cli-command-catalog.mjs` |
| Allowlist expansion (only if new verbs prove needed) | Operator `cli-programs` JSON (not Git); `fastify-app/cli-programs.mjs`; `config/cli-programs.example.json` |
| Archive verification | `setup-and-testing-scripts/query-conversation-history.mjs`, `fastify-app/conversation-history.mjs`, bridge `CONVERSATION_DATABASE_URL` |
| Photos | Existing #112 (MacinCloud) — no new issue |
| Continuous audit metrics | New follow-up issue (suggested below); optional visualizer later |

## What Andrew should do next

1. **Review and merge this PR** (audit doc + prompt/docs tightening).
2. **On a machine with ElevenLabs + bridge creds:** apply `elevenlabs:tools:configure -- --apply`, confirm the agent tool list is only `run_cli` + system `end_call`, place a short Twilio smoke (agenda + notes + one RSS recent + end_call).
3. **Open or accept the follow-up issue** for legacy-tool prune + soak + `PHONECLAW_ENABLE_LEGACY_TOOL_ROUTES=false` if not completed in the same session as merge.
4. **Leave #123 open** until: (a) this audit PR is merged, and (b) the legacy-tool prune follow-up is filed or done. The issue asks for audit **and** rearchitecture; the audit lands here; rearchitecture is the prune + router hardening checklist above.
5. **Do not** reinvent Photos (#112) or rename (#85) under this issue.

## Appendix: sample titles (redacted)

Illustrative titles from the 50-call window: GitHub Issue Management; Economist RSS Issues; Informed Delivery Email Inspection; Weekend Calendar Check; Google Calendar Check; Apple Notes GitHub Issues; CLI Not Installed; Newspaper Project Feedback; Apple USB-C Wattage; Printer Research GitHub Issue; Skier's Guide Email; Tasks/Email/News (legacy tool mix).
