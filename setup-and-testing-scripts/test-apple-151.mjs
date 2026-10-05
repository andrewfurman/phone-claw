import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolveRecipient, contactsSearch } from "../fastify-app/contacts-tools.mjs";
import { photosEdit, photosFaces, photosAnalyze, imessageSendPhoto } from "../fastify-app/photos-tools.mjs";

// Offline tests for #151 (Contacts, photo faces/analysis/edits, photo iMessages). Stubs stand in for the
// mac-contacts / mac-photos / mac-imsg SSH wrappers and the vision gateway; nothing touches a Mac or sends.
const out = obj => ({ ok: obj.ok !== false, status: "ok", stdout: JSON.stringify(obj) + "\n", stderr: "" });
const router = handlers => {
  const calls = [];
  const run = async (exe, args) => { calls.push({ exe, args }); const h = handlers[args[0]]; return h ? h(args) : out({ ok: false, message: "unexpected" }); };
  return { calls, deps: { env: { MAC_PHOTOS_BIN: "/p", MAC_IMSG_BIN: "/i", MAC_CONTACTS_BIN: "/c" }, executeCli: run } };
};
const people = (...matches) => ({ search: () => out({ ok: true, total_matches: matches.length, matches }) });
const KATE = { name: "Kate Furman", phones: [{ label: "mobile", number: "+15550000001" }], emails: [{ label: "home", address: "kate@example.com" }] };

test("contacts: one person resolves; several people or numbers come back as candidates", async () => {
  assert.deepEqual(await resolveRecipient("Kate Furman", router(people(KATE)).deps), { ok: true, to: "+15550000001", name: "Kate Furman", label: "mobile" });
  const two = await resolveRecipient("Kate", router(people(KATE, { ...KATE, name: "Kate Demek" })).deps);
  assert.equal(two.status, "ambiguous_contact"); assert.equal(two.candidates.length, 2);
  const exactWins = await resolveRecipient("kate furman", router(people(KATE, { ...KATE, name: "Kate Furmanski" })).deps);
  assert.equal(exactWins.to, "+15550000001");
  const many = await resolveRecipient("Joe", router(people({ name: "Joe", phones: [{ label: "work", number: "+15550000002" }, { label: "home", number: "+15550000003" }], emails: [] })).deps);
  assert.equal(many.status, "ambiguous_number");
  assert.equal((await resolveRecipient("Nobody", router(people()).deps)).status, "contact_not_found");
  assert.equal((await contactsSearch({ query: "rm -rf /" }, router({}).deps)).status, "invalid_query");
});

test("photos edit: dry run + preview, saves only when previewed and confirmed, reports read-back mismatch", async () => {
  const preview = { ok: true, action: "photos_meta_preview", id: "01308B40", taken: "2026-09-28 17:44:16", people: "Emma Furman", before: { title: "", description: "" }, after: { title: "", description: "Pumpkin patch" } };
  for (const flags of [{}, { previewed: true }, { confirmed: true }]) {
    const r = router({ "set-meta": () => out(preview) });
    const res = await photosEdit({ id: "01308b40", description: "Pumpkin patch", ...flags }, r.deps);
    assert.equal(res.status, "confirmation_required"); assert.match(res.preview.change, /caption "\(none\)" to "Pumpkin patch"/);
    assert.equal(r.calls.length, 1); assert.ok(r.calls[0].args.includes("--dry-run"));
  }
  let r = router({ "set-meta": args => out(args.includes("--dry-run") ? preview : { ok: true, action: "photos_meta_updated", read_back: { title: "", description: "Pumpkin patch" } }) });
  const saved = await photosEdit({ id: "01308B40", description: "Pumpkin patch", previewed: true, confirmed: true }, r.deps);
  assert.equal(saved.action, "photos_edited"); assert.deepEqual(r.calls[1].args, ["set-meta", "01308B40", "--description", "Pumpkin patch"]);
  r = router({ "set-meta": args => out(args.includes("--dry-run") ? preview : { ok: false, action: "photos_meta_mismatch", read_back: { title: "", description: "x" } }) });
  assert.equal((await photosEdit({ id: "01308B40", description: "Pumpkin patch", previewed: true, confirmed: true }, r.deps)).status, "photos_meta_mismatch");
  assert.equal((await photosEdit({ id: "nope", title: "x" }, router({}).deps)).status, "invalid_photo_id");
  assert.equal((await photosEdit({ id: "01308B40" }, router({}).deps)).status, "missing_field");
});

test("photo iMessage: name resolution, preview gates, then export-file + imsg send --file", async () => {
  const handlers = { ...people(KATE), meta: () => out({ ok: true, id: "01308B40", taken: "2026-09-28 17:44:16", people: "Emma Furman" }), "export-file": () => out({ ok: true, path: "/Users/andrew/Pictures/PhoneClaw/photo-01308B40.jpg", source: "thumbnail" }), send: () => out({ ok: true }) };
  let r = router(handlers);
  const pre = await imessageSendPhoto({ to: "Kate Furman", id: "01308B40", text: "Look!" }, r.deps);
  assert.equal(pre.status, "confirmation_required"); assert.match(pre.preview.change, /^Text Kate Furman at \+15550000001 the photo from/);
  assert.ok(!r.calls.some(c => c.args[0] === "send" || c.args[0] === "export-file"));
  r = router(handlers);
  const sent = await imessageSendPhoto({ to: "Kate Furman", id: "01308B40", text: "Look!", previewed: true, confirmed: true }, r.deps);
  assert.equal(sent.action, "imessage_photo_sent");
  assert.deepEqual(r.calls.at(-1).args, ["send", "--to", "+15550000001", "--file", "/Users/andrew/Pictures/PhoneClaw/photo-01308B40.jpg", "--text", "Look!", "--service", "imessage", "--json"]);
  r = router(people(KATE, { ...KATE, name: "Kate Demek" }));
  assert.equal((await imessageSendPhoto({ to: "Kate", id: "01308B40", previewed: true, confirmed: true }, r.deps)).status, "ambiguous_contact");
});

test("faces and analysis are bounded reads", async () => {
  const f = await photosFaces({ id: "01308B40" }, router({ faces: () => out({ ok: true, action: "photos_faces", id: "01308B40", face_count: 3, people: ["Emma Furman"], unnamed_faces: 2 }) }).deps);
  assert.equal(f.answer_text, "3 faces detected: Emma Furman, plus 2 unnamed.");
  const seen = [];
  const deps = { ...router({ export: () => out({ ok: true, taken: "2026-09-28 17:44:16", people: "Emma Furman", source: "preview", jpeg_base64: "AAAA" }) }).deps,
    analyzeImagesWithGateway: async args => { seen.push(args); return { ok: true, model: "m", description: "Two girls at a pumpkin patch.", answer_text: "They're at a pumpkin patch." }; } };
  const a = await photosAnalyze({ id: "01308B40", question: "x".repeat(400) }, deps);
  assert.equal(a.action, "photos_analyzed"); assert.equal(seen[0].images.length, 1); assert.ok(seen[0].prompt.length < 420);
});

test("raw photo writes stay blocked in the example program policy", () => {
  const cfg = JSON.parse(readFileSync(new URL("../config/cli-programs.example.json", import.meta.url)));
  const progs = cfg.programs || cfg;
  for (const k of ["photos", "mac-photos"]) for (const verb of ["export", "set-meta", "export-file"]) assert.ok(progs[k].blockedArgs.some(b => b.length === 1 && b[0] === verb), `${k} ${verb}`);
});
