import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUniversalCli, isNotesSafeReadArgs } from "../fastify-app/universal-cli.mjs";

const NOTES_LIMITS = ["1", "2", "3", "5", "10", "20"];

test("isNotesSafeReadArgs allows read by numeric id and simple search forms", () => {
  assert.equal(isNotesSafeReadArgs(["read", "21"]), true);
  assert.equal(isNotesSafeReadArgs(["read", "1"]), true);
  assert.equal(isNotesSafeReadArgs(["search", "supplements"]), true);
  assert.equal(isNotesSafeReadArgs(["search", "Trader Joe's"]), true);
  assert.equal(isNotesSafeReadArgs(["search", "supplements", "-l", "5"]), true);
  assert.equal(isNotesSafeReadArgs(["search", "--limit", "10", "vitamins"]), true);
  assert.equal(isNotesSafeReadArgs(["search", "-f", "Shopping", "milk"]), true);
  assert.equal(isNotesSafeReadArgs(["search", "list", "--folder", "Notes", "-l", "3"]), true);
});

test("isNotesSafeReadArgs rejects writes, view, and unsafe flags", () => {
  assert.equal(isNotesSafeReadArgs(["view", "21"]), false);
  assert.equal(isNotesSafeReadArgs(["read"]), false);
  assert.equal(isNotesSafeReadArgs(["read", "21", "--force"]), false);
  assert.equal(isNotesSafeReadArgs(["read", "0"]), false);
  assert.equal(isNotesSafeReadArgs(["read", "-1"]), false);
  assert.equal(isNotesSafeReadArgs(["read", "abc"]), false);
  assert.equal(isNotesSafeReadArgs(["search"]), false);
  assert.equal(isNotesSafeReadArgs(["search", "-l", "5"]), false);
  assert.equal(isNotesSafeReadArgs(["search", "x", "-l", "99"]), false);
  assert.equal(isNotesSafeReadArgs(["search", "x", "-a", "2026-01-01"]), false);
  assert.equal(isNotesSafeReadArgs(["create", "title"]), false);
  assert.equal(isNotesSafeReadArgs(["delete", "title"]), false);
  assert.equal(isNotesSafeReadArgs(["edit", "21"]), false);
  assert.equal(isNotesSafeReadArgs(["index"]), false);
  assert.equal(isNotesSafeReadArgs(["recent", "-l", "5"]), false); // exact allowlist, not pattern
});

test("notes/mac-notes unconfirmed recent, read, and search skip confirmation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-notes-")));
  const fixture = join(root, "mac-notes");
  const configPath = join(root, "programs.json");
  const previous = { ...process.env };
  const readOnlyArgs = [["recent"], ...NOTES_LIMITS.flatMap(limit => [["recent", "-l", limit], ["recent", "--limit", limit]]), ["folders"], ["stats"]];
  try {
    process.env.GENERIC_CLI_ALLOWED_DIRS = root;
    process.env.GENERIC_CLI_PROGRAMS_PATH = configPath;
    writeFileSync(configPath, JSON.stringify({
      notes: { executable: fixture, env: [], readOnlyArgs, blockedArgs: [["create"], ["delete"], ["edit"], ["index"]] },
      "mac-notes": { executable: fixture, env: [], readOnlyArgs, blockedArgs: [["create"], ["delete"], ["edit"], ["index"]] },
    }));
    writeFileSync(fixture, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });

    for (const command of ["notes", "mac-notes"]) {
      for (const args of [
        ["recent"],
        ["recent", "-l", "5"],
        ["recent", "--limit", "10"],
        ["recent", "-l", "20"],
        ["read", "21"],
        ["search", "supplements"],
        ["search", "supplements", "-l", "5"],
      ]) {
        const result = await runUniversalCli({ command, args, cwd: root, confirmed: false });
        assert.equal(result.ok, true, JSON.stringify({ command, args, result }));
        assert.notEqual(result.status, "confirmation_required", `${command} ${args.join(" ")}`);
      }

      for (const args of [["view", "21"], ["create", "x"], ["delete", "x"], ["edit", "1"], ["index"], ["recent", "-l", "99"], ["search", "x", "-a", "2020-01-01"]]) {
        const result = await runUniversalCli({ command, args, cwd: root, confirmed: false });
        assert.ok(result.status === "confirmation_required" || result.status === "command_blocked", JSON.stringify({ command, args, result }));
      }
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});
