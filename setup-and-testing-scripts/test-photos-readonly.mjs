import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUniversalCli, isPhotosSafeReadArgs } from "../fastify-app/universal-cli.mjs";
import { photosEmail } from "../fastify-app/photos-tools.mjs";
import { sendgridEmailSend } from "../fastify-app/sendgrid-tools.mjs";

test("isPhotosSafeReadArgs allows known read-only Photos lookups (#112)", () => {
  for (const args of [
    ["recent"], ["recent", "-l", "3"], ["people", "--limit", "10"], ["albums"], ["stats"],
    ["person", "Emma"], ["person", "Lucy", "Furman", "-l", "2"], ["person", "Emma Furman"],
    ["date", "2024-09-24"], ["date", "2024-09-24", "--person", "Lucy", "-l", "5"],
    ["on-this-day"], ["on-this-day", "--date", "09-24", "--person", "Emma", "-l", "3"],
  ]) assert.equal(isPhotosSafeReadArgs(args), true, JSON.stringify(args));

  for (const args of [
    ["export", "9E12CC9C"], ["delete", "x"], ["recent", "extra"], ["recent", "-l", "7"],
    ["person"], ["person", "-x"], ["date", "Sept 24"], ["date", "2024-09-24", "--date", "09-24"],
    ["on-this-day", "--date", "9/24"], ["stats", "--person", "Emma"], ["recent", "-l", "3", "-l", "5"],
    ["person", "a", "b", "c", "d", "e"], [],
  ]) assert.equal(isPhotosSafeReadArgs(args), false, JSON.stringify(args));
});

test("photos/mac-photos reads skip confirmation; export and unknown commands do not", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-photos-")));
  const fixture = join(root, "mac-photos");
  const configPath = join(root, "programs.json");
  const previous = { ...process.env };
  try {
    process.env.GENERIC_CLI_ALLOWED_DIRS = root;
    process.env.GENERIC_CLI_PROGRAMS_PATH = configPath;
    const spec = { executable: fixture, env: [], readOnlyArgs: [["recent"], ["people"], ["albums"], ["stats"]], blockedArgs: [["export"]] };
    writeFileSync(configPath, JSON.stringify({ photos: spec, "mac-photos": spec }));
    writeFileSync(fixture, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    for (const command of ["photos", "mac-photos"]) {
      for (const args of [["recent"], ["person", "Emma", "-l", "3"], ["on-this-day", "--person", "Lucy"], ["date", "2024-09-24"]]) {
        const result = await runUniversalCli({ command, args, cwd: root, confirmed: false });
        assert.equal(result.ok, true, JSON.stringify({ command, args, result }));
      }
      for (const args of [["export", "9E12CC9C"], ["delete", "x"], ["recent", "-l", "99"]]) {
        const result = await runUniversalCli({ command, args, cwd: root, confirmed: false });
        assert.ok(["confirmation_required", "command_blocked"].includes(result.status), JSON.stringify({ command, args, result }));
      }
      const exported = await runUniversalCli({ command, args: ["export", "9E12CC9C"], cwd: root, confirmed: true });
      assert.equal(exported.status, "command_blocked", "raw export must stay blocked even when confirmed");
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});

const exportJson = JSON.stringify({
  ok: true, id: "9E12CC9C", taken: "2025-09-24 17:55:18", people: "Emma Furman, Kate Furman",
  note: "", source: "thumbnail", bytes: 4, jpeg_base64: "/9j/AA==",
});

test("photos email validates the id and requires confirmation before touching the Mac", async () => {
  let ran = false;
  const deps = { env: {}, executeCli: async () => { ran = true; return { ok: true, stdout: exportJson }; } };
  assert.equal((await photosEmail({ id: "nope", confirmed: true }, deps)).status, "invalid_photo_id");
  const pending = await photosEmail({ id: "9e12cc9c" }, deps);
  assert.equal(pending.status, "confirmation_required");
  assert.equal(pending.preview.to, "aifurman@gmail.com");
  assert.equal(pending.preview.from, "photos@aifurman.com");
  assert.equal(ran, false);
});

test("photos email sends the exported JPEG from photos@ to Andrew only", async () => {
  let sent;
  const result = await photosEmail({ id: "9E12CC9C", confirmed: true }, {
    env: { MAC_PHOTOS_BIN: "/fake/mac-photos" },
    executeCli: async (bin, args) => {
      assert.equal(bin, "/fake/mac-photos");
      assert.deepEqual(args, ["export", "9E12CC9C"]);
      return { ok: true, stdout: exportJson };
    },
    sendgridEmailSend: async (options) => { sent = options; return { ok: true, message_id: "m1" }; },
  });
  assert.equal(result.ok, true);
  assert.equal(sent.from, "photos@aifurman.com");
  assert.equal(sent.to, "aifurman@gmail.com");
  assert.equal(sent.attachments[0].type, "image/jpeg");
  assert.equal(sent.attachments[0].content, "/9j/AA==");
  assert.match(sent.subject, /Wed, Sep 24, 2025 with Emma Furman, Kate Furman/);
  assert.match(result.answer_text, /Emailed the photo from Wed, Sep 24, 2025/);
  assert.match(result.answer_text, /small version/);
});

test("photos email reports the Mac's reason when a photo is iCloud-only", async () => {
  const result = await photosEmail({ id: "80510224", confirmed: true }, {
    env: {},
    executeCli: async () => ({ ok: false, status: "cli_failed", stdout: "", stderr: "photos: That photo is only in iCloud and has no local copy on the Mac.\n" }),
    sendgridEmailSend: async () => assert.fail("must not send"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.answer_text, "That photo is only in iCloud and has no local copy on the Mac.");
});

test("sendgridEmailSend forwards attachments in the SendGrid payload", async () => {
  let payload;
  const result = await sendgridEmailSend({
    from: "photos@aifurman.com", to: "aifurman@gmail.com", subject: "Photo", body: "Here it is",
    attachments: [{ content: "/9j/AA==", filename: "photo 1.jpg", type: "image/jpeg" }],
    previewed: true, confirmed: true,
  }, {
    skipEnvLoad: true,
    env: { SENDGRID_API_KEY: "test-key" },
    fetchImpl: async (url, init) => { payload = JSON.parse(init.body); return new Response(null, { status: 202 }); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(payload.attachments, [{ content: "/9j/AA==", filename: "photo_1.jpg", type: "image/jpeg", disposition: "attachment" }]);
});
