// Live Apple Notes edit test (#150) through the deployed Worker -> bridge -> mac-notes -> Notes path, on a
// disposable note. Creates "Zebra test list" (or NOTES_EDIT_TEST_TITLE), then add / replace / remove a line and
// checks a stale save is refused. Leaves the note in place for the phone test; delete it in Notes afterwards.
//   node setup-and-testing-scripts/test-notes-edit-live.mjs --write
import assert from "node:assert/strict";
import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
if (!process.env.WEB_SEARCH_TOKEN) loadPhoneclawEnv();
if (!process.argv.includes("--write")) throw new Error("Pass --write: this creates and edits a real Apple Note.");
const env = process.env, title = env.NOTES_EDIT_TEST_TITLE || "Zebra test list";
const base = new URL("/cli/run", env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com");
async function cli(body) {
  const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.WEB_SEARCH_TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  assert.equal(r.status, 200); return r.json();
}
const edit = async (options, confirmed) => (await cli({ command: "phoneclaw", args: ["notes", "edit", "--json", JSON.stringify(options)], confirmed })).data;
const read = async id => JSON.parse((await cli({ command: "notes", args: ["read", id] })).stdout).note.text.split("\n").map(x => x.trim()).filter(Boolean);
const steps = [];
async function apply(options) {
  const preview = await edit(options, false);
  assert.equal(preview.status, "confirmation_required", JSON.stringify(preview).slice(0, 300));
  const saved = await edit({ ...options, previewed: true, expected_modified_at: preview.preview.expected_modified_at }, true);
  assert.equal(saved.ok, true, JSON.stringify(saved).slice(0, 300));
  steps.push({ op: options.op, change: saved.change, action: saved.action });
  return { preview, saved };
}
const created = await apply({ op: "create", title, lines: ["- Apples", "- Bananas"] });
const id = String(created.saved.id);
await apply({ op: "add", id, lines: ["Carrots"] });
await apply({ op: "replace", id, line: "bananas", with: "Blueberries" });
const removal = await apply({ op: "remove", id, line: "apples" });
let lines = await read(id);
assert.deepEqual(lines, [title, "- Blueberries", "- Carrots"]);
const stale = await edit({ op: "add", id, lines: ["Dates"], previewed: true, expected_modified_at: removal.preview.preview.expected_modified_at }, true);
assert.equal(stale.status, "note_changed");
const missing = await edit({ op: "remove", id, line: "kiwi" }, false);
assert.equal(missing.status, "line_not_found");
lines = await read(id);
assert.deepEqual(lines, [title, "- Blueberries", "- Carrots"]);
console.log(JSON.stringify({ ok: true, note_id: id, steps, stale_refused: true, missing_line_reported: true, final_lines: lines }, null, 2));
