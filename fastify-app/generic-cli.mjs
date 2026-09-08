import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;
const DEFAULT_MAX_RAW_BYTES = 200_000;
const MAX_RAW_BYTES = 750_000;
const MAX_COMMAND_CHARS = 8_000;

const DEFAULT_ENV_ALLOWLIST = [
  "NO_COLOR",
  "TERM",
  "LANG",
  "LC_ALL",
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GH_HOST",
  "GH_REPO",
  "HIMALAYA_CONFIG",
  "CLAUDE_CONFIG_DIR",
];

const BLOCKED_TOKENS = [
  "printenv",
  "export -p",
  "set -o xtrace",
  "gpg --export-secret",
];

const BLOCKED_PATH_FRAGMENTS = [
  ".env",
  "bridge.env",
  ".secrets",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "/.config/gh",
  "/.config/himalaya",
  "/.config/gcloud",
  "/.config/aws",
  "/.aws/",
  "/.otterai",
  "/.claude",
];

// These commands have no caller-controlled paths, expansions, or shell syntax.
// Everything else needs confirmation, including otherwise read-only CLI commands.
const READ_ONLY_COMMAND = /^(?:pwd(?: -[LP])?|ls(?: -[aAlh1d]+)*)$/;
const FORBIDDEN_ENV_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|DATABASE_URL|PRIVATE_KEY|^BASH_FUNC_|^BASH_ENV$|^ENV$|^SHELLOPTS$|^BASHOPTS$|^LD_|^DYLD_|^NODE_OPTIONS$|^PYTHONPATH$|^PYTHONSTARTUP$|^PERL5OPT$|^RUBYOPT$/i;
// PATH/HOME and CLI config locations are operator settings, never tool overrides.
const REQUEST_ENV_KEYS = new Set(["NO_COLOR", "TERM", "LANG", "LC_ALL"]);
export const GENERIC_CLI_POLICY_VERSION = "2026-09-08.1";

/**
 * Generic VM CLI executor for ElevenLabs / bridge tools.
 * Runs a raw shell command as the bridge process user (phoneclaw on the VM),
 * with confirmation by default, filtered environment, real-path cwd checks,
 * and best-effort secret redaction. Confirmed shell execution is not a sandbox.
 */
