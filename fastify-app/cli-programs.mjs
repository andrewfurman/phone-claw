import { readFileSync } from "node:fs";
import { buildChildEnv } from "./generic-cli.mjs";

const INJECTION_KEY = /^(BASH_FUNC_|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|LD_|DYLD_|NODE_OPTIONS$|PYTHONPATH$|PYTHONSTARTUP$|PERL5OPT$|RUBYOPT$)/i;
const BRIDGE_SECRET = /^(CLI_BRIDGE_TOKEN|WEB_SEARCH_TOKEN|COMMAND_BRIDGE_TOKEN|ELEVENLABS_API_KEY|TWILIO_.*|CONVERSATION_DATABASE_URL)$/;

// Credential access is scoped to a direct executable, never to arbitrary shell.
// Exact readOnlyArgs only: a prefix allowlist would let extra flags change the
// meaning of an otherwise harmless command. Unknown commands require confirmation.
export function loadCliPrograms() {
  const programs = {
    gh: { executable: process.env.GH_BIN || "gh", env: ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"], readOnlyArgs: [["--version"], ["--help"], ["-h"], ["help"]], blockedArgs: [["auth", "token"], ["auth", "status", "--show-token"]] },
    gws: {
      executable: process.env.GWS_BIN || "gws",
      env: ["GOOGLE_WORKSPACE_CLI_CONFIG_DIR", "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"],
      // Exact read-only agenda lookups (#114). Writes (+insert, events insert/patch/delete) stay confirmation-gated.
      readOnlyArgs: [
        ["--version"],
        ["--help"],
        ["-h"],
        ["help"],
        ["calendar", "--help"],
        ["calendar", "-h"],
        ["calendar", "help"],
        ["calendar", "events", "--help"],
        ["calendar", "events", "help"],
        ["calendar", "+agenda"],
        ["calendar", "+agenda", "--today"],
        ["calendar", "+agenda", "--tomorrow"],
        ["calendar", "+agenda", "--week"],
        ["calendar", "+agenda", "--format", "json"],
        ["calendar", "+agenda", "--format", "table"],
        ["calendar", "+agenda", "--today", "--format", "json"],
        ["calendar", "+agenda", "--today", "--format", "table"],
        ["calendar", "+agenda", "--tomorrow", "--format", "json"],
        ["calendar", "+agenda", "--tomorrow", "--format", "table"],
        ["calendar", "+agenda", "--week", "--format", "json"],
        ["calendar", "+agenda", "--week", "--format", "table"],
        ["calendar", "+agenda", "--days", "1"],
        ["calendar", "+agenda", "--days", "3"],
        ["calendar", "+agenda", "--days", "7"],
        ["calendar", "+agenda", "--timezone", "America/New_York"],
        ["calendar", "+agenda", "--today", "--timezone", "America/New_York"],
        ["calendar", "+agenda", "--tomorrow", "--timezone", "America/New_York"],
        ["calendar", "+agenda", "--week", "--timezone", "America/New_York"],
      ],
      blockedArgs: [["auth", "export"]],
    },
    himalaya: { executable: process.env.HIMALAYA_BIN || "himalaya", env: ["HIMALAYA_CONFIG"], readOnlyArgs: [["--version"], ["--help"], ["-h"], ["help"]], blockedArgs: [["message", "send"], ["template", "send"]] },
    otter: { executable: process.env.OTTER_BIN || "otter", env: [], readOnlyArgs: [["--version"], ["--help"], ["-h"], ["help"]] },
    claude: { executable: process.env.CLAUDE_BIN || "claude", env: ["CLAUDE_CONFIG_DIR"], readOnlyArgs: [["--version"], ["--help"], ["-h"], ["help"]] },
  };
  if (process.env.GENERIC_CLI_PROGRAMS_PATH) {
    const config = JSON.parse(readFileSync(process.env.GENERIC_CLI_PROGRAMS_PATH, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid CLI programs configuration");
    for (const [name, spec] of Object.entries(config)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || name === "phoneclaw") throw new Error("Invalid CLI program name");
      programs[name] = spec;
    }
  }
  for (const spec of Object.values(programs)) {
    if (!spec || typeof spec.executable !== "string" || !spec.executable || spec.executable.includes("\0")) throw new Error("Invalid CLI executable");
    if (spec.env !== undefined && (!Array.isArray(spec.env) || spec.env.some(key => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || INJECTION_KEY.test(key) || BRIDGE_SECRET.test(key)))) throw new Error("Invalid CLI environment allowlist");
    for (const key of ["readOnlyArgs", "blockedArgs"]) {
      if (spec[key] !== undefined && (!Array.isArray(spec[key]) || spec[key].some(args => !Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))))) throw new Error("Invalid CLI argument policy");
    }
  }
  return programs;
}

export function programEnvironment(spec, overrides) {
  const env = buildChildEnv(overrides);
  for (const key of spec?.env || []) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
