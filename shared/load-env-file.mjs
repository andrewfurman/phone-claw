import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENV_PATHS = [
  path.resolve(process.cwd(), ".env"),
  "/etc/phoneclaw/bridge.env",
];

/**
 * Parse KEY=VALUE env file text without shell-sourcing.
 * Preserves shell metacharacters such as & in unquoted values.
 * Supports optional export prefix, double/single quotes, comments, and blank lines.
 */
export function parseEnvFileContent(content) {
  const parsed = {};
  if (content == null) return parsed;

  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let body = line;
    if (body.startsWith("export ")) {
      body = body.slice(7).trim();
    }

    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    parsed[key] = unquoteEnvValue(body.slice(eq + 1));
  }

  return parsed;
}

export function loadEnvFile(filePath, { override = false, env = process.env } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { loaded: false, path: filePath || null, appliedKeys: [] };
  }

  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseEnvFileContent(content);
  const appliedKeys = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (!override && env[key] !== undefined) continue;
    env[key] = value;
    appliedKeys.push(key);
  }

  return { loaded: true, path: filePath, appliedKeys };
}

/**
 * Load local `.env` and/or `/etc/phoneclaw/bridge.env` into process.env
 * without shell-sourcing. Existing process.env keys win unless override is set.
 * `.env` is applied before bridge.env so local values take precedence when both exist.
 */
export function loadPhoneclawEnv({
  override = false,
  env = process.env,
  paths = DEFAULT_ENV_PATHS,
} = {}) {
  const results = [];
  for (const filePath of paths) {
    results.push(loadEnvFile(filePath, { override, env }));
  }
  return {
    loaded: results.some((result) => result.loaded),
    results,
  };
}

function unquoteEnvValue(raw) {
  const value = String(raw);
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      return value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1);
    }
  }
  // Keep metacharacters (&, ;, |, etc.). Only trim trailing whitespace.
  return value.trimEnd();
}
