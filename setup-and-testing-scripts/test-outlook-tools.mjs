import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { installFakeOutlookCli } from "./outlook-fake-cli.mjs";

// Work Outlook runs the outlook-web-cli binary; here a fake binary records each call.
const fake = installFakeOutlookCli();
process.env.SOME_BRIDGE_API_KEY = "must-not-reach-the-binary";
const tools = await import("../fastify-app/outlook-tools.mjs");
const { commandAdapters } = await import("../fastify-app/cli-adapters.mjs");
const { outlookAgenda, outlookFreeBusy, outlookMessages, outlookRead, outlookSearch, outlookSession, outlookStatus, resolveWorkAccountAlias, runOutlookCli } = tools;

beforeEach(() => { fake.reset(); fake.scenario(""); });
after(() => { fake.cleanup(); delete process.env.SOME_BRIDGE_API_KEY; });
const last = () => fake.calls().at(-1);

test("each command runs `outlook-web-cli <cmd> --json <snake_case body>` with aliases resolved", async () => {
  const s = await outlookStatus({ account: "covernode" });
  assert.equal(s.ok, true);
  assert.equal(s.accounts[0].status, "signed_in");
  assert.deepEqual(last().argv, ["status", "--json", '{"account":"covernode"}']);

  const m = await outlookMessages({ account: "AD-GA", limit: 5, unread: false, from: "dia@ad-ga.com", since: "2026-11-01", folder: "sent" });
  assert.equal(m.items[0].id, "MSG_A");
  assert.equal(last().cmd, "messages");
  assert.deepEqual(last().body, { account: "adga", limit: 5, unread: false, from: "dia@ad-ga.com", since: "2026-11-01", folder: "sent" });
  assert.equal(last().yes, false);

  const r = await outlookRead({ account: "andrew@covernode.io", id: "READ_ID", maxBodyChars: 2000 });
  assert.match(r.body_text, /Line 1/);
  assert.deepEqual(last().body, { account: "covernode", id: "READ_ID", max_body_chars: 2000 });

  await outlookSearch({ account: "adgaoutlook", query: "invoice", limit: 1 });
  assert.deepEqual(last().body, { account: "adga", query: "invoice", limit: 1 });

  const a = await outlookAgenda({ account: "all", today: true });
  assert.equal(a.accounts[0].items[0].subject, "Standup");
  assert.deepEqual(last().body, { account: "all", today: true });

  // No account: every account (the binary decides); empty values are not sent.
  await outlookMessages({ account: "", limit: undefined, search: null });
  assert.deepEqual(last().body, {});
});

test("the child keeps HOME, gets the default inline image host, and no bridge secrets", async () => {
  await outlookStatus({});
  const { env } = last();
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.OUTLOOK_INLINE_IMAGE_HOSTS, "dmvr3d99h35se.cloudfront.net");
  assert.deepEqual(env.leaked, []);
  process.env.OUTLOOK_INLINE_IMAGE_HOSTS = "img.example.com";
  try {
    await outlookStatus({});
    assert.equal(last().env.OUTLOOK_INLINE_IMAGE_HOSTS, "img.example.com");
  } finally {
    delete process.env.OUTLOOK_INLINE_IMAGE_HOSTS;
  }
});

