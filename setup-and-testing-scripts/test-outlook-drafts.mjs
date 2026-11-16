import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { installFakeOutlookCli } from "./outlook-fake-cli.mjs";

// Drafts: phone-claw passes --yes only for a confirmed call; the binary never sends.
const fake = installFakeOutlookCli();
const { outlookDraftReply, outlookDraftNew, outlookDeleteDraft } = await import("../fastify-app/outlook-tools.mjs");
const { commandAdapters } = await import("../fastify-app/cli-adapters.mjs");
beforeEach(() => fake.reset());
after(() => fake.cleanup());
const last = () => fake.calls().at(-1);

test("nothing is saved until confirmed: no --yes, and the binary answers confirmation_required", async () => {
  const pending = await outlookDraftReply({ account: "adga", id: "MSG_1", body: "hi" });
  assert.equal(pending.status, "confirmation_required");
  assert.equal(last().yes, false);
  const viaAdapter = await commandAdapters["outlook draft-new"]({ account: "adga", to: "a@example.com", subject: "s", body: "b" }, {});
  assert.equal(viaAdapter.status, "confirmation_required");
  assert.equal(last().yes, false);
  assert.equal((await outlookDeleteDraft({ account: "adga", id: "DRAFT_OLD" })).status, "confirmation_required");
  assert.equal(last().yes, false);
});

test("reply / reply-all: snake_case body, alias resolved, --yes when confirmed", async () => {
  const reply = await outlookDraftReply({ account: "AD-GA", id: "MSG_1", body: "Thanks, Halie.", confirmed: true });
  assert.equal(reply.status, "draft_saved");
  assert.match(reply.answer_text, /has not been sent/);
  assert.equal(last().cmd, "draft-reply");
  assert.equal(last().yes, true);
  assert.deepEqual(last().body, { account: "adga", id: "MSG_1", body: "Thanks, Halie." });

  await commandAdapters["outlook draft-reply"]({
    account: "adga", id: "MSG_5", reply_all: true, body_html: "<p>ok</p>",
    add_to: "oscar@example.com, rebecca@example.com", add_cc: ["phil@example.com"],
    inline_images: [{ url: "https://img.example.com/shot.png", content_id: "r1" }],
  }, { confirmed: true });
  assert.deepEqual(last().body, {
    account: "adga", id: "MSG_5", body_html: "<p>ok</p>", reply_all: true,
    add_to: "oscar@example.com, rebecca@example.com", add_cc: ["phil@example.com"],
    inline_images: [{ url: "https://img.example.com/shot.png", content_id: "r1" }],
  });
  assert.equal(last().yes, true);

  // The generic reply-all-draft command routes a work account to Outlook with reply_all.
  const generic = await commandAdapters["himalaya reply-all-draft"]({ account: "andrew@ad-ga.com", id: "MSG_3", body: "ok" }, { confirmed: true });
  assert.equal(generic.status, "draft_saved");
  assert.equal(last().cmd, "draft-reply");
  assert.equal(last().body.reply_all, true);
  assert.equal(last().body.account, "adga");
});

test("new draft and draft delete", async () => {
  const fresh = await outlookDraftNew({ account: "adga", to: "Oscar <oscar@example.com>, dia@example.com", cc: ["halie@example.com"], subject: "Status", body: "Hi", confirmed: true });
  assert.equal(fresh.status, "draft_saved");
  assert.deepEqual(last().argv.slice(0, 2), ["draft-new", "--json"]);
  assert.equal(last().argv.at(-1), "--yes");
  assert.deepEqual(last().body, { account: "adga", to: "Oscar <oscar@example.com>, dia@example.com", cc: ["halie@example.com"], subject: "Status", body: "Hi" });

  const removed = await commandAdapters["outlook draft-delete"]({ account: "adga", id: "DRAFT_OLD" }, { confirmed: true });
  assert.equal(removed.status, "draft_deleted");
  assert.deepEqual(last().body, { account: "adga", id: "DRAFT_OLD" });
  assert.equal(last().yes, true);
});

test("only draft commands ever get --yes", async () => {
  await commandAdapters["outlook messages"]({ account: "adga" }, { confirmed: true });
  await commandAdapters["outlook read"]({ account: "adga", id: "x" }, { confirmed: true });
  assert.ok(fake.calls().every((c) => !c.yes));
});
