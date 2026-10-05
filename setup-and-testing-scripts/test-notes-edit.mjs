import assert from "node:assert/strict";
import { test } from "node:test";
import { notesEdit, notesEditArgs } from "../fastify-app/notes-tools.mjs";
import { runUniversalCli } from "../fastify-app/universal-cli.mjs";

// Offline tests for confirmed Apple Notes edits (#150). A stub stands in for the mac-notes SSH wrapper,
// so no note is ever touched.
const DRY = { ok: true, action: "notes_edit_preview", dry_run: true, modified_at: "2026-10-05T16:00:00.000Z", id: "21", title: "Trader Joe’s", op: "remove", removed: "- Sparkling water", after_lines: ["Trader Joe’s", "- Berries"] };
const SAVED = { ok: true, action: "notes_updated", id: "21", title: "Trader Joe’s", after_lines: ["Trader Joe’s", "- Berries"] };
const stub = (...outputs) => {
  const calls = [];
  const run = async (executable, args) => { calls.push({ executable, args }); const out = outputs[Math.min(calls.length - 1, outputs.length - 1)]; return { ok: out.ok, status: "ok", stdout: JSON.stringify(out) + "\n", stderr: "" }; };
  return { calls, run, deps: { env: {}, executeCli: run } };
};

test("argument validation happens before touching the Mac", () => {
  assert.equal(notesEditArgs({ op: "delete", id: "21" }).error.status, "invalid_op");
  assert.equal(notesEditArgs({ op: "add", id: "x", lines: ["eggs"] }).error.status, "invalid_id");
  assert.equal(notesEditArgs({ op: "add", id: "21", lines: [] }).error.status, "invalid_lines");
  assert.equal(notesEditArgs({ op: "add", id: "21", lines: ["a\nb"] }).error.status, "invalid_lines");
  assert.equal(notesEditArgs({ op: "replace", id: "21", line: "milk" }).error.status, "missing_field");
  assert.equal(notesEditArgs({ op: "create", lines: ["x"] }).error.status, "missing_field");
  assert.deepEqual(notesEditArgs({ op: "add", id: "21", lines: ["Eggs", "Bread"] }).args, ["edit", "21", "--add", "Eggs", "--add", "Bread"]);
  assert.deepEqual(notesEditArgs({ op: "replace", id: "21", line: "milk", with: "oat milk" }).args, ["edit", "21", "--replace", "milk", "--with", "oat milk"]);
  assert.deepEqual(notesEditArgs({ op: "create", title: "Packing", lines: ["Socks"], folder: "Notes" }).args, ["create", "--title", "Packing", "--line", "Socks", "--folder", "Notes"]);
});

test("no preview or no yes: dry run only, exact spoken change returned", async () => {
  for (const flags of [{}, { previewed: true }, { confirmed: true }]) {
    const { calls, deps } = stub(DRY);
    const r = await notesEdit({ op: "remove", id: "21", line: "sparkling water", ...flags }, deps);
    assert.equal(r.status, "confirmation_required");
    assert.equal(r.preview.change, 'Remove "- Sparkling water" from "Trader Joe’s"');
    assert.equal(r.preview.expected_modified_at, DRY.modified_at);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("--dry-run"));
  }
});

test("previewed + confirmed saves with --expect from the caller", async () => {
  const { calls, deps } = stub(DRY, SAVED);
  const r = await notesEdit({ op: "remove", id: "21", line: "sparkling water", previewed: true, confirmed: true, expected_modified_at: "2026-10-05T15:59:00.000Z" }, deps);
  assert.equal(r.ok, true); assert.equal(r.action, "notes_updated");
  assert.deepEqual(calls[1].args, ["edit", "21", "--remove", "sparkling water", "--expect", "2026-10-05T15:59:00.000Z"]);
  assert.ok(!calls[1].args.includes("--dry-run"));
});

test("stale note, missing line and ambiguity are reported and nothing is saved", async () => {
  let s = stub(DRY, { ok: false, status: "note_changed" });
  assert.equal((await notesEdit({ op: "remove", id: "21", line: "x", previewed: true, confirmed: true }, s.deps)).status, "note_changed");
  s = stub({ ok: false, status: "ambiguous_line", candidates: ["- Red apples", "- Green apples"] });
  const amb = await notesEdit({ op: "remove", id: "21", line: "apples", previewed: true, confirmed: true }, s.deps);
  assert.equal(amb.status, "ambiguous_line"); assert.deepEqual(amb.candidates, ["- Red apples", "- Green apples"]); assert.equal(s.calls.length, 1);
});

test("raw notes edit/create stay blocked through run_cli; confirmation comes only from the outer flag", async () => {
  const { calls, deps } = stub(DRY);
  const r = await notesEdit({ op: "remove", id: "21", line: "x", previewed: true, confirmed: "yes please" === true }, deps);
  assert.equal(r.status, "confirmation_required"); assert.equal(calls.length, 1);
  const raw = await runUniversalCli({ command: "notes", args: ["edit", "21", "--remove", "milk"], confirmed: false, env: {} }).catch(e => ({ status: "error", message: String(e) }));
  assert.notEqual(raw.ok, true);
});
