// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  slackMessageSend,
  slackRead,
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

function makeReadExecStub(messageCount = 20) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    // Always return more messages than typical limits to verify defensive slicing.
    const messages = Array.from({ length: messageCount }, (_, i) => ({
      user: "U1",
      text: `Message ${i + 1}`,
      ts: String(1700000000 + i), // increasing timestamps
      thread_ts: i % 2 === 0 ? String(1600000000 + i) : undefined,
      reply_count: i % 3 === 0 ? i : undefined,
    }));
    const users = [{ id: "U1", profile: { real_name: "Jane Doe" } }];
    const stdout = JSON.stringify({ messages, users, has_more: false });
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

test("slack read: passes limit and enforces defensively, trims fields", async () => {
  const { execFile, calls } = makeReadExecStub(25);
  const result = await slackRead({ channel: "#deploys", limit: 3, deps: { execFile, home: "/tmp" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  // Assert --limit 3 flag passed to slackcli
  const readCall = calls.find(c => c.args[0] === "conversations" && c.args[1] === "read");
  assert.ok(readCall, "should call slackcli conversations read");
  const limitIndex = readCall.args.findIndex(a => a === "--limit");
  assert.notEqual(limitIndex, -1, "should include --limit");
  assert.equal(readCall.args[limitIndex + 1], "3", "should pass the requested limit");
  // Defensive slicing applied and fields trimmed
  assert.equal(result.messages.length, 3, "should slice to requested limit");
  const keys = Object.keys(result.messages[0]).sort();
  assert.deepEqual(keys, ["text","thread_ts","time_ny","ts","user_name","reply_count"].sort());
  assert.equal(result.messages[0].user_name, "Jane Doe");
  assert.ok(typeof result.messages[0].time_ny === "string" && result.messages[0].time_ny.length > 0);
});

test("slack read: defaults to a voice-friendly limit of 10", async () => {
  const { execFile, calls } = makeReadExecStub(20);
  const result = await slackRead({ channel: "#general", deps: { execFile } });
  assert.equal(result.ok, true);
  // Default limit should be 10
  const readCall = calls[0];
  const limitIndex = readCall.args.findIndex(a => a === "--limit");
  assert.equal(readCall.args[limitIndex + 1], "10");
  assert.equal(result.messages.length, 10);
});

