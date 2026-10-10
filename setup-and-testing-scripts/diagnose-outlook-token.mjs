#!/usr/bin/env node
// Diagnostic script: print Outlook web session token audience/scope and HTTP status of upstream inbox calls.
// Never prints token values.
import { Buffer } from "node:buffer";

const args = process.argv.slice(2);
const account = (args.find((a) => a.startsWith("--account=")) || "").split("=").pop() || args[args.indexOf("--account") + 1] || "covernode";
const config = {
  covernode: { port: Number(process.env.OUTLOOK_COVERNODE_CDP_PORT || 9230), mainUrl: "https://outlook.cloud.microsoft/mail/" },
  adga: { port: Number(process.env.OUTLOOK_ADGA_CDP_PORT || 9231), mainUrl: "https://outlook.cloud.microsoft/mail/andrew@ad-ga.com/" },
}[account];
if (!config) {
  console.error(JSON.stringify({ ok: false, status: "invalid_account", message: "Use --account covernode|adga" }, null, 2));
  process.exit(1);
}

function decodeClaims(token) {
  try {
    const [, payload] = String(token).split(".");
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4);
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch { return {}; }
}

async function getTokenViaCdp({ port, mainUrl }) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const list = await fetch(listUrl, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => []);
  const page = Array.isArray(list) ? list.find(t => t.type === "page" && typeof t.url === "string" && (t.url === mainUrl || t.url.startsWith(mainUrl))) : null;
  if (!page?.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const nextId = (() => { let id = 0; return () => ++id; })();
  const once = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("timeout")); }, 4000);
    ws.addEventListener("message", (ev) => { try { const msg = JSON.parse(ev.data); if (msg.id === id) { clearTimeout(timer); resolve(msg); } } catch {} });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("cdp_error")); });
  });
  const open = await new Promise((resolve) => { ws.addEventListener("open", () => resolve(true)); ws.addEventListener("error", () => resolve(false)); setTimeout(() => resolve(false), 2000); });
  if (!open) return null;
  const expr = `(function(){try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i)||'';if(k.startsWith('accesstoken-')){try{var v=JSON.parse(localStorage.getItem(k)||'{}');var t=v.secret||v.accessToken||v.credential;if(t && typeof t==='string' && t.length>100) return {ok:true,token:t};}catch(e){}}}return {ok:false};}catch(e){return {ok:false}}})()`;
  const enable = nextId(); ws.send(JSON.stringify({ id: enable, method: "Runtime.enable" })); await once(enable);
  const evalId = nextId(); ws.send(JSON.stringify({ id: evalId, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } })); const reply = await once(evalId); try { ws.close(); } catch {}
  const value = reply.result?.result?.value || {};
  return value.ok ? value.token : null;
}

async function headStatus(url, token) {
  try {
    const r = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "error" });
    await r.text().catch(() => "");
    return r.status;
  } catch { return 0; }
}

const result = { ok: true, status: "ok", account, cdp_port: config.port, aud: "", scp: "", upstream: {} };
try {
  const token = await getTokenViaCdp(config);
  if (!token) { result.ok = false; result.status = "needs_sign_in"; console.log(JSON.stringify(result, null, 2)); process.exit(0); }
  const claims = decodeClaims(token);
  result.aud = String(claims.aud || "");
  result.scp = String(claims.scp || claims.roles || "");
  result.upstream.graph_inbox = await headStatus("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=1", token);
  result.upstream.outlook_rest_inbox = await headStatus("https://outlook.office.com/api/v2.0/me/messages?$top=1", token);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, status: "diagnostic_failed", account, message: e?.message || "failed" }, null, 2));
  process.exit(1);
}

