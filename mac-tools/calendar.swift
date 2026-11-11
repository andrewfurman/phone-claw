// Apple Calendar CLI for PhoneClaw (#152), built on EventKit so recurring events are expanded and edits go back
// through the account (Exchange, iCloud, Google). Compile on the Mac:
//   swiftc -O mac-tools/calendar.swift -o ~/.local/bin/calendar-cli
// Reads:  calendar-cli calendars
//         calendar-cli events --from YYYY-MM-DD --to YYYY-MM-DD [--calendar ID|NAME] [--query TEXT] [-l N] [--tz ZONE]
// Writes (PhoneClaw calls these only after a spoken preview and a yes; add --dry-run for the preview):
//         calendar-cli create --calendar ID|NAME --title T --start DATETIME --end DATETIME [--all-day] [--location L] [--notes N]
//         calendar-cli update --id EVENT_ID [--occurrence ISO] [--span this|future] [--title T] [--start DT] [--end DT] [--location L] [--expect ISO]
//         calendar-cli delete --id EVENT_ID [--occurrence ISO] [--span this|future] [--expect ISO]
// DATETIME is "YYYY-MM-DDTHH:MM" in --tz (default America/New_York) or a full ISO 8601 time with offset.
// --expect is the event's last_modified from the preview; the save is refused if the event changed since.
import EventKit
import Foundation

struct Fail: Error { let status: String; let message: String; var extra: [String: Any] = [:] }

func emit(_ obj: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit((obj["ok"] as? Bool) == true ? 0 : 1)
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { emit(["ok": false, "status": "usage", "message": "calendar-cli calendars|events|create|update|delete"]) }
args.removeFirst()
var opts: [String: String] = [:]
var flags = Set<String>()
let valued: Set<String> = ["--from", "--to", "--calendar", "--query", "-l", "--limit", "--tz", "--title", "--start", "--end", "--location", "--notes", "--id", "--occurrence", "--span", "--expect"]
var i = 0
while i < args.count {
  let a = args[i]
  if valued.contains(a) {
    guard i + 1 < args.count else { emit(["ok": false, "status": "usage", "message": "Missing value for \(a)"]) }
    if opts[a] != nil { emit(["ok": false, "status": "usage", "message": "Duplicate \(a)"]) }
    opts[a] = args[i + 1]; i += 2
  } else if a == "--dry-run" || a == "--all-day" { flags.insert(a); i += 1 }
  else { emit(["ok": false, "status": "usage", "message": "Unknown argument \(a.prefix(40))"]) }
}
for (k, v) in opts where v.count > 500 || v.contains("\0") { emit(["ok": false, "status": "usage", "message": "\(k) is too long"]) }

let zone = TimeZone(identifier: opts["--tz"] ?? "America/New_York") ?? TimeZone(identifier: "America/New_York")!
let isoOut: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.timeZone = zone; f.formatOptions = [.withInternetDateTime]; return f }()
func parseDate(_ s: String, dayOnly: Bool = false) throws -> Date {
  let full = ISO8601DateFormatter(); full.formatOptions = [.withInternetDateTime]
  if let d = full.date(from: s) { return d }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = zone
  for fmt in dayOnly ? ["yyyy-MM-dd"] : ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"] {
    f.dateFormat = fmt
    if let d = f.date(from: s) { return d }
  }
  throw Fail(status: "invalid_date", message: "Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (\(zone.identifier)), got \(s.prefix(40)).")
}

let store = EKEventStore()
func requireAccess() throws {
  let status = EKEventStore.authorizationStatus(for: .event)
  if status == .fullAccess || status == .authorized { return }
  if status == .denied || status == .restricted || status == .writeOnly {
    throw Fail(status: "calendar_permission_denied", message: "Calendar access is not allowed for this tool. On the Mac: System Settings > Privacy & Security > Calendars, allow full access.")
  }
  let sem = DispatchSemaphore(value: 0); var granted = false
  store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
  if sem.wait(timeout: .now() + 50) == .timedOut || !granted {
    throw Fail(status: "calendar_permission_pending", message: "Approve the Calendars access prompt on the Mac (or System Settings > Privacy & Security > Calendars), then try again.")
  }
}

