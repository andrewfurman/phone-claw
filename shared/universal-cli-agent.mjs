// Pure schema and prompt builders, shared by provisioning and isolated live tests.
export function universalCliTool({ url, token }) {
  const string = description => ({ type: "string", description });
  return {
    type: "webhook", name: "run_cli",
    description: "Run any installed CLI using command and literal args. Use the supplied Markdown command guide: phoneclaw commands preserve existing email, GitHub, RSS, history, search, web fetch and async Claude workflows. Never claim success without checking ok, status and data/stdout. Exact confirmation is required for writes and unapproved native/shell commands.",
    response_timeout_secs: 65, disable_interruptions: false, force_pre_tool_speech: true,
    pre_tool_speech: "auto", tool_call_sound: "typing", tool_call_sound_behavior: "auto",
    dynamic_variables: { dynamic_variable_placeholders: {} }, execution_mode: "immediate",
    api_schema: {
      url, method: "POST", request_headers: { Authorization: `Bearer ${token}` },
      path_params_schema: {}, query_params_schema: null,
      request_body_schema: {
        type: "object", required: ["command"], description: "One universal CLI invocation.",
        properties: {
          command: string("Executable name such as phoneclaw, gh or gws. With args omitted, a raw shell command uses the stricter shell policy."),
          args: { type: "array", description: "Literal arguments, without shell quoting or expansion. For phoneclaw: [group, action, --json, JSON object string].", items: string("One literal argument.") },
          cwd: string("Optional existing working directory beneath the configured allowed roots."),
          confirmed: { type: "boolean", description: "True only after Andrew confirms the exact command/action and its arguments. Authorization belongs here, never inside --json." },
          timeout_ms: { type: "integer", description: "Response deadline: default 25000 ms, maximum 60000 ms. Use phoneclaw claude code for durable async jobs." },
          max_raw_bytes: { type: "integer", description: "Result budget: default 32000 bytes for structured commands, maximum 750000. Narrow a query if data_truncated or stdout_truncated is true." },
        },
      },
      // Omitting a fixed response schema preserves domain JSON without adding a
      // per-CLI output schema. Fastify returns the same bounded envelope for all.
      response_body_schema: null,
      content_type: "application/json", auth_resolved_params: [], auth_connection: null,
    },
  };
}

export function universalPrompt(current, guide) {
  const markers = ["\n\nWeb search capability:", "\n\nGitHub read capability:", "\n\nGitHub capability:", "\n\n<!-- phoneclaw-universal-cli -->"];
  const indexes = markers.map(marker => current.indexOf(marker)).filter(index => index >= 0);
  const base = indexes.length ? current.slice(0, Math.min(...indexes)) : current;
  return `${base.trim()}\n\n<!-- phoneclaw-universal-cli -->\n${guide.trim()}\n<!-- /phoneclaw-universal-cli -->`;
}

export const endCallTool = { type: "system", name: "end_call", description: "End the call after Andrew clearly says goodbye or is done. Say a short farewell first; do not end merely for a pause or tool completion.", response_timeout_secs: 20, params: { system_tool_type: "end_call" } };
