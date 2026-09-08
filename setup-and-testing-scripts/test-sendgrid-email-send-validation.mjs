import { sendgridEmailSend } from "../fastify-app/sendgrid-tools.mjs";

const env = {
  SENDGRID_API_KEY: "SG.test-key-not-real",
  SENDGRID_DEFAULT_FROM: "info@aifurman.com",
  SENDGRID_DEFAULT_TO: "aifurman@gmail.com",
  SENDGRID_OWNER_EMAIL: "aifurman@gmail.com",
};

const checks = {};
const captured = { requests: [] };

async function mockFetch(url, init = {}) {
  captured.requests.push({
    url,
    method: init.method,
    has_authorization: Boolean(init.headers?.authorization),
    authorization_redacted: String(init.headers?.authorization || "").startsWith("Bearer "),
    body: JSON.parse(init.body || "{}"),
  });
  return {
    ok: true,
    status: 202,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "x-message-id") return "sg-msg-test-1";
        return null;
      },
    },
    async text() {
      return "";
    },
  };
}

const deps = { env, fetchImpl: mockFetch, skipEnvLoad: true };

// Defaults: to/from filled from env when omitted.
{
  const result = await sendgridEmailSend(
    {
      subject: "defaults check",
      body: "hello",
      previewed: true,
      confirmed: true,
    },
    deps
  );
  checks.defaults_ok = result.ok === true && result.action === "sendgrid_email_sent";
  checks.defaults_from = result.from === "info@aifurman.com";
  checks.defaults_to = result.to === "aifurman@gmail.com";
  checks.defaults_message_id = result.message_id === "sg-msg-test-1";
  checks.defaults_posted_sendgrid =
    captured.requests.at(-1)?.url === "https://api.sendgrid.com/v3/mail/send";
  checks.defaults_auth_present = captured.requests.at(-1)?.has_authorization === true;
}

// Owner guardrail: auto-add owner to CC when missing from To/CC.
{
  const before = captured.requests.length;
  const result = await sendgridEmailSend(
    {
      from: "reminders@aifurman.com",
      to: "someone@example.com",
      subject: "owner cc guard",
      body: "note",
      previewed: true,
      confirmed: true,
    },
    deps
  );
  const body = captured.requests.at(-1)?.body;
  const cc = (body?.personalizations?.[0]?.cc || []).map((entry) => entry.email);
  checks.owner_auto_cc_flag = result.owner_added_to_cc === true;
  checks.owner_auto_cc_payload = cc.includes("aifurman@gmail.com");
  checks.owner_auto_cc_answer = String(result.answer_text || "").includes("auto-added to CC");
  checks.owner_auto_cc_request_added = captured.requests.length === before + 1;
}

// Owner already in To (case-insensitive) — do not duplicate into CC.
{
  const result = await sendgridEmailSend(
    {
      from: "research@aifurman.com",
      to: "Aifurman@Gmail.com",
      subject: "owner already to",
      body: "note",
      previewed: true,
      confirmed: true,
    },
    deps
  );
  const body = captured.requests.at(-1)?.body;
  checks.owner_in_to_no_extra_cc =
    result.owner_added_to_cc === false &&
    !body?.personalizations?.[0]?.cc &&
    result.ok === true;
}

// Domain check rejects non-aifurman.com from.
{
  const before = captured.requests.length;
  const result = await sendgridEmailSend(
    {
      from: "bot@example.com",
      to: "aifurman@gmail.com",
      subject: "bad domain",
      body: "nope",
      previewed: true,
      confirmed: true,
    },
    deps
  );
  checks.domain_rejected =
    result.ok === false &&
    result.status === "invalid_from_domain" &&
    captured.requests.length === before;
}

// Preview gate.
{
  const before = captured.requests.length;
  const result = await sendgridEmailSend(
    {
      subject: "needs preview",
      body: "body",
      confirmed: true,
    },
    deps
  );
  checks.preview_required =
    result.status === "confirmation_required" &&
    result.action === "sendgrid_email_send_preview_required" &&
    captured.requests.length === before;
}

// Confirmation gate after preview.
{
  const before = captured.requests.length;
  const result = await sendgridEmailSend(
    {
      subject: "needs confirm",
      body: "body",
      previewed: true,
    },
    deps
  );
  checks.confirmation_required =
    result.status === "confirmation_required" &&
    result.action === "sendgrid_email_send_confirmation_required" &&
    captured.requests.length === before;
}

// Missing subject / body.
{
  const missingSubject = await sendgridEmailSend(
    { body: "x", previewed: true, confirmed: true },
    deps
  );
  const missingBody = await sendgridEmailSend(
    { subject: "x", previewed: true, confirmed: true },
    deps
  );
  checks.missing_subject =
    missingSubject.status === "missing_field" && missingSubject.field === "subject";
  checks.missing_body = missingBody.status === "missing_field" && missingBody.field === "body";
}

// Missing API key.
{
  const result = await sendgridEmailSend(
    {
      subject: "no key",
      body: "x",
      previewed: true,
      confirmed: true,
    },
    { env: { ...env, SENDGRID_API_KEY: "" }, fetchImpl: mockFetch, skipEnvLoad: true }
  );
  checks.missing_api_key =
    result.ok === false && result.status === "not_configured";
}

// Never leak API key into response JSON.
{
  const blob = JSON.stringify(
    await sendgridEmailSend(
      {
        subject: "redact check",
        body: "x",
        previewed: true,
        confirmed: true,
      },
      deps
    )
  );
  checks.response_has_no_api_key = !blob.includes("SG.test-key-not-real");
}

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      checks,
      request_count: captured.requests.length,
      note: "mock fetch only; no live SendGrid calls",
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);
