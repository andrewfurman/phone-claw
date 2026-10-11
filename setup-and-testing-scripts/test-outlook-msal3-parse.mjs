import assert from "node:assert/strict";
import { __test_selectBestTokenFromMsalEntries as pick } from "../fastify-app/outlook-tools.mjs";

// Build sample msal.3 entries
const nowSec = Math.floor(Date.now() / 1000);
const mk = (target, expOffsetSec, token = "x".repeat(200)) => ({ key: "msal.3|...|accesstoken|...", source: "msal_v3", target, expiresOn: nowSec + expOffsetSec, token });

// Prefer Outlook REST for mail
{
  const entries = [
    mk("https://graph.microsoft.com/Mail.Read email openid profile", 3600),
    mk("https://outlook.office.com/Mail.Read https://outlook.office.com/Calendars.Read", 7200),
  ];
  const best = pick(entries, "mail");
  assert.equal(best.api, "outlook_rest");
}

// Fall back to Graph when Outlook token lacks scope
{
  const entries = [
    mk("https://outlook.office.com/Calendars.Read", 7200),
    mk("https://graph.microsoft.com/Mail.Read", 3600),
  ];
  const best = pick(entries, "mail");
  assert.equal(best.api, "graph");
}

// Expired tokens are ignored
{
  const entries = [
    mk("https://outlook.office.com/Mail.Read", -10),
    mk("https://graph.microsoft.com/Mail.Read", -10),
  ];
  const best = pick(entries, "mail");
  assert.equal(Boolean(best), false);
}

// Calendar scope selection
{
  const entries = [
    mk("https://outlook.office.com/Calendars.Read", 600),
    mk("https://graph.microsoft.com/Calendars.Read", 3600),
  ];
  const best = pick(entries, "calendar");
  assert.equal(best.api, "outlook_rest");
}

console.log(JSON.stringify({ ok: true, status: "ok", tests: "outlook-msal3-parse" }, null, 2));