func calInfo(_ c: EKCalendar) -> [String: Any] {
  ["id": c.calendarIdentifier, "title": c.title, "account": c.source.title, "type": ["local", "caldav", "exchange", "subscription", "birthday"][min(Int(c.type.rawValue), 4)], "writable": c.allowsContentModifications]
}
func findCalendar(_ key: String) throws -> EKCalendar {
  let all = store.calendars(for: .event)
  if let c = all.first(where: { $0.calendarIdentifier == key }) { return c }
  let parts = key.split(separator: "/", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
  let hits = all.filter { c in
    parts.count == 2 ? c.source.title.lowercased() == parts[0] && c.title.lowercased() == parts[1] : c.title.lowercased() == parts[0] || c.source.title.lowercased() == parts[0]
  }
  if hits.count == 1 { return hits[0] }
  throw Fail(status: hits.isEmpty ? "calendar_not_found" : "ambiguous_calendar", message: hits.isEmpty ? "No calendar named \(key)." : "Several calendars match \(key); use \"account/calendar\" or the id.", extra: ["candidates": (hits.isEmpty ? all : hits).prefix(12).map(calInfo)])
}
func eventInfo(_ e: EKEvent) -> [String: Any] {
  var out: [String: Any] = ["id": e.eventIdentifier ?? "", "title": e.title ?? "", "start": isoOut.string(from: e.startDate), "end": isoOut.string(from: e.endDate),
    "all_day": e.isAllDay, "calendar": e.calendar.title, "account": e.calendar.source.title, "calendar_id": e.calendar.calendarIdentifier, "recurring": e.hasRecurrenceRules]
  if let l = e.location, !l.isEmpty { out["location"] = l }
  if let m = e.lastModifiedDate { out["last_modified"] = ISO8601DateFormatter().string(from: m) }
  if e.hasRecurrenceRules { out["occurrence"] = isoOut.string(from: e.occurrenceDate ?? e.startDate) }
  return out
}
func findEvent(_ id: String, occurrence: String?) throws -> EKEvent {
  guard let base = store.event(withIdentifier: id) else { throw Fail(status: "event_not_found", message: "That event id was not found; look the event up again.") }
  guard base.hasRecurrenceRules, let occ = occurrence else { return base }
  let when = try parseDate(occ)
  let hits = store.events(matching: store.predicateForEvents(withStart: when.addingTimeInterval(-60), end: when.addingTimeInterval(86400), calendars: [base.calendar]))
    .filter { $0.eventIdentifier == id && abs(($0.occurrenceDate ?? $0.startDate).timeIntervalSince(when)) < 60 }
  guard let hit = hits.first else { throw Fail(status: "occurrence_not_found", message: "No occurrence of that event at \(occ).") }
  return hit
}
func checkExpect(_ e: EKEvent) throws {
  guard let want = opts["--expect"] else { return }
  let have = e.lastModifiedDate.map { ISO8601DateFormatter().string(from: $0) } ?? ""
  if have != want { throw Fail(status: "event_changed", message: "The event changed since the preview; preview again.", extra: ["last_modified": have]) }
}

do {
  try requireAccess()
  switch command {
  case "calendars":
    emit(["ok": true, "action": "calendar_calendars", "calendars": store.calendars(for: .event).map(calInfo)])
  case "events":
    guard let fromS = opts["--from"], let toS = opts["--to"] else { throw Fail(status: "usage", message: "events needs --from and --to") }
    let from = try parseDate(fromS, dayOnly: true), to = try parseDate(toS, dayOnly: true).addingTimeInterval(86400)
    guard to > from, to.timeIntervalSince(from) <= 62 * 86400 else { throw Fail(status: "invalid_range", message: "Use a date range of 1 to 62 days.") }
    let limit = min(max(Int(opts["-l"] ?? opts["--limit"] ?? "20") ?? 20, 1), 50)
    let cals = try opts["--calendar"].map { [try findCalendar($0)] }
    var events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: cals)).sorted { $0.startDate < $1.startDate }
    if let q = opts["--query"]?.lowercased() { events = events.filter { ($0.title ?? "").lowercased().contains(q) || ($0.location ?? "").lowercased().contains(q) } }
    emit(["ok": true, "action": "calendar_events", "timezone": zone.identifier, "total": events.count, "events": events.prefix(limit).map(eventInfo)])
  case "create":
    guard let calKey = opts["--calendar"], let title = opts["--title"], let s = opts["--start"], let en = opts["--end"] else { throw Fail(status: "usage", message: "create needs --calendar, --title, --start and --end") }
    let cal = try findCalendar(calKey)
    guard cal.allowsContentModifications else { throw Fail(status: "calendar_read_only", message: "\(cal.title) (\(cal.source.title)) is read-only.") }
    let e = EKEvent(eventStore: store); e.calendar = cal; e.title = title; e.isAllDay = flags.contains("--all-day")
    e.startDate = try parseDate(s); e.endDate = try parseDate(en)
    if e.isAllDay && e.endDate <= e.startDate { e.endDate = e.startDate.addingTimeInterval(86400) }
    guard e.endDate > e.startDate else { throw Fail(status: "invalid_range", message: "The end must be after the start.") }
    e.location = opts["--location"]; e.notes = opts["--notes"]
    if flags.contains("--dry-run") { var p = eventInfo(e); p["id"] = nil; emit(["ok": true, "action": "calendar_create_preview", "dry_run": true, "event": p]) }
    try store.save(e, span: .thisEvent, commit: true)
    emit(["ok": true, "action": "calendar_created", "event": eventInfo(store.event(withIdentifier: e.eventIdentifier) ?? e)])
  case "update", "delete":
    guard let id = opts["--id"] else { throw Fail(status: "usage", message: "\(command) needs --id") }
    let e = try findEvent(id, occurrence: opts["--occurrence"])
    let span: EKSpan = opts["--span"] == "future" ? .futureEvents : .thisEvent
    if e.hasRecurrenceRules && opts["--occurrence"] == nil { throw Fail(status: "occurrence_required", message: "This is a repeating event; say which date (occurrence) to change.") }
    guard e.calendar.allowsContentModifications else { throw Fail(status: "calendar_read_only", message: "\(e.calendar.title) is read-only.") }
    try checkExpect(e)
    let before = eventInfo(e)
    if command == "delete" {
      if flags.contains("--dry-run") { emit(["ok": true, "action": "calendar_delete_preview", "dry_run": true, "event": before, "span": span == .futureEvents ? "future" : "this"]) }
      try store.remove(e, span: span, commit: true)
      emit(["ok": true, "action": "calendar_deleted", "event": before, "span": span == .futureEvents ? "future" : "this"])
    }
    if let t = opts["--title"] { e.title = t }
    if let s = opts["--start"] { let d = try parseDate(s); let len = e.endDate.timeIntervalSince(e.startDate); e.startDate = d; if opts["--end"] == nil { e.endDate = d.addingTimeInterval(len) } }
    if let en = opts["--end"] { e.endDate = try parseDate(en) }
    if let l = opts["--location"] { e.location = l }
    guard e.endDate > e.startDate else { throw Fail(status: "invalid_range", message: "The end must be after the start.") }
    let after = eventInfo(e)
    if flags.contains("--dry-run") { store.reset(); emit(["ok": true, "action": "calendar_update_preview", "dry_run": true, "before": before, "after": after, "span": span == .futureEvents ? "future" : "this"]) }
    try store.save(e, span: span, commit: true)
    emit(["ok": true, "action": "calendar_updated", "before": before, "after": eventInfo(store.event(withIdentifier: id) ?? e), "span": span == .futureEvents ? "future" : "this"])
  default:
    throw Fail(status: "usage", message: "Unknown command \(command.prefix(20))")
  }
} catch let f as Fail {
  var out: [String: Any] = ["ok": false, "status": f.status, "message": f.message]; out.merge(f.extra) { a, _ in a }; emit(out)
} catch {
  emit(["ok": false, "status": "calendar_error", "message": String(describing: error).prefix(200).description])
}
