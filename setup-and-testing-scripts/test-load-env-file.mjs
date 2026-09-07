import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadEnvFile,
  loadPhoneclawEnv,
  parseEnvFileContent,
} from "../shared/load-env-file.mjs";

const checks = {};

const fixtureWithAmpersand = `
# bridge-style env fixture (do not shell-source)
HOST=127.0.0.1
# Unquoted URL with & must remain intact for systemd EnvironmentFile and JS loaders.
CONVERSATION_DATABASE_URL=postgres://user:pass@db.example/neondb?sslmode=require&channel_binding=require
export CLI_BRIDGE_TOKEN=token-value
HIMALAYA_ARCHIVE_FOLDER="[Gmail]/All Mail"
QUOTED_URL='postgres://example/db?a=1&b=2'
EMPTY_VALUE=
123BAD=should_skip
`.trimStart();

const parsed = parseEnvFileContent(fixtureWithAmpersand);
checks.parses_host = parsed.HOST === "127.0.0.1";
checks.preserves_unquoted_ampersand =
  parsed.CONVERSATION_DATABASE_URL ===
  "postgres://user:pass@db.example/neondb?sslmode=require&channel_binding=require";
checks.preserves_ampersand_in_url = String(parsed.CONVERSATION_DATABASE_URL).includes(
  "&channel_binding=require"
);
checks.supports_export_prefix = parsed.CLI_BRIDGE_TOKEN === "token-value";
checks.supports_double_quotes = parsed.HIMALAYA_ARCHIVE_FOLDER === "[Gmail]/All Mail";
checks.supports_single_quotes = parsed.QUOTED_URL === "postgres://example/db?a=1&b=2";
checks.allows_empty_value = parsed.EMPTY_VALUE === "";
checks.skips_invalid_key = parsed["123BAD"] === undefined;
checks.ignores_comments = parsed.HOST === "127.0.0.1";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phoneclaw-env-"));
const fixturePath = path.join(tempDir, "bridge.env");
fs.writeFileSync(fixturePath, fixtureWithAmpersand, "utf8");

const env = {};
const loaded = loadEnvFile(fixturePath, { env });
checks.load_env_file_ok = loaded.loaded === true;
checks.load_sets_database_url =
  env.CONVERSATION_DATABASE_URL ===
  "postgres://user:pass@db.example/neondb?sslmode=require&channel_binding=require";

env.CONVERSATION_DATABASE_URL = "already-set";
const noOverride = loadEnvFile(fixturePath, { env, override: false });
checks.respects_existing_env =
  env.CONVERSATION_DATABASE_URL === "already-set" &&
  !noOverride.appliedKeys.includes("CONVERSATION_DATABASE_URL");

const missing = loadEnvFile(path.join(tempDir, "missing.env"), { env: {} });
checks.missing_file_is_noop = missing.loaded === false && missing.appliedKeys.length === 0;

const localEnvPath = path.join(tempDir, ".env");
fs.writeFileSync(
  localEnvPath,
  "LOCAL_ONLY=from-dotenv\nCONVERSATION_DATABASE_URL=postgres://local/db?x=1&y=2\n",
  "utf8"
);
const phoneclawEnv = {};
const multi = loadPhoneclawEnv({
  env: phoneclawEnv,
  paths: [localEnvPath, fixturePath],
});
checks.load_phoneclaw_env_both_files = multi.loaded === true;
checks.dotenv_wins_on_conflict =
  phoneclawEnv.CONVERSATION_DATABASE_URL === "postgres://local/db?x=1&y=2";
checks.bridge_fills_missing_keys = phoneclawEnv.HOST === "127.0.0.1";
checks.local_only_present = phoneclawEnv.LOCAL_ONLY === "from-dotenv";

fs.rmSync(tempDir, { recursive: true, force: true });

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      checks,
      verified:
        "parse/load bridge.env-style fixtures with unquoted & in CONVERSATION_DATABASE_URL; quotes; export; no shell source",
    },
    null,
    2
  )
);
process.exit(ok ? 0 : 1);
