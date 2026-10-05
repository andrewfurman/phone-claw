import { executeCli } from "../shared/cli-process.mjs";
import { sendgridEmailSend } from "./sendgrid-tools.mjs";

// Apple Photos → email (#112). The photo bytes come from the Mac over the
// mac-photos SSH wrapper (`photos export <id>`) and go straight to SendGrid;
// they never pass through the voice envelope. Sender and recipient are fixed so
// a voice request can only ever send Andrew's own photo to Andrew.
const DEFAULT_WRAPPER = "/home/phoneclaw/bin/mac-photos";
const DEFAULT_FROM = "photos@aifurman.com";
const DEFAULT_TO = "aifurman@gmail.com";
const PHOTO_ID = /^[0-9A-Fa-f]{8}$/;

export async function photosEmail(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.executeCli || executeCli;
  const send = deps.sendgridEmailSend || sendgridEmailSend;
  const id = String(options.id ?? options.photo_id ?? options.photoId ?? "").trim().replace(/^id\s+/i, "");
  const from = env.PHOTOS_EMAIL_FROM || DEFAULT_FROM;
  const to = env.PHOTOS_EMAIL_TO || DEFAULT_TO;

  if (!PHOTO_ID.test(id)) {
    return fail("invalid_photo_id", "Give the 8-character photo id from a photos listing, like 9E12CC9C.");
  }
  if (!options.confirmed) {
    return {
      ok: false,
      status: "confirmation_required",
      requires_confirmation: true,
      preview: { id: id.toUpperCase(), from, to },
      message: `Ask Andrew: "Do you want me to email photo ${id.toUpperCase()} to ${to}?" Then call again with confirmed=true.`,
      answer_text: `Confirm with Andrew before emailing photo ${id.toUpperCase()} to ${to}.`,
    };
  }

  const exported = await run(env.MAC_PHOTOS_BIN || DEFAULT_WRAPPER, ["export", id], {
    env: { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || "", MAC_SSH_ALIAS: env.MAC_SSH_ALIAS || "" },
    timeoutMs: 45_000,
    maxBuffer: 10_000_000,
  });
  if (!exported.ok) {
    const reason = (exported.stderr || "").replace(/^photos:\s*/i, "").trim().slice(0, 200);
    return fail(
      exported.status === "cli_timeout" ? "photos_timeout" : "photo_export_failed",
      reason || "Could not fetch that photo from the Mac.",
    );
  }
  let photo;
  try {
    photo = JSON.parse(exported.stdout);
  } catch {
    return fail("photo_export_failed", "The Mac returned an unreadable photo export.");
  }
  if (!photo?.ok || !photo.jpeg_base64) return fail("photo_export_failed", "The Mac did not return the photo.");

  const when = describeDate(photo.taken);
  const people = photo.people ? ` with ${photo.people}` : "";
  const note = photo.note ? `\n${photo.note}` : "";
  const sizeNote = photo.source === "thumbnail"
    ? "\n(Small version: the full-size original is in iCloud.)"
    : "";
  const result = await send({
    from,
    to,
    subject: `Photo from ${when}${people}`,
    body: `Here's the photo you asked PhoneClaw for: ${when}${people}.${note}${sizeNote}\n\nPhoto id ${photo.id}`,
    attachments: [{ content: photo.jpeg_base64, filename: `photo-${photo.id}.jpg`, type: "image/jpeg" }],
    previewed: true,
    confirmed: true,
  }, deps.sendgridDeps);

  if (!result?.ok) return { ...result, answer_text: result?.answer_text || "The photo email did not send." };
  return {
    ok: true,
    status: "ok",
    action: "photos_email_sent",
    id: photo.id,
    taken: photo.taken,
    people: photo.people,
    source: photo.source,
    to,
    from,
    message_id: result.message_id || null,
    answer_text: `Emailed the photo from ${when}${people} to ${to}.${photo.source === "thumbnail" ? " It's a small version because the original is in iCloud." : ""}`,
  };
}

