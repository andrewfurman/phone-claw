import {
  extractSimpleCsrfFromHtml,
  urlFetch,
  urlFetchNeedsBrowserFallback,
} from "../fastify-app/cli-tools.mjs";

const postNeedsConfirmation = await urlFetch({
  url: "https://httpbin.org/post",
  method: "POST",
  purpose: "submit_form",
  form: { email: "andrew@example.com", list: "weekly" },
});

const postSuccess = await urlFetch({
  url: "https://httpbin.org/post",
  method: "POST",
  purpose: "submit_form",
  confirmed: true,
  form: { email: "andrew@example.com", list: "weekly" },
  headers: { "x-test-header": "phone-claw" },
  cookies: { session: "abc123" },
  csrfToken: "csrf-test-token",
  csrfField: "_csrf",
  maxBodyChars: 8_000,
});

const postBody = safeJson(postSuccess.body_text);
const echoedForm = postBody?.form || {};
const echoedHeaders = postBody?.headers || {};

const csrfHtml = `
<html><head><meta name="csrf-token" content="meta-token-123"></head>
<body>
<form method="post" action="/unsubscribe">
  <input type="hidden" name="_csrf" value="hidden-should-lose-to-meta">
  <button type="submit">Unsubscribe</button>
</form>
</body></html>`;
const csrfFromMeta = extractSimpleCsrfFromHtml(csrfHtml);
const csrfFromHidden = extractSimpleCsrfFromHtml(`
<form><input type="hidden" name="csrfmiddlewaretoken" value="django-token"></form>
`);

const browserFallback = urlFetchNeedsBrowserFallback({
  html: `<html><body><div id="root"></div><script></script><script></script><script></script>
  <noscript>Please enable JavaScript</noscript></body></html>`,
  bodyText: "Please enable JavaScript",
  contentType: "text/html",
  statusCode: 200,
});
const staticPageNoFallback = urlFetchNeedsBrowserFallback({
  html: `<html><head><title>Done</title></head><body><p>You have been unsubscribed successfully.</p></body></html>`,
  bodyText: "You have been unsubscribed successfully.",
  contentType: "text/html",
  statusCode: 200,
});

const unsupportedPut = await urlFetch({
  url: "https://example.com",
  method: "PUT",
});

const checks = {
  post_requires_confirmation: postNeedsConfirmation.status === "confirmation_required",
  post_success_ok: postSuccess.ok === true && postSuccess.status_code === 200,
  post_echoes_form_email: echoedForm.email === "andrew@example.com",
  post_echoes_csrf_field: echoedForm._csrf === "csrf-test-token",
  post_sends_custom_header: /phone-claw/i.test(String(echoedHeaders["X-Test-Header"] || "")),
  post_sends_cookie: /session=abc123/i.test(String(echoedHeaders.Cookie || "")),
  post_answer_mentions_posted: /^Posted to/i.test(postSuccess.answer_text || ""),
  csrf_extracts_meta_token: csrfFromMeta.token === "meta-token-123",
  csrf_extracts_hidden_token: csrfFromHidden.token === "django-token",
  browser_fallback_detected: browserFallback === true,
  static_page_no_browser_fallback: staticPageNoFallback === false,
  put_still_unsupported: unsupportedPut.status === "unsupported_method",
  post_success_not_needs_browser: postSuccess.needs_browser === false,
};

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      checks,
      post_summary: {
        confirmation_status: postNeedsConfirmation.status,
        status_code: postSuccess.status_code,
        form: echoedForm,
        custom_header: echoedHeaders["X-Test-Header"] || null,
        cookie: echoedHeaders.Cookie || null,
        needs_browser: postSuccess.needs_browser,
        answer_text: postSuccess.answer_text,
      },
      csrf_summary: {
        meta: csrfFromMeta,
        hidden: csrfFromHidden,
      },
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

function safeJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}
