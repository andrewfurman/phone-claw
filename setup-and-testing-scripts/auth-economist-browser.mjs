import { readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const options = parseArgs(process.argv.slice(2));
const credentials = options.credentialsFile
  ? await readCredentialsFile(options.credentialsFile, {
      deleteAfterRead: options.deleteCredentialsFile,
    })
  : {};
const loginUrl = options.loginUrl || "https://www.economist.com/api/my-account";
const verifyUrl =
  options.verifyUrl ||
  "https://www.economist.com/culture/2026/06/19/plot-twist-newsletter-the-art-of-adolescence";
const userDataDir =
  options.userDataDir ||
  process.env.ECONOMIST_BROWSER_USER_DATA_DIR ||
  "/var/lib/phoneclaw/economist-browser-profile";
const storageState =
  options.storageState ||
  process.env.ECONOMIST_BROWSER_STORAGE_STATE ||
  "/var/lib/phoneclaw/economist-browser-state.json";
const executablePath =
  options.executablePath || process.env.ECONOMIST_BROWSER_EXECUTABLE_PATH || "";
const email = options.email || credentials.email || process.env.ECONOMIST_EMAIL || "";
const password =
  options.password ||
  credentials.password ||
  process.env.ECONOMIST_PASSWORD ||
  (options.promptPassword ? await promptHidden("Economist password: ") : "");
const headed = options.headed || process.env.ECONOMIST_AUTH_HEADED === "true";
const waitForLoginMs = integerOption(options.waitForLoginMs, 600_000);

await mkdir(userDataDir, { recursive: true });
await mkdir(dirname(storageState), { recursive: true });

const launchOptions = {
  headless: !headed,
  viewport: { width: 1365, height: 900 },
  locale: "en-US",
  timezoneId: process.env.TZ || "America/Los_Angeles",
  args: [
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
  ],
};
if (executablePath) launchOptions.executablePath = executablePath;

const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.setDefaultNavigationTimeout(60_000);

let status = "unknown";
let message = "";
try {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await dismissCookiePrompts(page);

  if (email && password) {
    await fillLoginForm(page, { email, password });
  } else if (headed) {
    console.log(
      JSON.stringify({
        ok: true,
        status: "waiting_for_manual_login",
        message:
          "Complete The Economist login in the visible browser. The script will verify and save state automatically.",
        login_url: loginUrl,
        verify_url: verifyUrl,
        timeout_ms: waitForLoginMs,
      })
    );
  } else {
    throw new Error(
      "Provide ECONOMIST_EMAIL and ECONOMIST_PASSWORD, use --prompt-password, or run with --headed for manual login."
    );
  }

  const verified = await waitForFullText(page, verifyUrl, waitForLoginMs);
  status = verified.fullTextAvailable ? "authenticated_full_text_available" : verified.status;
  message = verified.message;
  await context.storageState({ path: storageState });

  console.log(
    JSON.stringify(
      {
        ok: verified.fullTextAvailable,
        status,
        message,
        storage_state: storageState,
        user_data_dir: userDataDir,
        verify_url: verifyUrl,
        title: verified.title,
        text_chars: verified.textChars,
        text_preview: verified.textPreview,
      },
      null,
      2
    )
  );
  process.exitCode = verified.fullTextAvailable ? 0 : 2;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        status: "economist_auth_failed",
        message: error.message,
        storage_state: storageState,
        user_data_dir: userDataDir,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
}

async function fillLoginForm(page, { email, password }) {
  const emailInput = page
    .locator(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"]'
    )
    .first();
  await emailInput.waitFor({ state: "visible", timeout: 60_000 });
  await emailInput.fill(email);
  await clickFirst(page, [
    'button:has-text("Continue")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Next")',
    'input[type="submit"]',
  ]);

  const passwordInput = page
    .locator(
      'input[type="password"], input[name*="password" i], input[id*="password" i], input[autocomplete="current-password"]'
    )
    .first();
  await passwordInput.waitFor({ state: "visible", timeout: 60_000 });
  await passwordInput.fill(password);
  await clickFirst(page, [
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Continue")',
    'input[type="submit"]',
  ]);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
}

async function waitForFullText(page, verifyUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {
    fullTextAvailable: false,
    status: "not_checked",
    message: "",
    title: "",
    textChars: 0,
    textPreview: "",
  };

  while (Date.now() < deadline) {
    await page.goto(verifyUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    last = await inspectArticlePage(page);
    if (last.fullTextAvailable) return last;
    if (!page.isClosed()) {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await page.waitForTimeout(5_000);
  }

  return last;
}

async function inspectArticlePage(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const lower = text.toLowerCase();
    const title =
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
      document.title ||
      "";
    const blockedByCloudflare =
      /cloudflare|cf-chl|enable javascript and cookies|checking your browser/i.test(text) ||
      Boolean(document.querySelector('[name="cf_chl_opt"], #cf-challenge-running'));
    const loginRequired =
      lower.includes("subscribe") ||
      lower.includes("sign in") ||
      lower.includes("log in") ||
      lower.includes("subscriber");
    const article =
      document.querySelector("article") ||
      document.querySelector("main article") ||
      document.querySelector("main") ||
      document.body;
    const articleText = (article?.innerText || text).trim();
    const textChars = articleText.length;
    const fullTextAvailable = !blockedByCloudflare && !loginRequired && textChars >= 700;
    let status = "excerpt_or_login_required";
    let message = "The verification page did not expose full article text yet.";
    if (blockedByCloudflare) {
      status = "blocked_by_cloudflare";
      message = "The verification page is still behind a Cloudflare challenge.";
    } else if (loginRequired) {
      status = "login_required";
      message = "The verification page still appears to require subscriber login.";
    } else if (textChars < 700) {
      status = "excerpt_only";
      message = `Only ${textChars} article characters were visible.`;
    } else {
      status = "authenticated_full_text_available";
      message = "Full article text appears to be available.";
    }
    return {
      fullTextAvailable,
      status,
      message,
      title,
      textChars,
      textPreview: articleText.slice(0, 400),
    };
  });
}

async function dismissCookiePrompts(page) {
  await clickFirst(
    page,
    [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("Continue")',
    ],
    { optional: true }
  );
}

async function clickFirst(page, selectors, { optional = false } = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.click({ timeout: 5_000 });
      return true;
    } catch {}
  }
  if (optional) return false;
  throw new Error(`Could not click any selector: ${selectors.join(", ")}`);
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error("--prompt-password requires a TTY.");
  }
  output.write(prompt);
  execFileSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    const rl = createInterface({ input, output });
    const value = await rl.question("");
    rl.close();
    output.write("\n");
    return value;
  } finally {
    execFileSync("stty", ["echo"], { stdio: "inherit" });
  }
}

function parseArgs(args) {
  const result = {};
  for (const arg of args) {
    if (arg === "--headed") {
      result.headed = true;
      continue;
    }
    if (arg === "--prompt-password") {
      result.promptPassword = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = match[2];
  }
  return result;
}

function integerOption(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readCredentialsFile(pathname, { deleteAfterRead = false } = {}) {
  const text = await readFile(pathname, "utf8");
  const credentials = parseCredentials(text);
  if (deleteAfterRead) {
    await unlink(pathname).catch(() => {});
  }
  if (!credentials.email || !credentials.password) {
    throw new Error("Credentials file must include email and password.");
  }
  return credentials;
}

function parseCredentials(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return {
      email: parsed.email || parsed.ECONOMIST_EMAIL || "",
      password: parsed.password || parsed.ECONOMIST_PASSWORD || "",
    };
  }

  const result = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#") || !cleaned.includes("=")) continue;
    const [rawKey, ...valueParts] = cleaned.split("=");
    const key = rawKey.trim();
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    if (key === "ECONOMIST_EMAIL" || key === "email") result.email = value;
    if (key === "ECONOMIST_PASSWORD" || key === "password") result.password = value;
  }
  return result;
}
