import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Fake Outlook REST + Graph: a message with a pasted screenshot (inline cid image), a
// signature logo, a PDF and an attached email. Records every request to prove reads only.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  requests.push({ method: req.method, path: url.pathname });
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/api/v2.0/me/messages/MSG_SHOT/attachments") {
    res.writeHead(200);
    res.end(JSON.stringify({ value: [
      { "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A0", Name: "image001.png", ContentType: "image/png", Size: 68, IsInline: true, ContentId: "image001.png@01DD0000.00000000", ContentBytes: PNG_1X1 },
      { "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A1", Name: "../../logo.png", ContentType: "image/png", Size: 68, IsInline: true, ContentId: "image002.png@01DD0000.00000000", ContentBytes: PNG_1X1 },
      { "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A2", Name: "Statement.pdf", ContentType: "application/pdf", Size: 9, IsInline: false, ContentBytes: Buffer.from("%PDF-1.4\n").toString("base64") },
      { "@odata.type": "#Microsoft.OutlookServices.ItemAttachment", Id: "A3", Name: "Fwd: earlier", ContentType: null, Size: 2000, IsInline: false },
    ] }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1.0/me/messages/MSG_GRAPH/attachments") {
    res.writeHead(200);
    res.end(JSON.stringify({ value: [
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "G0", name: "chart.jpg", contentType: "image/jpeg", size: 68, isInline: false, contentBytes: PNG_1X1 },
    ] }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: { message: "not found" } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const restToken = `${b64({ alg: "none" })}.${b64({ aud: "https://outlook.office.com", scp: "Mail.Read" })}.sig`;
const graphToken = `${b64({ alg: "none" })}.${b64({ aud: "https://graph.microsoft.com", scp: "Mail.Read" })}.sig`;
process.env.OUTLOOK_TEST_TOKEN_ADGA = restToken;
process.env.OUTLOOK_TEST_TOKEN_COVERNODE = graphToken;
process.env.OUTLOOK_REST_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OUTLOOK_GRAPH_BASE_URL = `http://127.0.0.1:${port}`;
const saveRoot = await mkdtemp(path.join(tmpdir(), "outlook-att-test-"));
process.env.OUTLOOK_ATTACHMENT_DIR = saveRoot;

const { outlookAttachments, outlookAttachmentInspect } = await import("../fastify-app/outlook-tools.mjs");
const { commandAdapters } = await import("../fastify-app/cli-adapters.mjs");
const { resolveVisionGatewayConfig } = await import("../fastify-app/ai-gateway-vision.mjs");

try {
  // 1. List: inline screenshots show up with content ids; no base64 unless asked.
  const listed = await outlookAttachments({ account: "adga", id: "MSG_SHOT" });
  assert.equal(listed.ok, true);
  assert.equal(listed.returned_count, 4);
  assert.equal(listed.image_count, 2);
  const [shot, logo, pdf, item] = listed.attachments;
  assert.equal(shot.name, "image001.png");
  assert.equal(shot.is_inline, true);
  assert.equal(shot.content_id, "image001.png@01DD0000.00000000");
  assert.equal(shot.is_image, true);
  assert.equal(pdf.is_image, false);
  assert.equal(item.kind, "item");
  assert.equal("data_base64" in shot, false);
  assert.match(listed.answer_text, /4 attachments, 2 images/);

  // 2. include_data + images_only through the CLI adapter.
  const withData = await commandAdapters["outlook attachments"]({ account: "adga", id: "MSG_SHOT", include_data: true, images_only: true }, {});
  assert.equal(withData.returned_count, 2);
  assert.equal(withData.attachments[0].data_base64, PNG_1X1);

  // 3. save: files land under OUTLOOK_ATTACHMENT_DIR with safe names (no path traversal).
  const saved = await outlookAttachments({ account: "adga", id: "MSG_SHOT", save: true });
  assert.ok(saved.save_dir.startsWith(saveRoot));
  for (const att of saved.attachments.filter((x) => x.kind === "file")) {
    assert.ok(att.saved_path.startsWith(saved.save_dir + path.sep), att.saved_path);
  }
  assert.equal(path.basename(saved.attachments[1].saved_path), "1-logo.png");
  assert.deepEqual(await readFile(saved.attachments[0].saved_path), Buffer.from(PNG_1X1, "base64"));
  assert.equal(saved.attachments[3].saved_path, undefined);

  // 4. Graph token shape (camelCase) works too.
  const graph = await outlookAttachments({ account: "covernode", id: "MSG_GRAPH" });
  assert.equal(graph.ok, true);
  assert.equal(graph.attachments[0].content_type, "image/jpeg");
  assert.equal(graph.attachments[0].is_image, true);

  // 5. Inspect: first image by default, by content id, by index; asks for OpenRouter and full text.
  const calls = [];
  const visionAnalyze = async (args) => {
    calls.push(args);
    return { ok: true, provider: "openrouter", model: "google/gemini-3.8-flash", description: "A reports page.", ocr_text: "Reports\nSeptember 2026", answer_text: "A reports page." };
  };
  const first = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", visionAnalyze });
  assert.equal(first.ok, true);
  assert.equal(first.image.name, "image001.png");
  assert.equal(first.ocr_text, "Reports\nSeptember 2026");
  assert.equal(calls[0].provider, "openrouter");
  assert.match(calls[0].prompt, /transcribe ALL visible text/);
  assert.equal(calls[0].images[0].data_base64, PNG_1X1);
  const byCid = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", contentId: "<image002.png@01DD0000.00000000>", prompt: "Read it", visionAnalyze });
  assert.equal(byCid.image.index, 1);
  assert.equal(calls[1].prompt, "Read it");
  const notImage = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", index: 2, visionAnalyze });
  assert.equal(notImage.ok, false);
  assert.equal(notImage.status, "image_not_found");
  assert.equal(calls.length, 2);

  // 6. Reads only.
  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => r.method === "GET"), JSON.stringify(requests));

  // 7. Vision provider selection: OpenRouter when asked and keyed; falls back when not.
  assert.equal(resolveVisionGatewayConfig({ OPENROUTER_API_KEY: "k" }).provider, "openrouter");
  assert.equal(resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g", OPENROUTER_API_KEY: "k" }).provider, "ai_gateway");
  const or = resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g", OPENROUTER_API_KEY: "k" }, { provider: "openrouter" });
  assert.equal(or.provider, "openrouter");
  assert.equal(or.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(or.configured, true);
  assert.equal(resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g" }, { provider: "openrouter" }).provider, "ai_gateway");
  assert.equal(resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g", OPENROUTER_API_KEY: "k", PHONECLAW_VISION_PROVIDER: "openrouter" }).provider, "openrouter");

  console.log("test-outlook-images: ok");
} finally {
  server.close();
  await rm(saveRoot, { recursive: true, force: true });
}
