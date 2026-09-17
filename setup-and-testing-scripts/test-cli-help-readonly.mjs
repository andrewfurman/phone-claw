import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUniversalCli, isHelpOnlyArgs } from "../fastify-app/universal-cli.mjs";
import { loadCliPrograms } from "../fastify-app/cli-programs.mjs";

test("help-only argv detection rejects flags before help", () => {
  assert.equal(isHelpOnlyArgs(["--help"]), true);
  assert.equal(isHelpOnlyArgs(["-h"]), true);
  assert.equal(isHelpOnlyArgs(["help"]), true);
  assert.equal(isHelpOnlyArgs(["calendar", "--help"]), true);
  assert.equal(isHelpOnlyArgs(["calendar", "events", "help"]), true);
  assert.equal(isHelpOnlyArgs(["calendar", "+agenda", "--help"]), true);
  assert.equal(isHelpOnlyArgs(["calendar", "--today", "--help"]), false);
  assert.equal(isHelpOnlyArgs(["-rf", "--help"]), false);
  assert.equal(isHelpOnlyArgs(["calendar", "+insert"]), false);
  assert.equal(isHelpOnlyArgs([]), false);
});

test("gws help forms are listed as operator-approved reads", () => {
  const previous = process.env.GENERIC_CLI_PROGRAMS_PATH;
  delete process.env.GENERIC_CLI_PROGRAMS_PATH;
  try {
    const allowed = new Set((loadCliPrograms().gws.readOnlyArgs || []).map(args => JSON.stringify(args)));
    for (const args of [["--help"], ["-h"], ["help"], ["calendar", "--help"], ["calendar", "events", "help"]]) {
      assert.equal(allowed.has(JSON.stringify(args)), true, args.join(" "));
    }
  } finally {
    if (previous === undefined) delete process.env.GENERIC_CLI_PROGRAMS_PATH;
    else process.env.GENERIC_CLI_PROGRAMS_PATH = previous;
  }
});

test("unconfirmed help-only native argv does not require confirmation (#109/#114)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phoneclaw-help-")));
  const fixture = join(root, "fixture-cli");
  const configPath = join(root, "programs.json");
  const previous = { ...process.env };
  try {
    process.env.GENERIC_CLI_ALLOWED_DIRS = root;
    process.env.GENERIC_CLI_PROGRAMS_PATH = configPath;
    writeFileSync(configPath, JSON.stringify({ fixture: { executable: fixture, env: [], readOnlyArgs: [["version"]] } }));
    writeFileSync(fixture, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const help = await runUniversalCli({ command: "fixture", args: ["calendar", "events", "--help"], cwd: root, confirmed: false });
    assert.equal(help.ok, true, JSON.stringify(help));
    assert.notEqual(help.status, "confirmation_required");
    const flagged = await runUniversalCli({ command: "fixture", args: ["--force", "--help"], cwd: root, confirmed: false });
    assert.equal(flagged.status, "confirmation_required");
    const writeish = await runUniversalCli({ command: "fixture", args: ["calendar", "+insert"], cwd: root, confirmed: false });
    assert.equal(writeish.status, "confirmation_required");
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});
