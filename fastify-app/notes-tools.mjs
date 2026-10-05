import { executeCli } from "../shared/cli-process.mjs";

// Confirmed Apple Notes edits (#150). Runs `notes edit|create` on the Mac through the mac-notes SSH wrapper.
// Raw `notes edit/create` stay blocked for run_cli; this is the only write path. Every call first runs the
// Mac tool with --dry-run to resolve the note and the exact line, then needs a spoken preview
// (previewed=true) and Andrew's yes (confirmed=true from the outer run_cli flag, never the JSON payload).
// The save passes --expect with the preview's modified_at, so a note edited in between is never overwritten.
const DEFAULT_WRAPPER = "/home/phoneclaw/bin/mac-notes";
const OPS = new Set(["add", "remove", "replace", "create"]);
const MAX_LINE = 200;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const line = value => {
  const text = String(value ?? "").trim();
  return text && text.length <= MAX_LINE && !/[\r\n\0]/.test(text) ? text : null;
};
const list = value => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).map(line);

export function notesEditArgs(options) {
  const op = String(options.op || options.action || "").toLowerCase();
  if (!OPS.has(op)) return { error: fail("invalid_op", 'op must be "add", "remove", "replace" or "create".', "op") };
  if (op === "create") {
    const title = line(options.title);
    if (!title) return { error: fail("missing_field", "Give the new note a short title.", "title") };
    const lines = list(options.lines ?? options.line);
    if (lines.length > 10 || lines.some(x => !x)) return { error: fail("invalid_lines", "Give up to 10 lines, each under 200 characters.", "lines") };
    const folder = options.folder == null ? null : line(options.folder);
    if (options.folder != null && !folder) return { error: fail("invalid_folder", "Folder name is too long.", "folder") };
    return { op, args: ["create", "--title", title, ...lines.flatMap(x => ["--line", x]), ...(folder ? ["--folder", folder] : [])] };
  }
  const id = String(options.id ?? options.note_id ?? "").trim();
  if (!/^[1-9]\d{0,9}$/.test(id)) return { error: fail("invalid_id", "Find the note first (notes search or recent) and pass its numeric id.", "id") };
  if (op === "add") {
    const lines = list(options.lines ?? options.line ?? options.text);
    if (!lines.length || lines.length > 10 || lines.some(x => !x)) return { error: fail("invalid_lines", "Give 1 to 10 lines to add, each under 200 characters.", "lines") };
    return { op, id, args: ["edit", id, ...lines.flatMap(x => ["--add", x])] };
  }
  const target = line(options.line ?? options.target ?? options.text);
  if (!target) return { error: fail("missing_field", "Say which line to change.", "line") };
  if (op === "remove") return { op, id, args: ["edit", id, "--remove", target] };
  const replacement = line(options.with ?? options.new_text ?? options.replacement);
  if (!replacement) return { error: fail("missing_field", "Say what the line should become.", "with") };
  return { op, id, args: ["edit", id, "--replace", target, "--with", replacement] };
}

export async function notesEdit(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.executeCli || executeCli;
  const built = notesEditArgs(options);
  if (built.error) return built.error;
  const call = args => run(env.MAC_NOTES_BIN || DEFAULT_WRAPPER, args, {
    env: { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || "", MAC_SSH_ALIAS: env.MAC_SSH_ALIAS || "" },
    timeoutMs: Number(options.timeoutMs) || 60_000,
    maxBuffer: 1_000_000,
  });

  const dry = await call([...built.args, "--dry-run"]);
  if (dry.status === "cli_timeout") return fail("notes_timeout", "Apple Notes did not answer in time; nothing was changed.");
  const preview = parseJson(dry.stdout);
  if (!dry.ok || !preview?.ok) {
    const status = preview?.status || "notes_preview_failed";
    const candidates = Array.isArray(preview?.candidates) ? preview.candidates.slice(0, 8) : undefined;
    const why = { line_not_found: "No line in that note matches.", ambiguous_line: "More than one line matches; be more specific.", note_not_found: "That note id was not found." }[status];
    return { ...fail(status, `${why || preview?.message || "Could not prepare the change."} Nothing was changed.`), ...(candidates ? { candidates } : {}) };
  }
  const spoken = describe(built.op, preview);
  const view = { op: built.op, ...(built.id ? { id: built.id } : {}), title: preview.title, change: spoken, after_lines: (preview.after_lines || []).slice(0, 40), ...(preview.modified_at ? { expected_modified_at: preview.modified_at } : {}) };
  if (!options.previewed || !options.confirmed) {
    return {
      ok: false,
      status: "confirmation_required",
      action: options.previewed ? "notes_edit_confirmation_required" : "notes_edit_preview_required",
      requires_preview: !options.previewed,
      requires_confirmation: true,
      preview: view,
      message: `Read this aloud: "${spoken}". Ask "Do you want me to make this change?" Only after Andrew says yes, call again with the same fields, previewed=true, confirmed=true${preview.modified_at ? ` and expected_modified_at="${preview.modified_at}"` : ""}.`,
      answer_text: `Confirm with Andrew: ${spoken}`,
    };
  }
  const expect = String(options.expected_modified_at || preview.modified_at || "");
  if (built.op !== "create" && !ISO.test(expect)) return fail("invalid_expected_modified_at", "Pass expected_modified_at from the preview.", "expected_modified_at");
  const saved = await call(built.op === "create" ? built.args : [...built.args, "--expect", expect]);
  if (saved.status === "cli_timeout") return { ...fail("notes_save_timeout", "Saving to Apple Notes timed out, so the change is unconfirmed. Check the note before retrying."), preview: view };
  const result = parseJson(saved.stdout);
  if (!saved.ok || !result?.ok) {
    if (result?.status === "note_changed") return { ...fail("note_changed", "The note changed since the preview, so nothing was saved. Preview the change again."), preview: view };
    return { ...fail("notes_save_failed", `The change was not saved${result?.message ? `: ${result.message}` : "."}`), preview: view };
  }
  return {
    ok: true,
    status: "ok",
    action: built.op === "create" ? "notes_created" : "notes_updated",
    id: result.id || built.id,
    title: result.title,
    change: spoken,
    after_lines: (result.after_lines || []).slice(0, 40),
    answer_text: built.op === "create" ? `Created the note "${result.title}".` : `Updated "${result.title}": ${spoken}.`,
  };
}

function describe(op, p) {
  if (op === "create") return `Create a note "${p.title}"${p.folder ? ` in ${p.folder}` : ""}${p.after_lines?.length > 1 ? ` with ${p.after_lines.slice(1).join("; ")}` : ""}`;
  if (op === "add") return `Add ${p.added.join("; ")} to "${p.title}"`;
  if (op === "remove") return `Remove "${p.removed}" from "${p.title}"`;
  return `In "${p.title}", change "${p.replaced}" to "${p.with}"`;
}

function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try { return JSON.parse(text.split("\n").filter(Boolean).at(-1)); } catch { return null; }
}

function fail(status, message, field) {
  return { ok: false, status, ...(field ? { field } : {}), message, answer_text: message };
}
