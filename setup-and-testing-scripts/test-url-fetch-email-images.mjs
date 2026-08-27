import {
  inspectEmailImagesFromRawMessage,
  urlFetch,
} from "../fastify-app/cli-tools.mjs";

const pngOnePixelBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGA" +
  "WjR9awAAAABJRU5ErkJggg==";
const paddedPngOnePixelBase64 = Buffer.concat([
  Buffer.from(pngOnePixelBase64, "base64"),
  Buffer.alloc(2_000),
]).toString("base64");
const gifOnePixelBase64 =
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

const rawEmail = [
  "From: Newsletter <news@example.com>",
  "To: Andrew <andrew@example.com>",
  "Subject: Visual newsletter",
  "Content-Type: multipart/related; boundary=\"root-boundary\"",
  "",
  "--root-boundary",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  '<html><body><p>Hello</p><img src=3D"cid:logo1" alt=3D"Company logo">' +
    '<img src=3D"https://example.com/tracker.png" alt=3D"Tracking pixel"></body></html>',
  "--root-boundary",
  "Content-Type: image/png; name=\"logo.png\"",
  "Content-Disposition: inline; filename=\"logo.png\"",
  "Content-ID: <logo1>",
  "Content-Transfer-Encoding: base64",
  "",
  paddedPngOnePixelBase64,
  "--root-boundary",
  "Content-Type: image/gif; name=\"promo.gif\"",
  "Content-Disposition: attachment; filename=\"promo.gif\"",
  "Content-Transfer-Encoding: base64",
  "",
  gifOnePixelBase64,
  "--root-boundary--",
  "",
].join("\r\n");

const metadataOnly = inspectEmailImagesFromRawMessage(rawEmail, {
  includeData: false,
});
const boundedWithData = inspectEmailImagesFromRawMessage(rawEmail, {
  includeData: true,
  maxImages: 1,
  maxImageBytes: 20,
});
const blockedLocalhost = await urlFetch({
  url: "http://127.0.0.1:8000/health",
});
const unsubscribeNeedsConfirmation = await urlFetch({
  url: "https://example.com/unsubscribe",
  purpose: "unsubscribe",
});
const publicFetch = await urlFetch({
  url: "https://example.com",
  maxBodyChars: 2_000,
});

const checks = {
  metadata_found_two_images: metadataOnly.images.length === 2,
  metadata_found_html_images: metadataOnly.html_images.length === 2,
  metadata_matched_cid:
    metadataOnly.html_images[0]?.is_cid === true &&
    metadataOnly.html_images[0]?.embedded_image_index === 1,
  metadata_detected_png_dimensions:
    metadataOnly.images[0]?.width === 1 && metadataOnly.images[0]?.height === 1,
  metadata_omits_base64_by_default: metadataOnly.images.every((image) => !image.data_base64),
  bounded_data_caps_results: boundedWithData.images.length === 1 && boundedWithData.has_more,
  bounded_data_truncates_base64: boundedWithData.images[0]?.data_truncated === true,
  blocks_private_url: blockedLocalhost.status === "blocked_private_url",
  unsubscribe_requires_confirmation: unsubscribeNeedsConfirmation.status === "confirmation_required",
  public_fetch_ok:
    publicFetch.ok === true &&
    publicFetch.status_code === 200 &&
    /example domain/i.test(publicFetch.body_text || ""),
};
const ok = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok,
      image_summary: {
        returned_count: metadataOnly.images.length,
        html_image_count: metadataOnly.html_images.length,
        first_image: {
          source: metadataOnly.images[0]?.source,
          media_type: metadataOnly.images[0]?.media_type,
          filename: metadataOnly.images[0]?.filename,
          width: metadataOnly.images[0]?.width,
          height: metadataOnly.images[0]?.height,
        },
      },
      url_fetch_summary: {
        blocked_localhost_status: blockedLocalhost.status,
        unsubscribe_status: unsubscribeNeedsConfirmation.status,
        public_status: publicFetch.status_code,
        public_title: publicFetch.title,
      },
      checks,
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);
