import { executeCli } from "../shared/cli-process.mjs";

// Apple Calendar (#152): reads and confirmed edits for the Exchange (and other) calendars synced into macOS Calendar
// on the Mac behind mac-calendar. The Mac tool uses EventKit, so repeating events are expanded and edits go back
// through the account. Writes: dry run -> spoken preview -> previewed + outer confirmed, guarded by the event's
// last_modified so a changed event is never overwritten.
const DEFAULT_WRAPPER = "/home/phoneclaw/bin/mac-calendar";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/;
const text = (v, max = 200) => { const t = String(v ?? "").trim(); return t && t.length <= max && !/[\0\r\n]/.test(t) ? t : null; };

async function mac(args, deps, timeoutMs = 60_000) {
  const env = deps.env || process.env;
  const r = await (deps.executeCli || executeCli)(env.MAC_CALENDAR_BIN || DEFAULT_WRAPPER, args, {
    env: { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || "", MAC_CALENDAR_SSH_ALIAS: env.MAC_CALENDAR_SSH_ALIAS || "" },
    timeoutMs, maxBuffer: 2_000_000,
  });
  if (r.status === "cli_timeout") return { ok: false, status: "calendar_timeout", message: "Calendar on the Mac did not answer in time." };
  try { return JSON.parse(String(r.stdout || "").trim().split("\n").at(-1)); } catch { return { ok: false, status: "calendar_failed", message: (r.stderr || "Calendar tool failed.").trim().slice(0, 200) }; }
}
const relay = r => ({ ...r, answer_text: r.answer_text || r.message });
const today = (tz = "America/New_York") => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const say = e => {
  const d = new Date(e.start);
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
  const time = e.all_day ? "all day" : d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${e.title} on ${day} ${time} (${e.account} ${e.calendar})`;
};

export async function calendarList(_options = {}, deps = {}) {
  const r = await mac(["calendars"], deps);
  if (!r.ok) return relay(r);
  return { ...r, status: "ok", answer_text: `${r.calendars.length} calendars: ${r.calendars.slice(0, 8).map(c => `${c.account} ${c.title}`).join("; ")}.` };
}

export async function calendarEvents(options = {}, deps = {}) {
  const from = options.from ?? options.date ?? today();
  const to = options.to ?? (options.date ? options.date : addDays(from, 6));
  if (!DAY.test(from) || !DAY.test(to)) return relay({ ok: false, status: "invalid_date", message: "Use dates like 2026-10-08." });
  const args = ["events", "--from", from, "--to", to, "-l", String(Math.min(Math.max(Number(options.limit) || 20, 1), 50))];
  if (options.calendar != null) { const c = text(options.calendar, 120); if (!c) return relay({ ok: false, status: "invalid_calendar", message: "Calendar name is too long." }); args.push("--calendar", c); }
  if (options.query != null) { const q = text(options.query, 80); if (!q) return relay({ ok: false, status: "invalid_query", message: "Search text is too long." }); args.push("--query", q); }
  const r = await mac(args, deps);
  if (!r.ok) return relay(r);
  return { ...r, status: "ok", from, to, answer_text: r.events.length ? `${r.total} event${r.total === 1 ? "" : "s"}: ${r.events.slice(0, 5).map(say).join("; ")}.` : `No events from ${from} to ${to}.` };
}

export function calendarEditArgs(o) {
  const op = String(o.op || o.action || "").toLowerCase();
  const bad = (status, message, field) => ({ error: { ok: false, status, field, message, answer_text: message } });
  if (!["create", "update", "delete"].includes(op)) return bad("invalid_op", 'op must be "create", "update" or "delete".', "op");
  const args = [op];
  const when = key => { if (o[key] == null) return true; const v = String(o[key]).trim(); if (!WHEN.test(v)) return false; args.push(`--${key}`, v); return true; };
  if (op === "create") {
    const cal = text(o.calendar, 120), title = text(o.title);
    if (!cal) return bad("missing_field", "Say which calendar (account and name).", "calendar");
    if (!title) return bad("missing_field", "Give the event a title.", "title");
    if (o.start == null || o.end == null) return bad("missing_field", "Give a start and end time.", "start");
    args.push("--calendar", cal, "--title", title);
    if (!when("start") || !when("end")) return bad("invalid_date", "Use times like 2026-10-08T15:00.", "start");
    if (o.all_day === true || o.all_day === "true") args.push("--all-day");
  } else {
    const id = text(o.id, 300);
    if (!id) return bad("missing_field", "Look the event up first and pass its id.", "id");
    args.push("--id", id);
    if (o.occurrence != null) { const v = String(o.occurrence).trim(); if (!WHEN.test(v)) return bad("invalid_date", "occurrence must be the event's date or time.", "occurrence"); args.push("--occurrence", v); }
    if (o.span != null) { if (!["this", "future"].includes(o.span)) return bad("invalid_span", 'span must be "this" or "future".', "span"); args.push("--span", o.span); }
    if (op === "update") {
      const before = args.length;
      if (o.title != null) { const t = text(o.title); if (!t) return bad("invalid_title", "Title is too long.", "title"); args.push("--title", t); }
      if (!when("start") || !when("end")) return bad("invalid_date", "Use times like 2026-10-08T15:00.", "start");
      if (args.length === before && o.location == null) return bad("missing_field", "Say what to change (title, start, end or location).", "title");
    }
  }
  for (const key of ["location", "notes"]) {
    if (o[key] == null || (op === "delete")) continue;
    const v = text(o[key], key === "notes" ? 500 : 200); if (!v) return bad("invalid_" + key, `The ${key} is too long.`, key);
    if (key === "notes" && op !== "create") continue;
    args.push(`--${key}`, v);
  }
  return { op, args };
}

export async function calendarEdit(options = {}, deps = {}) {
  const built = calendarEditArgs(options);
  if (built.error) return built.error;
  const dry = await mac([...built.args, "--dry-run"], deps);
  if (!dry.ok) return relay(dry);
  const event = dry.event || dry.after;
  const spoken = built.op === "create" ? `Add ${say(dry.event)}`
    : built.op === "delete" ? `Delete ${say(dry.event)}${dry.span === "future" ? " and all later repeats" : ""}`
    : `Change ${say(dry.before)} to ${say(dry.after)}${dry.span === "future" ? ", for this and later repeats" : ""}`;
  const expected = (dry.before || dry.event)?.last_modified;
  if (!options.previewed || !options.confirmed) {
    return { ok: false, status: "confirmation_required", action: `calendar_${built.op}_confirmation_required`, requires_preview: !options.previewed, requires_confirmation: true,
      preview: { op: built.op, change: spoken, event, ...(built.op !== "create" && expected ? { expected_last_modified: expected } : {}) },
      message: `Read this aloud: "${spoken}". Ask "Do you want me to make this change?" Only after Andrew says yes, call again with the same fields, previewed=true, confirmed=true${built.op !== "create" && expected ? ` and expected_last_modified="${expected}"` : ""}.`,
      answer_text: `Confirm with Andrew: ${spoken}` };
  }
  const expect = built.op === "create" ? null : String(options.expected_last_modified || expected || "");
  const saved = await mac(expect ? [...built.args, "--expect", expect] : built.args, deps, 90_000);
  if (!saved.ok) return relay(saved.status === "calendar_timeout" ? { ...saved, message: "Saving to Calendar timed out, so the change is unconfirmed. Check the calendar before retrying." } : saved);
  return { ...saved, status: "ok", change: spoken, answer_text: `Done: ${spoken.charAt(0).toLowerCase()}${spoken.slice(1)}.` };
}
