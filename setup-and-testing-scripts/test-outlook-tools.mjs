import assert from "node:assert/strict";
import http from "node:http";

// Spin up a tiny fake upstream server simulating Graph and Outlook REST
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Simple routing for Graph defaults (used by initial tests)
  if (url.pathname === "/v1.0/me/mailFolders/Inbox/messages") {
    res.writeHead(200);
    res.end(JSON.stringify({
      value: [
        {
          id: "MSG_A",
          subject: "Hello A",
          from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
          receivedDateTime: "2026-10-09T16:00:00Z",
          isRead: false,
          conversationId: "C1",
          webLink: "https://outlook.office.com/mail/deeplink/read/MSG_A",
        },
        {
          id: "MSG_B",
          subject: "Hello B",
          from: { emailAddress: { name: "Bob", address: "bob@example.com" } },
          receivedDateTime: "2026-10-09T15:00:00Z",
          isRead: true,
          conversationId: "C2",
          webLink: "https://outlook.office.com/mail/deeplink/read/MSG_B",
        },
      ],
    }));
    return;
  }
  if (url.pathname.startsWith("/v1.0/me/messages/")) {
    res.writeHead(200);
    res.end(JSON.stringify({
      id: url.pathname.split("/").pop(),
      subject: "Read Test",
      from: { emailAddress: { name: "Carol", address: "carol@example.com" } },
      receivedDateTime: "2026-10-09T17:00:00Z",
      body: { contentType: "html", content: "<p>Line 1<br>Line 2</p>" },
      webLink: "https://outlook.office.com/mail/deeplink/read/READ_ID",
    }));
    return;
  }
  if (url.pathname === "/v1.0/me/messages" && url.searchParams.get("$search")) {
    res.writeHead(200);
    res.end(JSON.stringify({
      value: [
        {
          id: "MSG_S",
          subject: "Search Hit",
          from: { emailAddress: { name: "Dana", address: "dana@example.com" } },
          receivedDateTime: "2026-10-09T18:00:00Z",
          isRead: false,
          conversationId: "S1",
          webLink: "https://outlook.office.com/mail/deeplink/read/MSG_S",
        },
      ],
    }));
    return;
  }
  if (url.pathname === "/v1.0/me/calendarView") {
    res.writeHead(200);
    res.end(JSON.stringify({
      value: [
        {
          id: "EV1",
          subject: "Standup",
          isAllDay: false,
          start: { dateTime: "2026-10-09T09:00:00", timeZone: "America/New_York" },
          end: { dateTime: "2026-10-09T09:30:00", timeZone: "America/New_York" },
          organizer: { emailAddress: { name: "Andrew", address: "andrew@example.com" } },
          location: { displayName: "Zoom" },
          webLink: "https://outlook.office.com/calendar/item/EV1",
        },
      ],
    }));
    return;
  }
  // Simulate Graph base override returning 401 to trigger fallback
  if (url.pathname === "/graph/v1.0/me/mailFolders/Inbox/messages") {
    res.writeHead(401);
    res.end(JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: "Bad token" } }));
    return;
  }
  // Outlook REST v2.0 simulation
  if (url.pathname === "/outlook/api/v2.0/me/messages" || url.pathname === "/api/v2.0/me/messages") {
    res.writeHead(200);
    res.end(JSON.stringify({
      value: [
        {
          Id: "MSG_A",
          Subject: "Hello A",
          From: { EmailAddress: { Name: "Alice", Address: "alice@example.com" } },
          ReceivedDateTime: "2026-10-09T16:00:00Z",
          IsRead: false,
          ConversationId: "C1",
          WebLink: "https://outlook.office.com/mail/deeplink/read/MSG_A",
        },
        {
          Id: "MSG_B",
          Subject: "Hello B",
          From: { EmailAddress: { Name: "Bob", Address: "bob@example.com" } },
          ReceivedDateTime: "2026-10-09T15:00:00Z",
          IsRead: true,
          ConversationId: "C2",
          WebLink: "https://outlook.office.com/mail/deeplink/read/MSG_B",
        },
      ],
    }));
    return;
  }
  if (url.pathname.startsWith("/outlook/api/v2.0/me/messages/") || url.pathname.startsWith("/api/v2.0/me/messages/")) {
    res.writeHead(200);
    res.end(JSON.stringify({
      Id: url.pathname.split("/").pop(),
      Subject: "Read Test",
      From: { EmailAddress: { Name: "Carol", Address: "carol@example.com" } },
      ReceivedDateTime: "2026-10-09T17:00:00Z",
      Body: { ContentType: "HTML", Content: "<p>Line 1<br>Line 2</p>" },
      WebLink: "https://outlook.office.com/mail/deeplink/read/READ_ID",
    }));
    return;
  }
  if ((url.pathname === "/outlook/api/v2.0/me/messages" || url.pathname === "/api/v2.0/me/messages") && url.searchParams.get("$search")) {
    res.writeHead(200);
    res.end(JSON.stringify({
      value: [
        {
          Id: "MSG_S",
          Subject: "Search Hit",
          From: { EmailAddress: { Name: "Dana", Address: "dana@example.com" } },
          ReceivedDateTime: "2026-10-09T18:00:00Z",
          IsRead: false,
          ConversationId: "S1",
          WebLink: "https://outlook.office.com/mail/deeplink/read/MSG_S",
        },
      ],
    }));
    return;
  }
  if (url.pathname === "/outlook/api/v2.0/me/calendarview" || url.pathname === "/api/v2.0/me/calendarview") {
    res.writeHead(200);
    res.end(JSON.stringify({
      value: [
        {
          Id: "EV1",
          Subject: "Standup",
          IsAllDay: false,
          Start: { DateTime: "2026-10-09T09:00:00", TimeZone: "America/New_York" },
          End: { DateTime: "2026-10-09T09:30:00", TimeZone: "America/New_York" },
          Organizer: { EmailAddress: { Name: "Andrew", Address: "andrew@example.com" } },
          Location: { DisplayName: "Zoom" },
          WebLink: "https://outlook.office.com/calendar/item/EV1",
        },
      ],
    }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

// Inject test API bases and token so CDP is not needed.
process.env.OUTLOOK_GRAPH_BASE_URL = base;
process.env.OUTLOOK_REST_BASE_URL = base;
// token with a benign payload by default; specific tests will override
process.env.OUTLOOK_TEST_TOKEN = `x.${Buffer.from(JSON.stringify({ aud: "https://graph.microsoft.com", scp: "Mail.Read" })).toString("base64url")}.y`;

// Import after env is set so the module reads the overridden base.
const { outlookAgenda, outlookMessages, outlookRead, outlookSearch, outlookStatus } = await import("../fastify-app/outlook-tools.mjs");

// status
{
  const s = await outlookStatus({ account: "covernode" });
  assert.equal(s.ok, true);
  assert.equal(s.accounts?.[0]?.status, "signed_in");
}

// list messages: simulate Graph 401 then Outlook REST success via base overrides and token aud
{
  const r = await outlookMessages({ account: "covernode", limit: 2, unread: false });
  assert.equal(r.ok, true);
  assert.equal(r.returned_count, 2);
  assert.equal(r.items[0].id, "MSG_A");
  assert.equal(typeof r.items[0].received_at, "string");
}

// read message
{
  const r = await outlookRead({ account: "covernode", id: "READ_ID", maxBodyChars: 2000 });
  assert.equal(r.ok, true);
  assert.match(r.body_text || "", /Line 1/);
}

// search
{
  const r = await outlookSearch({ account: "covernode", query: "search words", limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.returned_count, 1);
  assert.equal(r.items[0].id, "MSG_S");
}

// agenda today should use ET-local day bounds (00:00..23:59 ET) via Prefer header
{
  const r = await outlookAgenda({ account: "covernode", today: true });
  assert.equal(r.ok, true);
  const acc = r.accounts?.[0];
  assert.equal(acc?.status, "ok");
  assert.ok((acc?.returned_count || 0) >= 1);
  assert.equal(acc?.items?.[0]?.subject, "Standup");
  // Start/end should be local ET times without Z
  assert.match(String(r.start_date), /T00:00:00$/);
  assert.match(String(r.end_date), /T23:59:59$/);
}

server.close();

console.log(JSON.stringify({ ok: true, status: "ok", tests: "outlook-tools", http_port: port }, null, 2));

