#!/usr/bin/env node
import { CLI_COMMAND_CATALOG } from "../shared/cli-command-catalog.mjs";

// A real terminal client for the same universal command interface used by voice.
// Auth comes from the operator environment, never a command-line token argument.
const argv = process.argv.slice(2);
if (!argv.length || (argv.length === 1 && ["help", "--help"].includes(argv[0]))) {
  console.log("phoneclaw <group> <action> [--json '<object>'] [--confirmed]\n");
  console.log(CLI_COMMAND_CATALOG.map(item => item.command).join("\n"));
  process.exit(0);
}
let confirmed = false;
if (argv.at(-1) === "--confirmed") { confirmed = true; argv.pop(); }
const base = process.env.PHONECLAW_CLI_URL || "http://127.0.0.1:8000";
const token = process.env.CLI_BRIDGE_TOKEN || process.env.WEB_SEARCH_TOKEN;
const url = new URL("cli/run", base.endsWith("/") ? base : base + "/");
if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS or localhost for PHONECLAW_CLI_URL.");
if (!token) throw new Error("Set CLI_BRIDGE_TOKEN in the protected environment before invoking the bridge.");
try {
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ command: "phoneclaw", args: argv, confirmed }), signal: AbortSignal.timeout(65_000), redirect: "error" });
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch {
  console.error("Bridge request failed or timed out. A write may have taken effect; check before retrying.");
  process.exitCode = 1;
}
