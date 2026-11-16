#!/usr/bin/env node
// Keeps google-photos-web-cli signed in on the bridge: checks the saved session and, when it no
// longer works, re-imports the Google cookies from the signed-in pc-chrome-google Chrome
// (DevTools on 127.0.0.1:9233). Run as phoneclaw. Cookies are written only to a private temp
// file that is deleted right after the import; nothing is printed.
//   node deploy/google-photos-keepalive.mjs [--force]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const BIN = process.env.GOOGLE_PHOTOS_WEB_CLI_BIN || "/usr/local/bin/google-photos-web-cli";
const CDP = `http://127.0.0.1:${process.env.GOOGLE_CHROME_CDP_PORT || 9233}`;
if (!process.argv.includes("--force")) {
  const status = spawnSync(BIN, ["auth", "status"], { encoding: "utf8", timeout: 60000 });
  if (status.status === 0) {
    console.log("google photos session ok");
    process.exit(0);
  }
  console.log("google photos session not working; re-importing from Chrome");
}
const v = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const res = await new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m.result); }; ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })); });
ws.close();
const cookies = (res.cookies || []).filter((c) => /(^|\.)(google\.com|photos\.google\.com|googleusercontent\.com)$/.test(c.domain.replace(/^\./, "")) || c.domain.replace(/^\./, "").endsWith("google.com"));
if (!cookies.some((c) => c.name === "SID" || c.name === "__Secure-1PSID")) { console.log("pc-chrome-google is not signed in to Google: sign in through the noVNC desktop"); process.exit(1); }
const lines = ["# Netscape HTTP Cookie File", ...cookies.map((c) => [(c.httpOnly ? "#HttpOnly_" : "") + c.domain, c.domain.startsWith(".") ? "TRUE" : "FALSE", c.path, c.secure ? "TRUE" : "FALSE", String(c.expires > 0 ? Math.floor(c.expires) : 0), c.name, c.value].join("\t"))];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-")); const f = path.join(dir, "cookies.txt");
fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
try { execFileSync(BIN, ["auth", "cookies", f], { stdio: ["ignore", "ignore", "pipe"] }); console.log(`imported ${cookies.length} cookies`); }
finally { fs.rmSync(dir, { recursive: true, force: true }); }
const check = spawnSync(BIN, ["auth", "status"], { encoding: "utf8", timeout: 60000 });
console.log(check.status === 0 ? "google photos session ok after import" : "google photos session still failing after import");
process.exit(check.status === 0 ? 0 : 1);
