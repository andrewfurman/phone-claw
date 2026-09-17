import { runGenericCli, resolveAllowedWorkingDirectory, findBlockedReason, redact, truncateUtf8 } from "./generic-cli.mjs";
import { commandAdapters } from "./cli-adapters.mjs";
import { CLI_COMMAND_CATALOG } from "../shared/cli-command-catalog.mjs";
import { loadCliPrograms, programEnvironment } from "./cli-programs.mjs";
import { executeCli } from "../shared/cli-process.mjs";

export const UNIVERSAL_CLI_VERSION = "2026-09-17.2";
const confirmedValue = value => value === true || value === "true";

const HELP_TOKENS = new Set(["help", "--help", "-h"]);
const isPathPiece = arg => typeof arg === "string" && arg.length > 0 && arg.length < 64 && !arg.startsWith("-") && !arg.includes("\0");
/**
 * Help-only native argv never needs confirmation (#109).
 * Allow: only help flags; leading `help` + path pieces; or final help/--help/-h with only path pieces before.
 * Reject flags mixed with help (except pure help-token lists) so `--help && write` style argv cannot sneak through.
 */
export function isHelpOnlyArgs(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 16) return false;
  if (!args.every(arg => typeof arg === "string" && arg.length > 0 && arg.length < 64 && !arg.includes("\0"))) return false;
  if (args.every(arg => HELP_TOKENS.has(arg))) return true;
  if (args[0] === "help" && args.slice(1).every(isPathPiece)) return true;
  const last = args[args.length - 1];
  if (!HELP_TOKENS.has(last)) return false;
  return args.slice(0, -1).every(isPathPiece);
}

const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) && value != null ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
const failure = (status, message) => ({ ok: false, status, message, answer_text: message, stdout: "", stderr: "", exit_code: null });
const guidance = "Use run_cli with command=phoneclaw and args=[group, action, --json, JSON options]. Put confirmed=true on run_cli only after the exact action is confirmed.";

export async function runUniversalCli({ command, args, cwd, confirmed, env, timeoutMs, maxRawBytes } = {}) {
  // Existing raw commands remain supported with the hardened #100 policy.
  if (args === undefined && command !== "phoneclaw") {
    return { ...await runGenericCli({ command, cwd, confirmed, env, timeoutMs, maxRawBytes }), runner_version: UNIVERSAL_CLI_VERSION };
  }
  const budget = clamp(maxRawBytes, 1_000, 750_000, 32_000);
  const timeout = clamp(timeoutMs, 1_000, 60_000, 25_000);
  if (typeof command !== "string" || !command || /[\0\r\n]/.test(command) || !Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || Buffer.byteLength(JSON.stringify([command, args])) > 65_536) {
    return failure("invalid_arguments", "Supply an executable name and an array of literal string arguments (at most 64 KiB).");
  }
  const directory = resolveAllowedWorkingDirectory(cwd);
  if (!directory.ok) return directory;
  const metadata = { runner_version: UNIVERSAL_CLI_VERSION, command: redact(command), working_directory: directory.cwd, timeout_ms: timeout };
  let result;
  try {
    if (command === "phoneclaw") {
      result = await runPhoneclaw(args, confirmedValue(confirmed), timeout);
    } else {
      const programs = loadCliPrograms();
      const spec = Object.hasOwn(programs, command) ? programs[command] : { executable: command, env: [] };
      const blocked = findBlockedReason([command, ...args].join(" ")) || (spec.blockedArgs || []).some(prefix => prefix.every((arg, i) => args[i] === arg));
      if (blocked) return { ...metadata, ...failure("command_blocked", "This command can expose credentials or bypass a protected workflow. Use the corresponding phoneclaw command.") };
      const readOnly = isHelpOnlyArgs(args) || (spec.readOnlyArgs || []).some(allowed => allowed.length === args.length && allowed.every((arg, i) => args[i] === arg));
      if (!readOnly && !confirmedValue(confirmed)) return { ...metadata, ...failure("confirmation_required", "Confirm the exact executable and arguments before setting confirmed=true. For existing read operations, use the phoneclaw commands in the command guide.") };
      const ran = await executeCli(spec.executable, args, { cwd: directory.cwd, env: programEnvironment(spec, env), timeoutMs: timeout });
      result = { ...ran, answer_text: ran.ok ? "Command completed. Use stdout for the result." : `${ran.status}. A timed-out or failed write may have taken effect; check before retrying.` };
    }
  } catch {
    // Do not expose commands, auth-bearing fetch errors, or configuration contents.
    result = failure("cli_execution_error", "The command failed. Check the bridge configuration and private diagnostics.");
  }
  return capResult({ ...metadata, ...result }, budget);
}