function describeDate(taken) {
  const d = new Date(`${String(taken || "").replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "your library";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fail(status, message) {
  return { ok: false, status, message, answer_text: message };
}

// ---- #151: faces, analysis, title/caption edits and photo iMessages -------------------------------------------
import { analyzeImagesWithGateway } from "./ai-gateway-vision.mjs";
import { normalizeRecipient } from "./imessage-tools.mjs";
import { looksLikeName, resolveRecipient } from "./contacts-tools.mjs";

const macEnv = env => ({ PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || "", MAC_SSH_ALIAS: env.MAC_SSH_ALIAS || "" });
const photoId = options => String(options.id ?? options.photo_id ?? options.photoId ?? "").trim().replace(/^id\s+/i, "").toUpperCase();
const lastJson = stdout => { try { return JSON.parse(String(stdout || "").trim().split("\n").at(-1)); } catch { return null; } };
async function macPhotos(args, deps, timeoutMs = 45_000, maxBuffer = 1_000_000) {
  const env = deps.env || process.env;
  return (deps.executeCli || executeCli)(env.MAC_PHOTOS_BIN || DEFAULT_WRAPPER, args, { env: macEnv(env), timeoutMs, maxBuffer });
}
const badId = () => fail("invalid_photo_id", "Give the 8-character photo id from a photos listing, like 9E12CC9C.");
const macError = (r, fallback) => (r.status === "cli_timeout" ? "Photos on the Mac did not answer in time." : (r.stderr || "").replace(/^photos:\s*/i, "").trim().slice(0, 200) || lastJson(r.stdout)?.message || fallback);

export async function photosFaces(options = {}, deps = {}) {
  const id = photoId(options);
  if (!PHOTO_ID.test(id)) return badId();
  const r = await macPhotos(["faces", id], deps);
  const data = lastJson(r.stdout);
  if (!r.ok || !data?.ok) return fail("photos_faces_failed", macError(r, "Could not read that photo's faces."));
  const who = data.people.length ? data.people.join(", ") : "nobody named";
  return { ...data, status: "ok", answer_text: `${data.face_count} face${data.face_count === 1 ? "" : "s"} detected: ${who}${data.unnamed_faces ? `, plus ${data.unnamed_faces} unnamed` : ""}.` };
}

export async function photosAnalyze(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const id = photoId(options);
  if (!PHOTO_ID.test(id)) return badId();
  const question = String(options.question ?? options.prompt ?? "").trim().slice(0, 300) || "Describe this photo in two sentences: who and what is in it, the setting, and anything notable.";
  const exported = await macPhotos(["export", id], deps, 45_000, 10_000_000);
  const photo = lastJson(exported.stdout);
  if (!exported.ok || !photo?.jpeg_base64) return fail("photo_export_failed", macError(exported, "Could not fetch that photo from the Mac."));
  const context = `Photo taken ${photo.taken}${photo.people ? ` with ${photo.people} (tagged in Photos)` : ""}. Question: ${question}`;
  const result = await (deps.analyzeImagesWithGateway || analyzeImagesWithGateway)({ prompt: context, images: [{ media_type: "image/jpeg", data_base64: photo.jpeg_base64 }], env });
  if (!result?.ok) return { ...fail(result?.status || "photo_analysis_failed", result?.message || "The photo analysis failed."), model: result?.model };
  return { ok: true, status: "ok", action: "photos_analyzed", id, taken: photo.taken, people: photo.people, source: photo.source, model: result.model, question, description: result.description, answer_text: result.answer_text || result.description };
}

export async function photosEdit(options = {}, deps = {}) {
  const id = photoId(options);
  if (!PHOTO_ID.test(id)) return badId();
  const fields = [];
  for (const key of ["title", "description"]) {
    if (options[key] == null) continue;
    const value = String(options[key]).trim();
    if (value.length > 500 || /[\0]/.test(value)) return fail("invalid_" + key, `The ${key} must be under 500 characters.`, key);
    fields.push(`--${key}`, value);
  }
  if (!fields.length) return fail("missing_field", "Say the new title or caption.", "title");
  const dry = await macPhotos(["set-meta", id, ...fields, "--dry-run"], deps);
  const preview = lastJson(dry.stdout);
  if (!dry.ok || !preview?.ok) return fail(preview?.status || "photos_meta_failed", preview?.message || macError(dry, "Could not prepare that change."));
  const parts = [];
  if (options.title != null) parts.push(`title "${preview.before.title || "(none)"}" to "${preview.after.title}"`);
  if (options.description != null) parts.push(`caption "${preview.before.description || "(none)"}" to "${preview.after.description}"`);
  const spoken = `For the photo from ${describeDate(preview.taken)}${preview.people ? ` with ${preview.people}` : ""}, change the ${parts.join(" and the ")}`;
  if (!options.previewed || !options.confirmed) {
    return { ok: false, status: "confirmation_required", action: "photos_edit_confirmation_required", requires_preview: !options.previewed, requires_confirmation: true, preview: { id, ...preview, change: spoken },
      message: `Read this aloud: "${spoken}". Ask "Do you want me to make this change?" Only after Andrew says yes, call again with the same fields, previewed=true and confirmed=true.`, answer_text: `Confirm with Andrew: ${spoken}` };
  }
  const saved = await macPhotos(["set-meta", id, ...fields], deps, 90_000);
  const result = lastJson(saved.stdout);
  if (!saved.ok || !result?.ok) return { ...fail(result?.action === "photos_meta_mismatch" ? "photos_meta_mismatch" : "photos_meta_failed", result?.message || (result?.action === "photos_meta_mismatch" ? "Photos saved something different from what was asked; check the photo." : macError(saved, "The change was not saved."))), read_back: result?.read_back };
  return { ok: true, status: "ok", action: "photos_edited", id, read_back: result.read_back, change: spoken, answer_text: `Done. ${spoken.replace(/^For/, "For")} is saved.` };
}

export async function imessageSendPhoto(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const id = photoId(options);
  if (!PHOTO_ID.test(id)) return badId();
  let to = normalizeRecipient(options.to), name = null;
  if (!to && looksLikeName(options.to)) {
    const resolved = await (deps.resolveRecipient || resolveRecipient)(String(options.to), deps);
    if (!resolved.ok) return resolved;
    to = normalizeRecipient(resolved.to); name = resolved.name;
  }
  if (!to) return fail("invalid_recipient", "Give a contact name, phone number or iMessage email.", "to");
  const text = String(options.text ?? options.message ?? "").trim();
  if (text.length > 1000) return fail("text_too_long", "Keep the message under 1000 characters.", "text");
  const meta = await macPhotos(["meta", id], deps);
  const info = lastJson(meta.stdout);
  if (!meta.ok || !info?.ok) return fail("photo_not_found", macError(meta, "Could not find that photo."));
  const who = name ? `${name} at ${to}` : to;
  const spoken = `Text ${who} the photo from ${describeDate(info.taken)}${info.people ? ` with ${info.people}` : ""}${text ? `, with the message "${text}"` : ""}`;
  const preview = { id, to, ...(name ? { name } : {}), text, taken: info.taken, people: info.people, change: spoken };
  if (!options.previewed || !options.confirmed) {
    return { ok: false, status: "confirmation_required", action: "imessage_photo_confirmation_required", requires_preview: !options.previewed, requires_confirmation: true, preview,
      message: `Read this aloud: "${spoken}". Ask "Do you want me to send it now?" Only after Andrew says yes, call again with the same fields, previewed=true and confirmed=true.`, answer_text: `Confirm with Andrew: ${spoken}` };
  }
  const file = await macPhotos(["export-file", id], deps, 60_000);
  const exported = lastJson(file.stdout);
  if (!file.ok || !exported?.path) return { ...fail("photo_export_failed", macError(file, "Could not prepare the photo on the Mac.")), preview };
  const args = ["send", "--to", to, "--file", exported.path, ...(text ? ["--text", text] : []), "--service", "imessage", "--json"];
  const sent = await (deps.executeCli || executeCli)(env.MAC_IMSG_BIN || "/home/phoneclaw/bin/mac-imsg", args, { env: macEnv(env), timeoutMs: 60_000, maxBuffer: 1_000_000 });
  if (sent.status === "cli_timeout") return { ...fail("imessage_send_timeout", `Sending the photo to ${who} timed out, so delivery is unconfirmed. Check Messages before retrying.`), preview };
  if (!sent.ok) return { ...fail("imessage_send_failed", `The photo to ${who} did not send${(sent.stderr || sent.stdout || "").trim() ? `: ${(sent.stderr || sent.stdout).trim().slice(0, 200)}` : "."}`), preview };
  return { ok: true, status: "ok", action: "imessage_photo_sent", id, to, ...(name ? { name } : {}), text, source: exported.source, output: lastJson(sent.stdout), answer_text: `Sent the photo to ${name || to}.` };
}
