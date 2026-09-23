// Read-only production smoke scenarios. Never put private results in test logs.
export const UNIVERSAL_SMOKE_SCENARIOS = [
  { id: "native_cli", phrase: "Please use run CLI to run the executable G H with the single argument dash dash version. Briefly tell me its version.", command: "gh", args: ["--version"] },
  { id: "github", phrase: "Using the phoneclaw GitHub common command, list at most two open issues in Andrew Furman's phone dash claw GitHub repository. Give only a short summary.", builtin: "github common", options: { action: "issue_list", repo: "andrewfurman/phone-claw", limit: 2 } },
  { id: "rss", phrase: "Please use the phoneclaw RSS feeds command to list my configured feeds. Tell me only how many feeds are configured.", builtin: "rss feeds", options: {} },
  { id: "email", phrase: "Please use the phoneclaw Himalaya email list command to list the latest two emails in my inbox. Just tell me whether the lookup worked, without reading their contents.", builtin: "himalaya email-list", options: { page_size: 2 } },
  { id: "history", phrase: "Please use the phoneclaw history search command to search previous calls for the word CLI, limited to two results. Just tell me whether the lookup worked.", builtin: "history search", options: { query: "CLI", limit: 2 } },
  { id: "otter", phrase: "Please use the phoneclaw Otter speeches list command to look up two recent transcripts. Just tell me whether the lookup worked.", builtin: "otter speeches-list", options: { page_size: 2 }, maxRawBytes: 200_000 },
  { id: "web_fetch", phrase: "Please use the phoneclaw web fetch command to fetch H T T P S colon slash slash example dot com. Give a one sentence description.", builtin: "web fetch", options: { url: "https://example.com" } },
  { id: "web_search", phrase: "Please use the phoneclaw web search command to search for the official Python programming language website. Give only one short sentence from the results.", builtin: "web search", options: { query: "official Python programming language website", max_results: 2 } },
  { id: "claude", phrase: "Please use the phoneclaw Claude code command with action auth underscore status to check authentication. Just report the authentication status; do not start a coding task.", builtin: "claude code", options: { action: "auth_status" } },
  { id: "gws_agenda", phrase: "Please use run CLI with command G W S and arguments calendar plus agenda. Briefly say whether today's agenda lookup worked, without asking me to approve Google Workspace.", command: "gws", args: ["calendar", "+agenda"] },
  { id: "notes_recent", phrase: "Please use run CLI with command notes and arguments recent dash L five. Briefly say whether the notes lookup worked, without asking me to approve Notes.", command: "notes", args: ["recent", "-l", "5"] },
];

export function smokeRequest(scenario) {
  const request = scenario.builtin ? { command: "phoneclaw", args: [...scenario.builtin.split(" "), "--json", JSON.stringify(scenario.options)] } : { command: scenario.command, args: scenario.args };
  if (scenario.maxRawBytes) request.max_raw_bytes = scenario.maxRawBytes;
  return request;
}

export function matchesSmokeCall(scenario, params) {
  if (!params || params.confirmed === true || params.confirmed === "true") return false;
  if (!scenario.builtin) return params.command === scenario.command && JSON.stringify(params.args) === JSON.stringify(scenario.args);
  if (params.command !== "phoneclaw" || !Array.isArray(params.args) || params.args.slice(0, 2).join(" ") !== scenario.builtin) return false;
  let options;
  try { options = params.args.length === 2 ? {} : params.args.length === 4 && params.args[2] === "--json" ? JSON.parse(params.args[3]) : null; } catch { return false; }
  if (!options || typeof options !== "object") return false;
  // Voice can vary read limits/query phrasing; require the operation's semantic
  // target and check returned data separately, not just whether a tool was called.
  if (scenario.id === "github") return options.action === "issue_list" && options.repo === "andrewfurman/phone-claw";
  if (scenario.id === "history") return typeof options.query === "string" && /cli/i.test(options.query);
  if (scenario.id === "claude") return options.action === "auth_status";
  if (scenario.id === "web_fetch") { try { return new URL(options.url).hostname === "example.com"; } catch { return false; } }
  if (scenario.id === "web_search") return /python/i.test(options.query || "");
  return true;
}

export function validateSmokeResult(scenario, result) {
  if (result?.ok !== true) return false;
  const data = result.data;
  if (scenario.id === "native_cli") return /gh version \d/.test(result.stdout || "");
  if (scenario.id === "gws_agenda") return result.status !== "confirmation_required" && typeof (result.stdout || result.answer_text || "") === "string";
  if (scenario.id === "notes_recent") return result.status !== "confirmation_required" && typeof (result.stdout || result.answer_text || "") === "string";
  if (!data || data.ok !== true || result.data_truncated) return false;
  if (scenario.id === "github") return data.action === "issue_list" && Array.isArray(data.parsed_json);
  if (scenario.id === "rss") return Array.isArray(data.feeds);
  if (scenario.id === "email") return Array.isArray(data.items);
  if (scenario.id === "history") return Array.isArray(data.items);
  if (scenario.id === "otter") return data.parsed_json != null;
  if (scenario.id === "web_fetch") return data.status_code === 200 && /example domain/i.test(data.body_text || data.text || data.answer_text || "");
  if (scenario.id === "web_search") return Array.isArray(data.results) && data.results.length > 0 && (data.search_health ?? "ok") === "ok";
  if (scenario.id === "claude") return data.authenticated === true;
  return false;
}