test("ok=false answers (exit 1) are parsed; crashes, timeouts and a missing binary are compact failures", async () => {
  const missing = await outlookFreeBusy({ tomorrow: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "missing_emails");

  fake.scenario("crash");
  const crashed = await outlookStatus({});
  assert.equal(crashed.ok, false);
  assert.equal(crashed.status, "cli_failed");
  assert.equal(crashed.exit_code, 101);
  assert.doesNotMatch(crashed.message, /abc\.def/);

  fake.scenario("garbage");
  assert.equal((await outlookStatus({})).status, "cli_failed");

  fake.scenario("slow");
  const slow = await runOutlookCli(["status", "--json", "{}"], { timeoutMs: 300 });
  assert.equal(slow.status, "cli_timeout");

  const absent = await runOutlookCli(["status"], { deps: { bin: "/nonexistent/outlook-web-cli" } });
  assert.equal(absent.status, "cli_not_installed");
});

test("injected execFile works without a binary", async () => {
  const seen = [];
  const execFile = (bin, args, opts, cb) => { seen.push({ bin, args, opts }); cb(Object.assign(new Error("exit 1"), { code: 1 }), '{"ok":false,"status":"needs_sign_in"}', ""); };
  const r = await outlookStatus({ account: "adga", deps: { execFile, bin: "/usr/local/bin/outlook-web-cli" } });
  assert.equal(r.status, "needs_sign_in");
  assert.equal(seen[0].bin, "/usr/local/bin/outlook-web-cli");
  assert.ok(seen[0].opts.timeout > 0 && seen[0].opts.maxBuffer >= 10_000_000);
});

test("freebusy: the adapter maps fields to snake_case", async () => {
  const r = await commandAdapters["outlook freebusy"]({ emails: "pat@covernode.io,sam@covernode.io", tomorrow: true, day_start: "08:00", dayEnd: "18:00", min_minutes: 45 }, {});
  assert.equal(r.ok, true);
  assert.equal(r.free_for_all.length, 1);
  assert.equal(last().cmd, "freebusy");
  assert.deepEqual(last().body, { emails: "pat@covernode.io,sam@covernode.io", tomorrow: true, day_start: "08:00", day_end: "18:00", min_minutes: 45 });
  await commandAdapters["outlook freebusy"]({ account: "cover node", people: ["a@covernode.io"], start: "2026-11-17T11:00", end_date: "2026-11-18" }, {});
  assert.deepEqual(last().body, { account: "covernode", emails: ["a@covernode.io"], start_date: "2026-11-17T11:00", end_date: "2026-11-18" });
});

test("session: auth status, or auth refresh --all [--rotate]", async () => {
  const s = await outlookSession();
  assert.deepEqual(last().argv, ["auth", "status"]);
  assert.equal(s.ok, true);
  assert.equal(s.status, "ok");
  assert.deepEqual(s.accounts.map((a) => a.account), ["covernode", "adga"]);
  assert.equal("config_dir" in s, false);
  fake.scenario("adga-unsaved");
  assert.equal((await outlookSession()).ok, false);
  fake.scenario("");

  const refreshed = await commandAdapters["outlook session"]({ refresh: true }, {});
  assert.deepEqual(last().argv, ["auth", "refresh", "--all"]);
  assert.equal(refreshed.ok, true);
  await commandAdapters["outlook session"]({ rotate: "true" }, {});
  assert.deepEqual(last().argv, ["auth", "refresh", "--all", "--rotate"]);
});

test("work-account email routing through the generic himalaya email commands", async () => {
  for (const a of ["covernode", "CoverNode", "cover node", "cover-node", "andrew@covernode.io", "covernode.io", "covernodeoutlook", "covernodework"]) assert.equal(resolveWorkAccountAlias(a), "covernode", a);
  for (const a of ["adga", "AD-GA", "ad ga", "andrew@ad-ga.com", "ad-ga.com", "adgaoutlook", "adgawork"]) assert.equal(resolveWorkAccountAlias(a), "adga", a);
  for (const a of ["", undefined, "all", "gmail", "default", "andrew@gmail.com"]) assert.equal(resolveWorkAccountAlias(a), null, String(a));

  const accounts = await commandAdapters["himalaya accounts"]({}, {});
  assert.deepEqual(accounts.accounts.map((a) => a.account), ["default", "covernode", "adga"]);

  const list = await commandAdapters["himalaya email-list"]({ account: "cover node", page_size: 2 }, {});
  assert.equal(list.items[0].id, "MSG_A");
  assert.deepEqual(last().body, { account: "covernode", limit: 2 });
  const found = await commandAdapters["himalaya email-list"]({ account: "AD-GA", query: "x" }, {});
  assert.equal(found.items[0].id, "MSG_S");
  assert.equal(last().cmd, "search");
  const read = await commandAdapters["himalaya email-read"]({ account: "andrew@covernode.io", id: "READ_ID" }, {});
  assert.match(read.body_text, /Line 1/);

  // send/forward/archive/media on a work account are refused, never sent to Gmail
  fake.reset();
  for (const name of ["himalaya email-send", "himalaya email-archive", "himalaya email-forward", "himalaya forward-draft", "himalaya email-images"]) {
    const blocked = await commandAdapters[name]({ account: "covernode", id: "1", to: "a@b.c", subject: "s", body: "b" }, { confirmed: true });
    assert.equal(blocked.ok, false, name);
    assert.equal(blocked.status, "work_account_read_only", name);
  }
  assert.equal(fake.calls().length, 0);

  // drafts on a work account go to Outlook (and still need confirmation), never to Gmail
  for (const name of ["himalaya draft-create", "himalaya reply-all-draft", "himalaya draft-reply"]) {
    const pending = await commandAdapters[name]({ account: "covernode", id: "1", to: "a@b.c", subject: "s", body: "b" }, {});
    assert.equal(pending.status, "confirmation_required", name);
    assert.equal(last().yes, false, name);
  }
});