export async function runGenericCli({
  command,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  confirmed = false,
  env = {},
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
} = {}) {
  const normalizedCommand = normalizeString(command);
  if (!normalizedCommand) {
    return missingField("command", "A shell command string is required.");
  }

  if (normalizedCommand.length > MAX_COMMAND_CHARS) {
    return {
      ok: false,
      status: "command_too_long",
      message: `Commands must be at most ${MAX_COMMAND_CHARS} characters.`,
      answer_text: "That command is too long to run through the generic CLI tool.",
      stdout: "",
      stderr: "",
      exit_code: null,
    };
  }

  const blocked = findBlockedReason(normalizedCommand);
  if (blocked) {
    return {
      ok: false,
      status: "command_blocked",
      reason: blocked,
      command: summarizeCommand(normalizedCommand),
      message: blocked,
      answer_text: blocked,
      stdout: "",
      stderr: "",
      exit_code: null,
    };
  }

  const classification = classifyGenericCliCommand(normalizedCommand);
  if (classification.needs_confirmation && !isConfirmed(confirmed)) {
    return {
      ok: false,
      status: "confirmation_required",
      reason: classification.reason,
      command: summarizeCommand(normalizedCommand),
      message: classification.reason,
      answer_text: classification.reason,
      stdout: "",
      stderr: "",
      exit_code: null,
    };
  }

  const cwdResult = resolveAllowedWorkingDirectory(cwd);
  if (!cwdResult.ok) return cwdResult;

  const timeout = clampInteger(timeoutMs, 1_000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const rawLimit = clampInteger(maxRawBytes, 1_000, MAX_RAW_BYTES, DEFAULT_MAX_RAW_BYTES);
  const childEnv = buildChildEnv(env);

  const result = await execShellCommand(normalizedCommand, {
    readOnly: classification.kind === "safe",
    cwd: cwdResult.cwd,
    timeoutMs: timeout,
    env: childEnv,
    maxRawBytes: rawLimit,
  });

  return {
    ...result,
    policy_version: GENERIC_CLI_POLICY_VERSION,
    command: summarizeCommand(normalizedCommand),
    working_directory: cwdResult.cwd,
    confirmation_bypassed: classification.needs_confirmation && isConfirmed(confirmed),
    classification: classification.kind,
  };
}

export function classifyGenericCliCommand(command) {
  const text = normalizeString(command);
  if (!text) {
    return {
      kind: "invalid",
      needs_confirmation: false,
      reason: "A shell command string is required.",
    };
  }

  const blocked = findBlockedReason(text);
  if (blocked) {
    return {
      kind: "blocked",
      needs_confirmation: false,
      reason: blocked,
    };
  }

  return READ_ONLY_COMMAND.test(text)
    ? { kind: "safe", needs_confirmation: false, reason: "" }
    : {
        kind: "dangerous",
        needs_confirmation: true,
        reason: "Confirm the exact shell command with Andrew before calling run_cli with confirmed=true. Only pwd and ls with supported flags run without confirmation; prefer specialized tools for other read-only actions.",
      };
}

export function findBlockedReason(command) {
  const text = normalizeString(command);
  const lowered = text.toLowerCase();

  for (const token of BLOCKED_TOKENS) {
    if (lowered.includes(token.toLowerCase())) {
      return "That command is blocked because it may dump secrets or credentials into tool output.";
    }
  }

  for (const fragment of BLOCKED_PATH_FRAGMENTS) {
    if (lowered.includes(fragment.toLowerCase())) {
      return "That command is blocked because it may dump secrets or credentials into tool output.";
    }
  }

  if (/\b(base64|xxd|od)\b/i.test(text) && /(secret|token|password|credential|\.env|id_rsa)/i.test(text)) {
    return "That command is blocked because it may dump secrets or credentials into tool output.";
  }

  if (/^(env|export)\s*$/i.test(text) || /[;&|]\s*(env|export)\s*$/i.test(text)) {
    return "That command is blocked because it may dump secrets or credentials into tool output.";
  }

  return "";
}

function resolveAllowedWorkingDirectory(cwd) {
  const requested = normalizeString(cwd, process.cwd());
  let resolved;
  try {
    resolved = realpathSync(resolve(requested));
    if (!statSync(resolved).isDirectory()) throw new Error("Not a directory");
  } catch {
    return {
      ok: false, status: "working_directory_not_allowed",
      message: "The working directory must exist and be an allowed directory.",
      answer_text: "The working directory must exist and be an allowed directory.",
      stdout: "", stderr: "", exit_code: null,
    };
  }
  const allowedDirs = (
    process.env.GENERIC_CLI_ALLOWED_DIRS ||
    process.env.CLAUDE_CODE_ALLOWED_DIRS ||
    process.cwd()
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try { return [realpathSync(resolve(value))]; } catch { return []; }
    });

  for (const allowedDir of allowedDirs) {
    const rel = relative(allowedDir, resolved);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return { ok: true, cwd: resolved };
    }
  }

  return {
    ok: false,
    status: "working_directory_not_allowed",
    working_directory: resolved,
    allowed_directories: allowedDirs,
    message: "That working directory is not allow-listed for generic CLI execution.",
    answer_text: "That working directory is not allow-listed for generic CLI execution.",
    stdout: "",
    stderr: "",
    exit_code: null,
  };
}

