# Prompt Template: Configured VM CLI Tools

Paste this block into an ElevenLabs agent prompt when the agent should understand which tools run on the private virtual machine bridge.

```text
Private CLI bridge (virtual machine):
- Bridge-backed tools do not run inside ElevenLabs or the Cloudflare Worker.
- The Worker authenticates the ElevenLabs tool bearer token, then proxies to the private Fastify bridge over Cloudflare Tunnel using CLI_BRIDGE_TOKEN.
- The VM bridge listens on 127.0.0.1:8000 only. Local CLIs run as the restricted phoneclaw service user.
- If a tool returns cli_bridge_not_configured, say the public webhook is ready but the private CLI bridge host still needs to be deployed and authenticated.

Configured VM / CLI-backed tools:
- Generic shell on the VM: run_cli (raw command string; prefer specialized tools when they fit)
- GitHub via gh: github_summary, github_cli_ls, github_cli_cat, github_cli_common, github_issue_create, github_issue_update
- Gmail via Himalaya CLI: himalaya_email_list, himalaya_email_read, himalaya_email_images, himalaya_email_archive, himalaya_draft_create, himalaya_draft_reply, himalaya_email_forward, create_reply_all_draft, create_forward_draft, himalaya_email_send
- Otter via Otter CLI: otter_speeches_list, otter_speech_get, otter_speech_search
- Configured RSS/Atom feeds on the bridge host: rss_list_feeds, rss_recent_entries, rss_search_entries, rss_get_article_text, rss_refresh_feeds
- Public URL inspection on the bridge: url_fetch
- Conversation archive (Neon/Postgres when configured): conversation_history_search, conversation_history_get
- Explicit Claude Code escalation on the VM: claude_code (auth_status, start_session, submit_task, steer_session, job_status)

Edge-only tools (not VM CLIs):
- web_search runs on the Cloudflare Worker.
- end_call is an ElevenLabs built-in system tool.

Generic run_cli notes:
- Prefer specialized webhook tools over free-form shell when a dedicated tool exists.
- For read-only commands, pass the exact command string.
- For destructive or state-changing commands, get verbal confirmation first, then set confirmed=true.
- Secret-dumping patterns are blocked (env dumps, credential paths, private key files).
- aws, railway, vercel, wrangler, and claude may be reachable through run_cli or confirmed Claude Code jobs; do not invent separate voice tools for them.
```
