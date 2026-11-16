// Test helper: installs a fake `outlook-web-cli` binary (a small Node script in a temp dir)
// and points OUTLOOK_WEB_CLI_BIN at it. The fake answers like the Rust binary (one JSON
// object on stdout, exit 1 when ok is false) and appends every call (argv, body, a few env
// values) to a log file, so tests can check exactly what phone-claw ran. No network.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FAKE = String.raw`
const fs = require("node:fs");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const at = argv.indexOf("--json");
const body = at >= 0 ? JSON.parse(argv[at + 1]) : {};
const cmd = argv[0] === "auth" ? "auth " + argv[1] : argv[0];
fs.appendFileSync(process.env.OUTLOOK_FAKE_LOG, JSON.stringify({
  cmd, argv, body, yes: flag("--yes"),
  env: { HOME: process.env.HOME || "", OUTLOOK_INLINE_IMAGE_HOSTS: process.env.OUTLOOK_INLINE_IMAGE_HOSTS || "", leaked: Object.keys(process.env).filter((k) => /SECRET|API_KEY|TOKEN/.test(k) && !k.startsWith("OUTLOOK_")) },
}) + "\n");
const out = (o) => { process.stdout.write(JSON.stringify(o, null, 2) + "\n"); process.exit(o.ok === false ? 1 : 0); };
const scenario = process.env.OUTLOOK_FAKE_SCENARIO || "";
if (scenario === "crash") { process.stderr.write("panic: Bearer abc.def.ghi went wrong\n"); process.exit(101); }
if (scenario === "slow") { setTimeout(() => out({ ok: true }), 5000); return; }
if (scenario === "garbage") { process.stdout.write("not json"); process.exit(0); }

