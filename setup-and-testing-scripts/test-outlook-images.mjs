import assert from "node:assert/strict";
import http from "node:http";

// Fake Outlook REST + Graph: a message with a pasted screenshot (inline cid image), a
// signature logo, a PDF and an attached email. Records every request to prove reads only.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// image001 is padded past one 1,000-byte range so the byte-range test needs several pieces.
const SHOT = Buffer.concat([Buffer.from(PNG_1X1, "base64"), Buffer.alloc(2500, 7)]).toString("base64");
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  requests.push({ method: req.method, path: url.pathname });
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/api/v2.0/me/messages/MSG_SHOT/attachments") {
    res.writeHead(200);
    res.end(JSON.stringify({ value: [
      { "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A0", Name: "image001.png", ContentType: "image/png", Size: 2568, IsInline: true, ContentId: "image001.png@01DD0000.00000000", ContentBytes: SHOT },
      { "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A1", Name: "../../logo.png", ContentType: "image/png", Size: 68, IsInline: true, ContentId: "image002.png@01DD0000.00000000", ContentBytes: PNG_1X1 },
      { "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A2", Name: "Statement.pdf", ContentType: "application/pdf", Size: 9, IsInline: false, ContentBytes: Buffer.from("%PDF-1.4\n").toString("base64") },
      { "@odata.type": "#Microsoft.OutlookServices.ItemAttachment", Id: "A3", Name: "Fwd: earlier", ContentType: null, Size: 2000, IsInline: false },
    ] }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v2.0/me/messages/MSG_SHOT/attachments/A0") {
    res.writeHead(200);
    res.end(JSON.stringify({ "@odata.type": "#Microsoft.OutlookServices.FileAttachment", Id: "A0", Name: "image001.png", ContentType: "image/png", Size: 2568, IsInline: true, ContentId: "image001.png@01DD0000.00000000", ContentBytes: SHOT }));
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

const { outlookAttachments, outlookAttachmentInspect } = await import("../fastify-app/outlook-tools.mjs");
const { commandAdapters } = await import("../fastify-app/cli-adapters.mjs");
const { resolveVisionGatewayConfig, analyzeImagesWithGateway } = await import("../fastify-app/ai-gateway-vision.mjs");

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
  assert.equal(withData.attachments[0].data_base64, SHOT);

  // 3. One attachment, whole or as byte ranges joined back together; nothing on disk.
  const png = Buffer.from(SHOT, "base64");
  const one = await outlookAttachments({ account: "adga", id: "MSG_SHOT", contentId: "<image001.png@01DD0000.00000000>" });
  assert.equal(one.attachment.name, "image001.png");
  assert.equal(one.total_bytes, png.length);
  assert.equal(one.data_base64, SHOT);
  const firstImage = await outlookAttachments({ account: "adga", id: "MSG_SHOT", index: 1, includeData: false });
  assert.equal(firstImage.attachment.name, "../../logo.png");
  assert.equal(await outlookAttachments({ account: "adga", id: "MSG_SHOT", index: 9 }).then((r) => r.status), "attachment_not_found");
  const pieces = [];
  let next = 0;
  let piece = 0;
  while (next !== null) {
    const r = await commandAdapters["outlook attachments"]({ account: "adga", id: "MSG_SHOT", attachment_id: piece ? "A0" : undefined, index: piece ? undefined : 0, offset: next, length: 1000 }, {});
    assert.equal(r.ok, true);
    pieces.push(Buffer.from(r.data_base64, "base64"));
    next = r.next_offset;
    piece += 1;
  }
  assert.deepEqual(Buffer.concat(pieces), png);
  assert.ok(requests.some((r) => r.path.endsWith("/attachments/A0")), "later pieces fetch only that attachment");

  // 3b. Attachments stay in memory for a few minutes: repeat calls don't hit Outlook again.
  const before = requests.length;
  await outlookAttachments({ account: "adga", id: "MSG_SHOT", index: 0, offset: 0, length: 1000 });
  await outlookAttachments({ account: "adga", id: "MSG_SHOT", index: 0, offset: 1000, length: 1000 });
  assert.equal(requests.length, before);

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
  assert.equal(calls[0].images[0].data_base64, SHOT);
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

  // 8. OpenRouter request: DeepSeek V4.1 Flash pinned to Baseten fast, reasoning off, no
  //    response_format (Baseten doesn't support it); a brief 429 is retried; env overrides.
  assert.equal(or.model, "deepseek/deepseek-v4.1-flash-1017");
  const sent = [];
  let status = 429;
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const s = status; status = 200;
    return new Response(s === 200
      ? JSON.stringify({ model: "deepseek/deepseek-v4.1-flash-1017", provider: "BaseTen", choices: [{ message: { content: '{"description":"d","ocr_text":"all text","answer_text":"a"}' } }], usage: { cost: 0.0016 } })
      : JSON.stringify({ error: { message: "rate-limited upstream" } }), { status: s });
  };
  const v = await analyzeImagesWithGateway({ provider: "openrouter", env: { OPENROUTER_API_KEY: "k" }, prompt: "p", images: [{ media_type: "image/png", data_base64: PNG_1X1 }], fetchImpl, retryDelayMs: 1 });
  assert.equal(v.ok, true);
  assert.equal(v.upstream_provider, "BaseTen");
  assert.equal(v.ocr_text, "all text");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(sent[0].body.provider, { order: ["baseten/fast"], allow_fallbacks: false });
  assert.deepEqual(sent[0].body.reasoning, { enabled: false });
  assert.equal("response_format" in sent[0].body, false);
  const custom = resolveVisionGatewayConfig({ OPENROUTER_API_KEY: "k", OPENROUTER_VISION_MODEL: "google/gemini-3.8-flash", OPENROUTER_VISION_PROVIDER: "", OPENROUTER_VISION_REASONING: "low" }, { provider: "openrouter" });
  assert.equal(custom.model, "google/gemini-3.8-flash");
  assert.equal(custom.routing, null);
  assert.deepEqual(custom.reasoning, { effort: "low" });
  // The AI gateway path is unchanged: no routing or reasoning fields.
  const gw = resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g" });
  assert.equal(gw.model, "google/gemini-3.8-flash");
  assert.equal(gw.routing, undefined);

  console.log("test-outlook-images: ok");
} finally {
  server.close();
}
