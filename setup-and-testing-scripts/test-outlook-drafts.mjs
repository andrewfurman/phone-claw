import assert from "node:assert/strict";
import http from "node:http";

// Fake Outlook REST API: records every request so we can prove nothing is sent.
const requests = [];
const QUOTED = '<html><head></head><body><hr><div><b>From:</b> Halie Reyes<br>Vendors are correct.</div></body></html>';
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ method: req.method, path: url.pathname, body });
  res.setHeader("content-type", "application/json; charset=utf-8");
  const draft = (extra = {}) => ({
    Id: "DRAFT_1",
    Subject: "RE: Claims data fix",
    IsDraft: true,
    ToRecipients: [{ EmailAddress: { Name: "Halie Reyes", Address: "halie@example.com" } }],
    CcRecipients: [{ EmailAddress: { Name: "Oscar", Address: "oscar@example.com" } }],
    WebLink: "https://outlook.office.com/owa/?ItemID=DRAFT_1",
    Body: { ContentType: "HTML", Content: QUOTED },
    ...extra,
  });
  if (req.method === "POST" && /\/api\/v2\.0\/me\/messages\/[^/]+\/createreply(all)?$/.test(url.pathname)) {
    res.writeHead(201);
    res.end(JSON.stringify(draft()));
    return;
  }
  if (req.method === "PATCH" && url.pathname === "/api/v2.0/me/messages/DRAFT_1") {
    res.writeHead(200);
    res.end(JSON.stringify(draft({ Body: body.Body })));
    return;
  }
  if (req.method === "GET" && /\/api\/v2\.0\/me\/messages\/(DRAFT_OLD|MSG_SENT)$/.test(url.pathname)) {
    const isDraft = url.pathname.endsWith("DRAFT_OLD");
    res.writeHead(200);
    res.end(JSON.stringify({ Id: isDraft ? "DRAFT_OLD" : "MSG_SENT", Subject: "RE: Status", IsDraft: isDraft }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v2.0/me/messages/DRAFT_OLD/move") {
    res.writeHead(201);
    res.end(JSON.stringify({ Id: "DRAFT_OLD_MOVED" }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v2.0/me/messages") {
    res.writeHead(201);
    res.end(JSON.stringify({ Id: "NEW_1", Subject: body.Subject, IsDraft: true, ToRecipients: body.ToRecipients, CcRecipients: body.CcRecipients, WebLink: "" }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: { message: "not found" } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// A token shaped like the Outlook web session's (aud outlook.office.com).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
process.env.OUTLOOK_TEST_TOKEN_ADGA = `${b64({ alg: "none" })}.${b64({ aud: "https://outlook.office.com", scp: "Mail.ReadWrite" })}.sig`;
process.env.OUTLOOK_REST_BASE_URL = `http://127.0.0.1:${port}`;
const { outlookDraftReply, outlookDraftNew, outlookDeleteDraft } = await import("../fastify-app/outlook-tools.mjs");
const { commandAdapters } = await import("../fastify-app/cli-adapters.mjs");

// 1. Like the other draft tools, nothing happens until it's confirmed.
const pending = await outlookDraftReply({ account: "adga", id: "MSG_1", body: "hi" });
assert.equal(pending.status, "confirmation_required");
assert.equal(requests.length, 0);

// 2. A work account must be named: no "all", no Gmail fallback.
assert.equal((await outlookDraftReply({ account: "all", id: "MSG_1", body: "hi", confirmed: true })).ok, false);
assert.equal((await outlookDraftReply({ id: "MSG_1", body: "hi", confirmed: true })).ok, false);
assert.equal(requests.length, 0);

// 3. Reply: createreply, then the text goes above the quoted original (escaped).
const reply = await outlookDraftReply({ account: "AD-GA", id: "MSG_1", body: "Thanks, Halie.\n\nAll 79 are linked <now>.", confirmed: true });
assert.equal(reply.ok, true);
assert.equal(reply.status, "draft_saved");
assert.equal(reply.id, "DRAFT_1");
assert.equal(reply.is_draft, true);
assert.match(reply.answer_text, /has not been sent/);
assert.equal(requests[0].method, "POST");
assert.match(requests[0].path, /\/me\/messages\/MSG_1\/createreply$/);
const patchedBody = requests[1].body.Body.Content;
assert.equal(requests[1].method, "PATCH");
assert.ok(patchedBody.startsWith("<html><head></head><body><div><p>Thanks, Halie.</p><p>All 79 are linked &lt;now&gt;.</p></div><br><hr>"), patchedBody);
assert.ok(patchedBody.includes("Vendors are correct."), "quoted original is kept");

// 4. Reply all uses createreplyall; HTML bodies go in as-is.
requests.length = 0;
const replyAll = await commandAdapters["outlook draft-reply"]({ account: "adga", id: "MSG_2", reply_all: true, body_html: "<p><b>Done.</b></p>" }, { confirmed: true });
assert.equal(replyAll.ok, true);
assert.match(requests[0].path, /\/me\/messages\/MSG_2\/createreplyall$/);
assert.ok(requests[1].body.Body.Content.includes("<div><p><b>Done.</b></p></div><br>"));

// 5. The generic reply-all-draft command routes a work account to Outlook.
requests.length = 0;
const generic = await commandAdapters["himalaya reply-all-draft"]({ account: "andrew@ad-ga.com", id: "MSG_3", body: "ok" }, { confirmed: true });
assert.equal(generic.status, "draft_saved");
assert.match(requests[0].path, /createreplyall$/);

// 6. New message: saved to Drafts with parsed recipients.
requests.length = 0;
const fresh = await outlookDraftNew({ account: "adga", to: "Oscar Buitrago <oscar@example.com>, dia@example.com", cc: ["halie@example.com"], subject: "Status", body: "Hi", confirmed: true });
assert.equal(fresh.status, "draft_saved");
assert.equal(requests[0].method, "POST");
assert.equal(requests[0].path, "/api/v2.0/me/messages");
assert.deepEqual(requests[0].body.ToRecipients, [
  { EmailAddress: { Address: "oscar@example.com", Name: "Oscar Buitrago" } },
  { EmailAddress: { Address: "dia@example.com" } },
]);
assert.deepEqual(requests[0].body.CcRecipients, [{ EmailAddress: { Address: "halie@example.com" } }]);

// 7. Deleting a draft moves it to Deleted Items, only after confirmation, and only drafts.
requests.length = 0;
assert.equal((await outlookDeleteDraft({ account: "adga", id: "DRAFT_OLD" })).status, "confirmation_required");
assert.equal(requests.length, 0);
const removed = await commandAdapters["outlook draft-delete"]({ account: "adga", id: "DRAFT_OLD" }, { confirmed: true });
assert.equal(removed.status, "draft_deleted");
assert.equal(requests.at(-1).path, "/api/v2.0/me/messages/DRAFT_OLD/move");
assert.deepEqual(requests.at(-1).body, { DestinationId: "DeletedItems" });
requests.length = 0;
const refused = await outlookDeleteDraft({ account: "adga", id: "MSG_SENT", confirmed: true });
assert.equal(refused.status, "not_a_draft");
assert.ok(!requests.some((r) => r.method !== "GET"), "a non-draft is never moved");

// 8. Nothing ever went to a send endpoint.
assert.ok(!requests.some((r) => /\/send/i.test(r.path)));

server.close();
console.log(JSON.stringify({ ok: true, status: "ok", tests: "outlook-drafts" }, null, 2));