const SHOT = process.env.OUTLOOK_FAKE_SHOT;
const PNG = "${PNG_1X1}";
const atts = [
  { index: 0, attachment_id: "A0", name: "image001.png", content_type: "image/png", size: Buffer.from(SHOT, "base64").length, is_inline: true, content_id: "image001.png@01DD0000.00000000", kind: "file", is_image: true, data_base64: SHOT },
  { index: 1, attachment_id: "A1", name: "logo.png", content_type: "image/png", size: 68, is_inline: true, content_id: "image002.png@01DD0000.00000000", kind: "file", is_image: true, data_base64: PNG },
  { index: 2, attachment_id: "A2", name: "Statement.pdf", content_type: "application/pdf", size: 9, is_inline: false, content_id: "", kind: "file", is_image: false, data_base64: Buffer.from("%PDF-1.4\n").toString("base64") },
];
const account = body.account || "all";
switch (cmd) {
  case "status":
    return out({ ok: true, status: "ok", accounts: [{ account: account, status: "signed_in" }] });
  case "messages":
    return out({ ok: true, status: "ok", folder: "Inbox", returned_count: 1, items: [{ id: "MSG_A", account, subject: "Hello A", folder: "Inbox", is_draft: false }] });
  case "read":
    return out({ ok: true, status: "ok", account, id: body.id, body_text: "Line 1\nLine 2" });
  case "search":
    return out({ ok: true, status: "ok", returned_count: 1, items: [{ id: "MSG_S", account }] });
  case "agenda":
    return out({ ok: true, status: "ok", accounts: [{ account, status: "ok", returned_count: 1, items: [{ subject: "Standup" }] }] });
  case "freebusy":
    if (!body.emails) return out({ ok: false, status: "missing_emails", answer_text: "Give one or more email addresses, separated by commas." });
    return out({ ok: true, status: "ok", account: "covernode", timezone: "America/New_York", people: [], free_for_all: [{ start: "2026-11-17T09:00", end: "2026-11-17T10:00", minutes: 60 }], answer_text: "1 slot when everyone is free (Eastern, 09:00-17:00)." });
  case "attachments": {
    if (body.id !== "MSG_SHOT") return out({ ok: false, status: "message_not_found", answer_text: "Message not found." });
    const has = (v) => v !== undefined && v !== null && v !== "";
    const pickOne = has(body.offset) || has(body.attachment_id) || has(body.content_id) || has(body.index);
    if (pickOne) {
      const cid = String(body.content_id || "").replace(/^<|>$/g, "").toLowerCase();
      const att = body.attachment_id ? atts.find((a) => a.attachment_id === body.attachment_id)
        : cid ? atts.find((a) => a.content_id.toLowerCase() === cid)
        : has(body.index) ? atts.find((a) => a.index === Number(body.index)) : atts.find((a) => a.is_image);
      if (!att) return out({ ok: false, status: "attachment_not_found", answer_text: "No attachment matched." });
      const { data_base64, ...item } = att;
      const bytes = Buffer.from(data_base64, "base64");
      if (has(body.offset)) {
        const start = Math.min(bytes.length, Number(body.offset));
        const end = Math.min(bytes.length, start + Math.max(1000, Number(body.length || 250000)));
        return out({ ok: true, status: "ok", account, id: body.id, attachment: item, total_bytes: bytes.length, offset: start, returned_bytes: end - start, next_offset: end < bytes.length ? end : null, data_base64: bytes.subarray(start, end).toString("base64") });
      }
      const fits = bytes.length <= Number(body.max_data_bytes || 250000);
      return out({ ok: true, status: "ok", account, id: body.id, attachment: item, total_bytes: bytes.length, ...(body.include_data !== false && fits ? { data_base64 } : {}) });
    }
    const items = atts.filter((a) => !body.images_only || a.is_image).map(({ data_base64, ...item }) => (body.include_data ? { ...item, data_base64 } : item));
    return out({ ok: true, status: "ok", account, id: body.id, returned_count: items.length, image_count: items.filter((a) => a.is_image).length, attachments: items });
  }
  case "draft-reply":
  case "draft-new":
  case "draft-delete":
    if (!flag("--yes")) return out({ ok: false, status: "confirmation_required", answer_text: "Confirm first." });
    if (cmd === "draft-delete") return out({ ok: true, status: "draft_deleted", account, id: body.id });
    return out({ ok: true, status: "draft_saved", account, id: "DRAFT_1", is_draft: true, answer_text: "Saved in Drafts; it has not been sent." });
  case "auth status":
    return out({ ok: true, config_dir: process.env.HOME + "/.config/outlook-web-cli", accounts: [{ account: "covernode", saved: true, cdp_port: 9230 }, { account: "adga", saved: scenario !== "adga-unsaved", cdp_port: 9231 }] });
  case "auth refresh":
    return out({ ok: true, rotate: flag("--rotate"), all: flag("--all"), accounts: [{ account: "covernode", ok: true }, { account: "adga", ok: true }] });
  default:
    return out({ ok: false, status: "error", message: "Unknown command " + cmd });
}
`;

// Installs the fake and returns helpers. SHOT is a PNG padded past one 1,000-byte range.
export function installFakeOutlookCli() {
  const dir = mkdtempSync(join(tmpdir(), "phoneclaw-outlook-cli-"));
  const bin = join(dir, "outlook-web-cli");
  const log = join(dir, "calls.jsonl");
  writeFileSync(bin, `#!${process.execPath}\n${FAKE}`);
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  const shot = Buffer.concat([Buffer.from(PNG_1X1, "base64"), Buffer.alloc(2500, 7)]).toString("base64");
  process.env.OUTLOOK_WEB_CLI_BIN = bin;
  process.env.OUTLOOK_FAKE_LOG = log;
  process.env.OUTLOOK_FAKE_SHOT = shot;
  return {
    bin,
    shot,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    reset: () => writeFileSync(log, ""),
    scenario: (name) => { if (name) process.env.OUTLOOK_FAKE_SCENARIO = name; else delete process.env.OUTLOOK_FAKE_SCENARIO; },
    cleanup: () => {
      delete process.env.OUTLOOK_WEB_CLI_BIN;
      delete process.env.OUTLOOK_FAKE_LOG;
      delete process.env.OUTLOOK_FAKE_SHOT;
      delete process.env.OUTLOOK_FAKE_SCENARIO;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
