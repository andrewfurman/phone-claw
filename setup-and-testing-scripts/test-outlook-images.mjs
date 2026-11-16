import assert from "node:assert/strict";
import { installFakeOutlookCli } from "./outlook-fake-cli.mjs";

// Attachments come from the outlook-web-cli binary (a fake here); image inspection uses
// phone-claw's own vision gateway on the bytes the binary returns.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fake = installFakeOutlookCli();
const SHOT = fake.shot;

const { outlookAttachments, outlookAttachmentInspect } = await import("../fastify-app/outlook-tools.mjs");
const { commandAdapters } = await import("../fastify-app/cli-adapters.mjs");
const { resolveVisionGatewayConfig, analyzeImagesWithGateway } = await import("../fastify-app/ai-gateway-vision.mjs");

try {
  // 1. List: passes the snake_case body through; no base64 unless asked.
  const listed = await outlookAttachments({ account: "AD-GA", id: "MSG_SHOT" });
  assert.equal(listed.ok, true);
  assert.equal(listed.returned_count, 3);
  assert.equal("data_base64" in listed.attachments[0], false);
  assert.deepEqual(fake.calls().at(-1).body, { account: "adga", id: "MSG_SHOT" });

  // 2. include_data + images_only through the CLI adapter.
  const withData = await commandAdapters["outlook attachments"]({ account: "adga", id: "MSG_SHOT", include_data: true, images_only: true, max_data_bytes: 500000 }, {});
  assert.equal(withData.returned_count, 2);
  assert.equal(withData.attachments[0].data_base64, SHOT);
  assert.deepEqual(fake.calls().at(-1).body, { account: "adga", id: "MSG_SHOT", include_data: true, max_data_bytes: 500000, images_only: true });

  // 3. One attachment whole; then byte ranges joined back together. The pieces come from one
  //    in-memory copy: the binary is asked once, not once per piece.
  const png = Buffer.from(SHOT, "base64");
  const one = await outlookAttachments({ account: "adga", id: "MSG_SHOT", contentId: "<image001.png@01DD0000.00000000>" });
  assert.equal(one.attachment.name, "image001.png");
  assert.equal(one.data_base64, SHOT);
  assert.equal(await outlookAttachments({ account: "adga", id: "MSG_SHOT", index: 9 }).then((r) => r.status), "attachment_not_found");
  fake.reset();
  const pieces = [];
  let next = 0;
  let piece = 0;
  while (next !== null) {
    const r = await commandAdapters["outlook attachments"]({ account: "adga", id: "MSG_SHOT", attachment_id: piece ? "A0" : undefined, index: piece ? undefined : 0, offset: next, length: 1000 }, {});
    assert.equal(r.ok, true);
    assert.equal(r.total_bytes, png.length);
    pieces.push(Buffer.from(r.data_base64, "base64"));
    next = r.next_offset;
    piece += 1;
  }
  assert.ok(piece >= 3);
  assert.deepEqual(Buffer.concat(pieces), png);
  assert.equal(fake.calls().length, 1, "one binary call for every piece");
  assert.deepEqual(fake.calls()[0].body, { account: "adga", id: "MSG_SHOT", include_data: true, max_data_bytes: 1000000, index: 0 });

  // 4. Inspect: first image by default, by content id, by index; asks for OpenRouter and full text.
  const calls = [];
  const visionAnalyze = async (args) => {
    calls.push(args);
    return { ok: true, provider: "openrouter", model: "google/gemini-3.8-flash", description: "A reports page.", ocr_text: "Reports\nSeptember 2026", answer_text: "A reports page." };
  };
  const first = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", visionAnalyze });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.image.name, "image001.png");
  assert.equal(first.ocr_text, "Reports\nSeptember 2026");
  assert.equal(calls[0].provider, "openrouter");
  assert.match(calls[0].prompt, /transcribe ALL visible text/);
  assert.equal(calls[0].images[0].data_base64, SHOT);
  assert.equal(calls[0].images[0].media_type, "image/png");
  const byCid2 = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", contentId: "<image002.png@01DD0000.00000000>", prompt: "Read it", visionAnalyze });
  assert.equal(byCid2.image.index, 1);
  assert.equal(calls.at(-1).prompt, "Read it");
  assert.equal(calls.at(-1).images[0].data_base64, PNG_1X1);
  const before = calls.length;
  const notImage = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", index: 2, visionAnalyze });
  assert.equal(notImage.ok, false);
  assert.equal(notImage.status, "image_not_found");
  assert.equal(calls.length, before);
  const missing = await outlookAttachmentInspect({ account: "adga", id: "NOPE", visionAnalyze });
  assert.equal(missing.status, "message_not_found");

  // 5. Image too large: refused before any bytes are fetched.
  const big = await outlookAttachmentInspect({ account: "adga", id: "MSG_SHOT", visionAnalyze, deps: { execFile: (bin, args, opts, cb) => cb(null, JSON.stringify({ ok: true, account: "adga", attachments: [{ index: 0, attachment_id: "B", name: "huge.png", content_type: "image/png", size: 6_000_000, is_image: true }] }), "") } });
  assert.equal(big.status, "image_too_large");

  // 6. Vision provider selection: OpenRouter when asked and keyed; falls back when not.
  assert.equal(resolveVisionGatewayConfig({ OPENROUTER_API_KEY: "k" }).provider, "openrouter");
  assert.equal(resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g", OPENROUTER_API_KEY: "k" }).provider, "ai_gateway");
  const or = resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g", OPENROUTER_API_KEY: "k" }, { provider: "openrouter" });
  assert.equal(or.provider, "openrouter");
  assert.equal(or.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(or.configured, true);
  assert.equal(resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g" }, { provider: "openrouter" }).provider, "ai_gateway");
  assert.equal(resolveVisionGatewayConfig({ AI_GATEWAY_API_KEY: "g", OPENROUTER_API_KEY: "k", PHONECLAW_VISION_PROVIDER: "openrouter" }).provider, "openrouter");

  // 7. OpenRouter request: DeepSeek V4.1 Flash pinned to Baseten fast, reasoning off, no
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
  fake.cleanup();
}