async function runPhoneclaw(args, confirmed, timeoutMs) {
  if (!args.length || (args.length === 1 && ["help", "--help"].includes(args[0]))) {
    return { ok: true, status: "ok", stdout: "", stderr: "", exit_code: 0, data: CLI_COMMAND_CATALOG.map(({ command, parameters }) => ({ command, parameters })), answer_text: guidance };
  }
  const name = args.slice(0, 2).join(" ");
  if (!Object.hasOwn(commandAdapters, name)) return failure("unknown_command", guidance);
  if (args.length === 3 && args[2] === "--help") {
    return { ok: true, status: "ok", data: CLI_COMMAND_CATALOG.find(item => item.command === name), stdout: "", stderr: "", exit_code: 0, answer_text: guidance };
  }
  if (args.length !== 2 && !(args.length === 4 && args[2] === "--json")) return failure("invalid_arguments", "Use group action followed by optional --json and one JSON object argument.");
  let body = {};
  try { if (args.length === 4) body = JSON.parse(args[3]); } catch { return failure("invalid_arguments", "--json must contain a valid JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure("invalid_arguments", "--json must contain a JSON object.");
  // Payload booleans may never elevate the outer authorization envelope.
  body.confirmed = confirmed;
  const markSeen = body.mark_seen ?? body.markSeen;
  if (name === "himalaya email-read" && markSeen && markSeen !== "false" && !confirmed) return failure("confirmation_required", "Confirm marking the selected email as read.");
  let timer;
  try {
    const result = await Promise.race([
      commandAdapters[name](body, { confirmed }),
      new Promise(resolve => { timer = setTimeout(() => resolve(failure("cli_timeout", "The command exceeded its response deadline; a write may still be in progress. Do not retry automatically.")), timeoutMs); }),
    ]);
    return { ok: result.ok === true, status: result.status || (result.ok ? "ok" : "cli_failed"), data: result, stdout: "", stderr: "", exit_code: result.ok ? 0 : null, answer_text: result.answer_text || result.message || "Command returned a structured result." };
  } finally { clearTimeout(timer); }
}

function capResult(result, budget) {
  const safe = redactStructured(result);
  // Preserve the actual resolved cwd contract; home abbreviation is for output.
  safe.working_directory = result.working_directory;
  const encoded = JSON.stringify(safe.data ?? safe.stdout ?? "");
  if (safe.data !== undefined && Buffer.byteLength(encoded) > budget) {
    delete safe.data;
    safe.stdout = truncateUtf8(encoded, budget).value;
    safe.data_truncated = true;
    safe.stdout_truncated = true;
  } else if (safe.stdout) {
    const cut = truncateUtf8(safe.stdout, budget);safe.stdout = cut.value;safe.stdout_truncated = cut.truncated;
  }
  safe.stderr = truncateUtf8(safe.stderr || "", Math.min(budget, 4_000)).value;
  safe.answer_text = truncateUtf8(safe.answer_text || "", 4_000).value;
  return safe;
}

function redactStructured(value) {
  if (typeof value === "string") return redact(value, { abbreviateHome: false });
  if (Array.isArray(value)) return value.map(redactStructured);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(access_token|refresh_token|api_key|token|password|secret)$/i.test(key) && entry
      ? "[redacted]" : redactStructured(entry),
  ]));
}
