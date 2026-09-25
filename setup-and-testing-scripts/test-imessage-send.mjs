import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUniversalCli } from "../fastify-app/universal-cli.mjs";
import { imessageSend, normalizeRecipient } from "../fastify-app/imessage-tools.mjs";

// Offline tests for confirmed iMessage send (#140). A stub executeCli stands in
// for the mac-imsg SSH wrapper, so nothing is ever sent.
const stubRun = (result = { ok: true, status: "ok", stdout: '{"ok":true}\n', stderr: "" }) => {
  const calls = [];
  const run = async (executable, args, options) => { calls.push({ executable, args, options }); return result; };
  return { calls, run };
};

test("normalizeRecipient accepts phones and emails, rejects junk", () => {
  assert.equal(normalizeRecipient("(585) 313-4343"), "+15853134343");
  assert.equal(normalizeRecipient("1 585 313 4343"), "+15853134343");
  assert.equal(normalizeRecipient("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeRecipient("AIFurman@Gmail.com"), "aifurman@gmail.com");
  for (const bad of ["", "mom", "12345", "not-an-email@", "+0123", "585-313-434"]) {
    assert.equal(normalizeRecipient(bad), null, bad);
  }
});

test("validation fails before touching the Mac", async () => {
  const { calls, run } = stubRun();
  const deps = { env: {}, executeCli: run };
  assert.equal((await imessageSend({ to: "mom", text: "hi", previewed: true, confirmed: true }, deps)).status, "invalid_recipient");
  assert.equal((await imessageSend({ to: "+15551234567", text: "  ", previewed: true, confirmed: true }, deps)).status, "missing_field");
  assert.equal((await imessageSend({ to: "+15551234567", text: "x".repeat(1001), previewed: true, confirmed: true }, deps)).status, "text_too_long");
  assert.equal((await imessageSend({ to: "+15551234567", text: "hi", service: "carrier-pigeon", previewed: true, confirmed: true }, deps)).status, "invalid_service");
  assert.equal(calls.length, 0);
});

test("preview, then confirmation, then send", async () => {
  const { calls, run } = stubRun();
  const deps = { env: { MAC_IMSG_BIN: "/fake/mac-imsg", MAC_SSH_ALIAS: "quickservers" }, executeCli: run };
  const message = { to: "585-313-4343", text: "Running late, see you at 6" };

  const preview = await imessageSend(message, deps);
  assert.equal(preview.status, "confirmation_required");
  assert.equal(preview.action, "imessage_send_preview_required");
  assert.deepEqual(preview.preview, { to: "+15853134343", text: "Running late, see you at 6", service: "imessage" });

  const unconfirmed = await imessageSend({ ...message, previewed: true }, deps);
  assert.equal(unconfirmed.action, "imessage_send_confirmation_required");
  assert.equal(calls.length, 0, "must not send before confirmation");

  const sent = await imessageSend({ ...message, previewed: true, confirmed: true }, deps);
  assert.equal(sent.ok, true);
  assert.equal(sent.action, "imessage_sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/fake/mac-imsg");
  assert.deepEqual(calls[0].args, ["send", "--to", "+15853134343", "--text", "Running late, see you at 6", "--service", "imessage", "--json"]);
  assert.equal(calls[0].options.env.MAC_SSH_ALIAS, "quickservers");
});

test("timeouts and failures are reported as unconfirmed, never as sent", async () => {
  const msg = { to: "+15551234567", text: "hi", previewed: true, confirmed: true };
  const timedOut = await imessageSend(msg, { env: {}, executeCli: stubRun({ ok: false, status: "cli_timeout", stdout: "", stderr: "" }).run });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.action, "imessage_send_timeout");
  assert.match(timedOut.message, /unconfirmed/);
  const failed = await imessageSend(msg, { env: {}, executeCli: stubRun({ ok: false, status: "cli_failed", stdout: "", stderr: "Messages not signed in" }).run });
  assert.equal(failed.action, "imessage_send_failed");
  assert.match(failed.message, /Messages not signed in/);
});

test("optional recipient allowlist", async () => {
  const { calls, run } = stubRun();
  const env = { IMESSAGE_ALLOWED_RECIPIENTS: "aifurman@gmail.com, (585) 313-4343" };
  const blocked = await imessageSend({ to: "+15551234567", text: "hi", previewed: true, confirmed: true }, { env, executeCli: run });
  assert.equal(blocked.status, "recipient_not_allowed");
  const allowed = await imessageSend({ to: "5853134343", text: "hi", previewed: true, confirmed: true }, { env, executeCli: run });
  assert.equal(allowed.ok, true);
  assert.equal(calls.length, 1);
});

test("run_cli: payload cannot self-confirm; raw imsg sends stay blocked even when confirmed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-imsg-")));
  const fixture = join(root, "mac-imsg");
  const configPath = join(root, "programs.json");
  const previous = { ...process.env };
  try {
    process.env.GENERIC_CLI_ALLOWED_DIRS = root;
    process.env.GENERIC_CLI_PROGRAMS_PATH = configPath;
    process.env.MAC_IMSG_BIN = fixture;
    const example = JSON.parse(readFileSync(new URL("../config/cli-programs.example.json", import.meta.url), "utf8"));
    const spec = { ...example.imsg, executable: fixture, env: [] };
    writeFileSync(configPath, JSON.stringify({ imsg: spec, "mac-imsg": spec }));
    writeFileSync(fixture, `#!${process.execPath}\nconsole.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));\n`, { mode: 0o700 });

    const body = JSON.stringify({ to: "+15551234567", text: "hi", previewed: true, confirmed: true });
    const selfConfirmed = await runUniversalCli({ command: "phoneclaw", args: ["imessage", "send", "--json", body], cwd: root, confirmed: false });
    assert.equal(selfConfirmed.status, "confirmation_required", "payload confirmed=true must not count");

    const sent = await runUniversalCli({ command: "phoneclaw", args: ["imessage", "send", "--json", body], cwd: root, confirmed: true });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.data.action, "imessage_sent");
    assert.deepEqual(sent.data.output.argv.slice(0, 3), ["send", "--to", "+15551234567"]);

    for (const command of ["imsg", "mac-imsg"]) {
      for (const args of [["send", "--to", "+15551234567", "--text", "hi"], ["send-rich", "x"], ["send-sticker", "x"], ["poll", "x"], ["tapback", "x"], ["edit", "x"], ["unsend", "x"], ["read", "x"], ["react", "x"]]) {
        const result = await runUniversalCli({ command, args, cwd: root, confirmed: true });
        assert.equal(result.status, "command_blocked", JSON.stringify({ command, args, result }));
      }
      const chats = await runUniversalCli({ command, args: ["chats", "--limit", "3"], cwd: root, confirmed: false });
      assert.equal(chats.ok, true, "allowlisted read must not need confirmation");
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});
