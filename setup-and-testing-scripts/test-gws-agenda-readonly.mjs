import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCliPrograms } from "../fastify-app/cli-programs.mjs";

test("gws calendar +agenda exact argv lists are operator-approved reads (#114)", () => {
  const previous = process.env.GENERIC_CLI_PROGRAMS_PATH;
  delete process.env.GENERIC_CLI_PROGRAMS_PATH;
  try {
    const programs = loadCliPrograms();
    const allowed = new Set((programs.gws.readOnlyArgs || []).map(args => JSON.stringify(args)));
    for (const args of [
      ["calendar", "+agenda"],
      ["calendar", "+agenda", "--today"],
      ["calendar", "+agenda", "--tomorrow"],
      ["calendar", "+agenda", "--week"],
      ["calendar", "+agenda", "--format", "json"],
      ["calendar", "+agenda", "--format", "table"],
      ["calendar", "+agenda", "--today", "--format", "table"],
      ["calendar", "+agenda", "--days", "3"],
      ["calendar", "+agenda", "--timezone", "America/New_York"],
      ["calendar", "+agenda", "--today", "--timezone", "America/New_York"],
    ]) {
      assert.equal(allowed.has(JSON.stringify(args)), true, `missing readOnlyArgs ${args.join(" ")}`);
    }
    assert.equal(allowed.has(JSON.stringify(["--version"])), true);
    assert.equal(allowed.has(JSON.stringify(["calendar", "+insert"])), false);
    assert.equal(allowed.has(JSON.stringify(["calendar", "+agenda", "--execute", "bad"])), false);
  } finally {
    if (previous === undefined) delete process.env.GENERIC_CLI_PROGRAMS_PATH;
    else process.env.GENERIC_CLI_PROGRAMS_PATH = previous;
  }
});