function buildChildEnv(requestedEnv) {
  const allowlist = new Set(
    (process.env.GENERIC_CLI_ENV_ALLOWLIST || DEFAULT_ENV_ALLOWLIST.join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );

  const childEnv = {};
  for (const key of allowlist) {
    if (!FORBIDDEN_ENV_KEY.test(key) && process.env[key] !== undefined) {
      childEnv[key] = process.env[key];
    }
  }
  childEnv.NO_COLOR = "1";
  childEnv.PATH ||= "/usr/local/bin:/usr/bin:/bin";
  const source =
    requestedEnv && typeof requestedEnv === "object" && !Array.isArray(requestedEnv)
      ? requestedEnv
      : {};

  for (const [key, value] of Object.entries(source)) {
    if (!allowlist.has(key) || !REQUEST_ENV_KEYS.has(key)) continue;
    if (value == null) continue;
    childEnv[key] = String(value);
  }

  return childEnv;
}

function execShellCommand(command, { cwd, timeoutMs, env, maxRawBytes, readOnly }) {
  const shell = process.env.GENERIC_CLI_SHELL || "/bin/bash";
  // Bypass shell and PATH lookup for the tiny unconfirmed command allowlist.
  const [program, ...args] = command.split(" ");
  const executable = readOnly ? `/bin/${program}` : shell;
  const executableArgs = readOnly ? args : ["--noprofile", "--norc", "-c", command];

  return new Promise((resolveResult) => {
    try {
      execFile(
        executable,
        executableArgs,
        {
          cwd,
          env,
          timeout: timeoutMs,
          maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const cleanStdout = redact(stdout || "");
          const cleanStderr = redact(stderr || "");
          const truncatedStdout = truncateUtf8(cleanStdout, maxRawBytes);
          const truncatedStderr = truncateUtf8(cleanStderr, Math.min(10_000, maxRawBytes));

          if (error) {
            const timedOut = Boolean(error.killed);
            resolveResult({
              ok: false,
              status: timedOut ? "cli_timeout" : "cli_failed",
              timeout_ms: timeoutMs,
              exit_code: typeof error.code === "number" ? error.code : null,
              signal: error.signal || null,
              message: truncatedStderr.value.trim() || redact(error.message) || "CLI command failed.",
              stdout: truncatedStdout.value,
              stdout_truncated: truncatedStdout.truncated,
              stderr: truncatedStderr.value,
              answer_text: timedOut
                ? `The command timed out after ${timeoutMs}ms.`
                : truncatedStderr.value.trim() ||
                  redact(error.message) ||
                  "The CLI command failed.",
            });
            return;
          }

          resolveResult({
            ok: true,
            status: "ok",
            timeout_ms: timeoutMs,
            exit_code: 0,
            signal: null,
            message: "CLI command completed successfully.",
            stdout: truncatedStdout.value,
            stdout_truncated: truncatedStdout.truncated,
            stderr: truncatedStderr.value,
            answer_text: formatSuccessAnswer(truncatedStdout.value, truncatedStderr.value),
          });
        }
      );
    } catch (error) {
      resolveResult({
        ok: false,
        status: "cli_spawn_failed",
        timeout_ms: timeoutMs,
        exit_code: null,
        signal: null,
        message: error?.message || "CLI command failed to start.",
        stdout: "",
        stdout_truncated: false,
        stderr: "",
        answer_text: error?.message || "The CLI command failed to start.",
      });
    }
  });
}

function formatSuccessAnswer(stdout, stderr) {
  const text = String(stdout || "").trim();
  if (text) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    return `Command succeeded. Output preview: ${preview}`;
  }
  if (String(stderr || "").trim()) {
    return "Command succeeded with no stdout; stderr was returned.";
  }
  return "Command succeeded with no output.";
}

function summarizeCommand(command) {
  return redact(truncateUtf8(command, 500).value);
}

function missingField(field, message) {
  return {
    ok: false,
    status: "missing_field",
    field,
    message,
    answer_text: message,
    stdout: "",
    stderr: "",
    exit_code: null,
  };
}

function redact(value) {
  return String(value || "")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_[redacted]")
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, "gh_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|api_key|token|password|secret)"?\s*[:=]\s*")[^"]+/gi,
      "$1[redacted]"
    )
    .replace(/(AKIA[0-9A-Z]{16})/g, "[redacted-aws-key]")
    .replace(homedir(), "~");
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { value: text, truncated: false };
  }

  return {
    value: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function isConfirmed(value) {
  return value === true || value === "true";
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
