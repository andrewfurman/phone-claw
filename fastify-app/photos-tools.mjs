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
