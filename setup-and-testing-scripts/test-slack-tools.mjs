// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  slackMessageSend,
} from "../fastify-app/slack-tools.mjs";

function makeExecStub() {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    // Simulate a successful send returning JSON {channel_id, ts, permalink}
    const stdout = JSON.stringify({ channel_id: "C123", ts: "1234567890.123456", permalink: "https://example.slack.com/archives/C123/p1234567890123456" });
    cb(null, stdout, "");
  };
  return { execFile, calls };
}

test("slack send: preview does not send", async () => {
  const { execFile, calls } = makeExecStub();
  const result = await slackMessageSend(
    { to: "#deploys", text: "Ship now" , deps: { execFile, randomId: () => "abc123", nowMs: () => 1_000 } },
    { confirmed: false }
  );
  assert.equal(result.status, "confirmation_required", JSON.stringify(result));
  assert.ok(result.confirmation_id, "preview should return a confirmation_id");
  assert.equal(calls.length, 0, "preview must not execute slackcli");
});

test("slack send: wrong/expired/modified confirmation is rejected", async () => {
  const deps = { randomId: () => "tok1", nowMs: () => 1_000 };
  const preview = await slackMessageSend({ to: "#general", text: "Hello", deps }, { confirmed: false });
  assert.equal(preview.status, "confirmation_required");
  const wrong = await slackMessageSend(
    { to: "#general", text: "Hello", previewed: true, confirmation_id: "wrong", deps },
    { confirmed: true }
  );
  assert.equal(wrong.status, "invalid_confirmation", JSON.stringify(wrong));

  // Expired
  const expired = await slackMessageSend(
    { to: "#general", text: "Hello", previewed: true, confirmation_id: preview.confirmation_id, deps: { ...deps, nowMs: () => 1_000 + (2 * 60 * 1000) + 1 } },
    { confirmed: true }
  );
  assert.equal(expired.status, "confirmation_expired", JSON.stringify(expired));

  // Modified
  const preview2 = await slackMessageSend({ to: "#general", text: "Hello", deps: { ...deps, randomId: () => "tok2", nowMs: () => 5_000 } }, { confirmed: false });
  const modified = await slackMessageSend(
    { to: "#general", text: "Hello (edited)", previewed: true, confirmation_id: preview2.confirmation_id, deps: { ...deps, nowMs: () => 5_500 } },
    { confirmed: true }
  );
  assert.equal(modified.status, "confirmation_mismatch", JSON.stringify(modified));
});

test("slack send: matching id sends exactly once", async () => {
  const { execFile, calls } = makeExecStub();
  const deps = { execFile, randomId: () => "tok3", nowMs: () => 9_000 };
  const preview = await slackMessageSend({ to: "@andrew", text: "Test message", deps }, { confirmed: false });
  const sent = await slackMessageSend(
    { to: "@andrew", text: "Test message", previewed: true, confirmation_id: preview.confirmation_id, deps },
    { confirmed: true }
  );
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.action, "slack_message_sent");
  assert.equal(calls.length, 1, "should call slackcli exactly once");
  assert.equal(calls[0].args[0], "messages");
  assert.equal(calls[0].args[1], "send");
  assert.ok(calls[0].args.includes("--recipient-id"));
  assert.ok(calls[0].args.includes("--message"));
  assert.ok(calls[0].args.includes("--json"));
});

