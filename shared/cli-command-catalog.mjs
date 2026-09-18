// Public command names and compatibility routes; never put secrets here.
export const CLI_COMMAND_CATALOG = [
  {
    "command": "web search",
    "legacy_path": "/web-search",
    "parameters": [
      "query",
      "search_query",
      "searchQuery",
      "max_results",
      "maxResults"
    ]
  },
  {
    "command": "github summary",
    "legacy_path": "/github-summary",
    "parameters": [
      "item_type",
      "itemType",
      "type",
      "kind",
      "scope",
      "max_results",
      "maxResults",
      "repo",
      "repository",
      "owner",
      "organization",
      "org",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "github ls",
    "legacy_path": "/github-cli/ls",
    "parameters": [
      "repo",
      "repository",
      "path",
      "ref",
      "branch",
      "sha",
      "recursive",
      "max_entries",
      "maxEntries",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "github cat",
    "legacy_path": "/github-cli/cat",
    "parameters": [
      "repo",
      "repository",
      "path",
      "ref",
      "branch",
      "sha",
      "max_bytes",
      "maxBytes",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "github issue-create",
    "legacy_path": "/github-issues/create",
    "parameters": [
      "repo",
      "repository",
      "title",
      "body",
      "labels",
      "assignees",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "github issue-update",
    "legacy_path": "/github-issues/update",
    "parameters": [
      "repo",
      "repository",
      "number",
      "issue_number",
      "issueNumber",
      "title",
      "body",
      "state",
      "state_reason",
      "stateReason",
      "labels",
      "assignees",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-list",
    "legacy_path": "/cli/himalaya/email-list",
    "parameters": [
      "query",
      "search_query",
      "searchQuery",
      "folder",
      "account",
      "page",
      "page_size",
      "pageSize",
      "max_results",
      "maxResults",
      "all_pages",
      "allPages",
      "max_pages",
      "maxPages",
      "max_items",
      "maxItems",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-read",
    "legacy_path": "/cli/himalaya/email-read",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "account",
      "include_headers",
      "includeHeaders",
      "mark_seen",
      "markSeen",
      "include_raw",
      "includeRaw",
      "max_body_chars",
      "maxBodyChars",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-image-inspect",
    "legacy_path": "/cli/himalaya/email-image-inspect",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "account",
      "image_index",
      "imageIndex",
      "image_id",
      "imageId",
      "cid",
      "content_id",
      "contentId",
      "prompt",
      "max_images",
      "maxImages",
      "max_image_bytes",
      "maxImageBytes",
      "max_original_bytes",
      "maxOriginalBytes",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-images",
    "legacy_path": "/cli/himalaya/email-images",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "account",
      "include_embedded",
      "includeEmbedded",
      "include_attachments",
      "includeAttachments",
      "include_data",
      "includeData",
      "max_images",
      "maxImages",
      "max_results",
      "maxResults",
      "max_image_bytes",
      "maxImageBytes",
      "max_original_bytes",
      "maxOriginalBytes",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-archive",
    "legacy_path": "/cli/himalaya/email-archive",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "ids",
      "envelope_ids",
      "envelopeIds",
      "folder",
      "archive_folder",
      "archiveFolder",
      "account",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya draft-create",
    "legacy_path": "/cli/himalaya/draft-create",
    "parameters": [
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "message",
      "draft_folder",
      "draftFolder",
      "account",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya draft-reply",
    "legacy_path": "/cli/himalaya/draft-reply",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "body",
      "message",
      "reply_all",
      "replyAll",
      "draft_folder",
      "draftFolder",
      "account",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-forward",
    "legacy_path": "/cli/himalaya/email-forward",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "message",
      "draft_folder",
      "draftFolder",
      "account",
      "max_original_bytes",
      "maxOriginalBytes",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya reply-all-draft",
    "legacy_path": "/cli/himalaya/create-reply-all-draft",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "body",
      "message",
      "draft_folder",
      "draftFolder",
      "account",
      "max_original_bytes",
      "maxOriginalBytes",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya forward-draft",
    "legacy_path": "/cli/himalaya/create-forward-draft",
    "parameters": [
      "id",
      "envelope_id",
      "envelopeId",
      "folder",
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "message",
      "draft_folder",
      "draftFolder",
      "account",
      "max_original_bytes",
      "maxOriginalBytes",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "himalaya email-send",
    "legacy_path": "/cli/himalaya/email-send",
    "parameters": [
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "message",
      "account",
      "emergency",
      "previewed",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "sendgrid email-send",
    "legacy_path": "/cli/sendgrid/email-send",
    "parameters": [
      "from",
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "message",
      "text",
      "html",
      "previewed",
      "timeout_ms",
      "timeoutMs"
    ]
  },
  {
    "command": "otter speeches-list",
    "legacy_path": "/cli/otter/speeches-list",
    "parameters": [
      "source",
      "days",
      "page_size",
      "pageSize",
      "max_results",
      "maxResults",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "otter speech-get",
    "legacy_path": "/cli/otter/speech-get",
    "parameters": [
      "speech_id",
      "speechId",
      "otid",
      "id",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "otter speech-search",
    "legacy_path": "/cli/otter/speech-search",
    "parameters": [
      "speech_id",
      "speechId",
      "otid",
      "id",
      "query",
      "search_query",
      "searchQuery",
      "speaker",
      "speaker_name",
      "speakerName",
      "size",
      "max_results",
      "maxResults",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "github common",
    "legacy_path": "/cli/github/common",
    "parameters": [
      "action",
      "repo",
      "repository",
      "owner",
      "organization",
      "number",
      "issue_number",
      "issueNumber",
      "pr_number",
      "prNumber",
      "state",
      "query",
      "search_query",
      "searchQuery",
      "limit",
      "max_results",
      "maxResults",
      "visibility",
      "include_archived",
      "includeArchived",
      "include_forks",
      "includeForks",
      "sort",
      "max_raw_bytes",
      "maxRawBytes"
    ]
  },
  {
    "command": "rss feeds",
    "legacy_path": "/cli/rss/feeds",
    "parameters": []
  },
  {
    "command": "rss recent",
    "legacy_path": "/cli/rss/recent",
    "parameters": [
      "feed_id",
      "feedId",
      "limit",
      "max_results",
      "maxResults",
      "max_excerpt_chars",
      "maxExcerptChars",
      "refresh"
    ]
  },
  {
    "command": "rss search",
    "legacy_path": "/cli/rss/search",
    "parameters": [
      "feed_id",
      "feedId",
      "query",
      "search_query",
      "searchQuery",
      "start_date",
      "startDate",
      "end_date",
      "endDate",
      "limit",
      "max_results",
      "maxResults",
      "max_excerpt_chars",
      "maxExcerptChars",
      "refresh"
    ]
  },
  {
    "command": "rss article-text",
    "legacy_path": "/cli/rss/article-text",
    "parameters": [
      "entry_id",
      "entryId",
      "id",
      "article_url",
      "articleUrl",
      "url",
      "feed_id",
      "feedId",
      "max_text_chars",
      "maxTextChars",
      "refresh"
    ]
  },
  {
    "command": "rss refresh",
    "legacy_path": "/cli/rss/refresh",
    "parameters": [
      "feed_id",
      "feedId"
    ]
  },
  {
    "command": "web fetch",
    "legacy_path": "/cli/url-fetch",
    "parameters": [
      "url",
      "href",
      "method",
      "purpose",
      "follow_redirects",
      "followRedirects",
      "include_html",
      "includeHtml",
      "max_body_chars",
      "maxBodyChars",
      "max_response_bytes",
      "maxResponseBytes",
      "max_raw_bytes",
      "maxRawBytes",
      "timeout_ms",
      "timeoutMs",
      "form",
      "form_data",
      "formData",
      "body",
      "payload",
      "data",
      "content_type",
      "contentType",
      "headers",
      "cookies",
      "cookie",
      "csrf_token",
      "csrfToken",
      "csrf_field",
      "csrfField",
      "extract_csrf",
      "extractCsrf"
    ]
  },
  {
    "command": "claude code",
    "legacy_path": "/cli/claude-code",
    "parameters": [
      "action",
      "task",
      "command",
      "prompt",
      "repo_path",
      "repoPath",
      "working_directory",
      "workingDirectory",
      "session_id",
      "sessionId",
      "job_id",
      "jobId",
      "mode",
      "instructions",
      "steering_instructions",
      "steeringInstructions",
      "message",
      "max_seconds",
      "maxSeconds"
    ]
  },
  {
    "command": "history search",
    "legacy_path": "/conversation-history/search",
    "parameters": [
      "query",
      "search_query",
      "searchQuery",
      "start_date",
      "startDate",
      "end_date",
      "endDate",
      "limit",
      "max_results",
      "maxResults"
    ]
  },
  {
    "command": "history get",
    "legacy_path": "/conversation-history/get",
    "parameters": [
      "conversation_id",
      "conversationId",
      "id",
      "include_transcript",
      "includeTranscript",
      "include_tool_details",
      "includeToolDetails",
      "max_transcript_turns",
      "maxTranscriptTurns",
      "max_tool_items",
      "maxToolItems"
    ]
  }
];
export const LEGACY_TOOL_PATHS = CLI_COMMAND_CATALOG.map(item => item.legacy_path);
