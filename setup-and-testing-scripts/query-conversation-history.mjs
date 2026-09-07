import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
import {
  conversationHistoryConfigured,
  conversationHistoryGet,
  conversationHistorySearch,
  conversationRecentContext,
} from "../fastify-app/conversation-history.mjs";

// Load .env /etc/phoneclaw/bridge.env in-process. Do not shell-source bridge.env:
// unquoted & in CONVERSATION_DATABASE_URL query strings backgrounds the assignment.
loadPhoneclawEnv();

const args = process.argv.slice(2);
const action =
  args.find((arg) => !arg.startsWith("--")) ||
  (hasFlag("--get") || hasValue("--conversation-id") ? "get" : hasFlag("--recent") ? "recent" : "search");

if (hasFlag("--help") || hasFlag("-h")) {
  printUsage();
  process.exit(0);
}

if (!conversationHistoryConfigured()) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        status: "conversation_history_not_configured",
        message:
          "Set CONVERSATION_DATABASE_URL, NEON_DATABASE_URL, or DATABASE_URL before querying.",
      },
      null,
      2
    )
  );
  process.exit(1);
}

const result = await runAction(action);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

async function runAction(name) {
  switch (name) {
    case "search":
      return conversationHistorySearch({
        query: value("--query") || value("--q") || "",
        startDate: value("--start-date") || value("--start"),
        endDate: value("--end-date") || value("--end"),
        limit: value("--limit"),
      });
    case "get":
      return conversationHistoryGet({
        conversationId: value("--conversation-id") || value("--id"),
        includeTranscript: hasFlag("--include-transcript"),
        includeToolDetails: hasFlag("--include-tool-details"),
        maxTranscriptTurns: value("--max-transcript-turns"),
        maxToolItems: value("--max-tool-items"),
      });
    case "recent":
      return conversationRecentContext({
        limit: value("--limit"),
      });
    default:
      return {
        ok: false,
        status: "unknown_action",
        message: `Unknown action "${name}". Use search, get, or recent.`,
        answer_text: "Unknown conversation-history query action.",
      };
  }
}

function value(flag) {
  const prefix = `${flag}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return undefined;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function hasValue(flag) {
  return Boolean(value(flag));
}

function printUsage() {
  console.log(`Usage:
  node setup-and-testing-scripts/query-conversation-history.mjs search [--query=...] [--start-date=...] [--end-date=...] [--limit=10]
  node setup-and-testing-scripts/query-conversation-history.mjs get --conversation-id=ID [--include-transcript] [--include-tool-details]
  node setup-and-testing-scripts/query-conversation-history.mjs recent [--limit=10]

Requires CONVERSATION_DATABASE_URL (or NEON_DATABASE_URL / DATABASE_URL).
Loads ./.env and /etc/phoneclaw/bridge.env in-process (no shell source).
`);
}
