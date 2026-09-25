import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeImagesWithGateway,
  parseVisionJson,
  resolveVisionGatewayConfig,
  redactGatewaySecrets,
  DEFAULT_VISION_MODEL,
} from "../fastify-app/ai-gateway-vision.mjs";
import {
  himalayaEmailImageInspect,
  phoneclawImageInspect,
  inspectEmailImagesFromRawMessage,
} from "../fastify-app/cli-tools.mjs";
import { CLI_COMMAND_CATALOG } from "../shared/cli-command-catalog.mjs";
import { commandAdapters } from "../fastify-app/cli-adapters.mjs";
import { runUniversalCli, UNIVERSAL_CLI_VERSION } from "../fastify-app/universal-cli.mjs";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function buildRawEmailWithPng({ contentId = "logo@phoneclaw" } = {}) {
  return [
    "From: Sender <sender@example.com>",
    "To: Andrew <andrew@example.com>",
    "Subject: Screenshot",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="bound"',
    "",
    "--bound",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<html><body><p>Hello</p><img src="cid:${contentId}" alt="logo"></body></html>`,
    "--bound",
    'Content-Type: image/png; name="shot.png"',
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${contentId}>`,
    'Content-Disposition: inline; filename="shot.png"',
    "",
    PNG_1X1_BASE64,
    "--bound--",
    "",
  ].join("\r\n");
}

test("resolveVisionGatewayConfig requires AI_GATEWAY_API_KEY", () => {
  const missing = resolveVisionGatewayConfig({});
  assert.equal(missing.configured, false);
  assert.equal(missing.model, DEFAULT_VISION_MODEL);
  const present = resolveVisionGatewayConfig({
    AI_GATEWAY_API_KEY: "test-key",
    PHONECLAW_VISION_MODEL: "google/gemini-2.5-flash",
  });
  assert.equal(present.configured, true);
  assert.equal(present.model, "google/gemini-2.5-flash");
});

test("redactGatewaySecrets never echoes the API key", () => {
  const key = "vgck_secret_value_123";
  const redacted = redactGatewaySecrets(
    `Bearer ${key} AI_GATEWAY_API_KEY=${key}`,
    key
  );
  assert.equal(redacted.includes(key), false);
  assert.match(redacted, /\[redacted\]/);
});

test("parseVisionJson accepts fenced JSON and plain text fallback", () => {
  const parsed = parseVisionJson(
    '```json\n{"description":"A logo","ocr_text":"ACME","answer_text":"It shows ACME."}\n```'
  );
  assert.equal(parsed.description, "A logo");
  assert.equal(parsed.ocr_text, "ACME");
  assert.equal(parsed.answer_text, "It shows ACME.");
  const plain = parseVisionJson("Just a screenshot of a calendar.");
  assert.match(plain.answer_text, /calendar/i);
});

test("inspectEmailImagesFromRawMessage can include base64 for selected images", () => {
  const inspection = inspectEmailImagesFromRawMessage(buildRawEmailWithPng(), {
    includeData: true,
    maxImages: 1,
  });
  assert.equal(inspection.images.length, 1);
  assert.ok(inspection.images[0].data_base64.startsWith("iVBOR"));
  assert.equal(inspection.images[0].media_type, "image/png");
});

test("himalayaEmailImageInspect fails clearly when AI gateway is not configured", async () => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    const result = await himalayaEmailImageInspect({ id: "123" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "ai_gateway_not_configured");
    assert.match(result.answer_text, /AI gateway not configured/i);
  } finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous;
  }
});

test("himalayaEmailImageInspect happy path with mocked extraction and vision", async () => {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key-not-real";
  const inspection = inspectEmailImagesFromRawMessage(
    buildRawEmailWithPng({ contentId: "shot@cid" }),
    { includeData: true, maxImages: 3 }
  );

  let visionCalls = 0;
  const result = await himalayaEmailImageInspect({
    id: "42",
    folder: "INBOX",
    imageIndex: 0,
    prompt: "What does this screenshot say?",
    emailImagesFn: async () => ({
      ok: true,
      status: "ok",
      returned_count: inspection.images.length,
      has_more: false,
      images: inspection.images,
      answer_text: "extracted",
    }),
    visionAnalyze: async ({ prompt, images }) => {
      visionCalls += 1;
      assert.match(prompt, /screenshot/i);
      assert.equal(images.length, 1);
      assert.ok(images[0].data_base64);
      assert.equal(
        JSON.stringify({ prompt, images }).includes("test-gateway-key-not-real"),
        false
      );
      return {
        ok: true,
        status: "ok",
        model: "google/gemini-3.8-flash",
        description: "A tiny logo.",
        ocr_text: "ACME",
        answer_text: "It shows the word ACME.",
        usage: { prompt_tokens: 11, completion_tokens: 9 },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(visionCalls, 1);
  assert.equal(result.inspected_count, 1);
  assert.equal(result.ocr_text, "ACME");
  assert.match(result.answer_text, /ACME/);
  assert.equal(result.images[0].data_base64, "");
  assert.equal(JSON.stringify(result).includes(PNG_1X1_BASE64), false);
  assert.equal(JSON.stringify(result).includes("test-gateway-key-not-real"), false);
  delete process.env.AI_GATEWAY_API_KEY;
});

test("analyzeImagesWithGateway redacts secrets on HTTP errors and parses success", async () => {
  const gatewayError = await analyzeImagesWithGateway({
    prompt: "Describe",
    images: [{ media_type: "image/png", data_base64: PNG_1X1_BASE64 }],
    env: { AI_GATEWAY_API_KEY: "super-secret-gateway-key" },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized super-secret-gateway-key",
    }),
  });
  assert.equal(gatewayError.ok, false);
  assert.equal(gatewayError.message.includes("super-secret-gateway-key"), false);

  const gatewayOk = await analyzeImagesWithGateway({
    prompt: "Describe",
    images: [{ media_type: "image/png", data_base64: PNG_1X1_BASE64 }],
    env: { AI_GATEWAY_API_KEY: "super-secret-gateway-key" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "google/gemini-3.8-flash",
          choices: [
            {
              message: {
                content:
                  '{"description":"Pixel","ocr_text":"OK","answer_text":"A one-pixel image that says OK."}',
              },
            },
          ],
          usage: { total_tokens: 12 },
        }),
    }),
  });
  assert.equal(gatewayOk.ok, true);
  assert.equal(gatewayOk.ocr_text, "OK");
  assert.match(gatewayOk.answer_text, /OK/);
});

test("catalog and adapters expose himalaya email-image-inspect as a read", async () => {
  const entry = CLI_COMMAND_CATALOG.find(
    (item) => item.command === "himalaya email-image-inspect"
  );
  assert.ok(entry);
  assert.equal(entry.legacy_path, "/cli/himalaya/email-image-inspect");
  assert.equal(typeof commandAdapters["himalaya email-image-inspect"], "function");
  assert.equal(UNIVERSAL_CLI_VERSION, "2026-09-25.1");
  const help = await runUniversalCli({
    command: "phoneclaw",
    args: ["himalaya", "email-image-inspect", "--help"],
  });
  assert.equal(help.ok, true);
  assert.equal(help.data.command, "himalaya email-image-inspect");
});

test("phoneclawImageInspect requires exactly one of email id or url", async () => {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key-not-real";
  try {
    const neither = await phoneclawImageInspect({});
    assert.equal(neither.ok, false);
    assert.equal(neither.status, "invalid_arguments");

    const both = await phoneclawImageInspect({
      id: "42",
      url: "https://example.com/a.png",
    });
    assert.equal(both.ok, false);
    assert.equal(both.status, "invalid_arguments");
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

test("phoneclawImageInspect blocks private hosts and non-https urls", async () => {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key-not-real";
  try {
    const httpOnly = await phoneclawImageInspect({
      url: "http://example.com/a.png",
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      visionAnalyze: async () => {
        throw new Error("should not analyze");
      },
    });
    assert.equal(httpOnly.ok, false);
    assert.equal(httpOnly.status, "unsupported_url_protocol");

    const localhost = await phoneclawImageInspect({
      url: "https://localhost/secret.png",
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      visionAnalyze: async () => {
        throw new Error("should not analyze");
      },
    });
    assert.equal(localhost.ok, false);
    assert.equal(localhost.status, "blocked_private_url");

    const privateIp = await phoneclawImageInspect({
      url: "https://127.0.0.1/secret.png",
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      visionAnalyze: async () => {
        throw new Error("should not analyze");
      },
    });
    assert.equal(privateIp.ok, false);
    assert.equal(privateIp.status, "blocked_private_url");
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

test("phoneclawImageInspect public url happy path with mocked fetch and vision", async () => {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key-not-real";
  const png = Buffer.from(PNG_1X1_BASE64, "base64");
  let fetchCalls = 0;
  let visionCalls = 0;

  try {
    const result = await phoneclawImageInspect({
      url: "https://example.com/path/logo.png",
      prompt: "What does this logo say?",
      fetchImpl: async (url, options) => {
        fetchCalls += 1;
        assert.match(String(url), /^https:\/\/example\.com\/path\/logo\.png$/);
        assert.equal(options.method, "GET");
        assert.equal(options.redirect, "manual");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            get: (name) =>
              String(name).toLowerCase() === "content-type" ? "image/png" : null,
          },
          body: {
            getReader: () => {
              let done = false;
              return {
                read: async () => {
                  if (done) return { done: true, value: undefined };
                  done = true;
                  return { done: false, value: png };
                },
                cancel: async () => {},
              };
            },
          },
        };
      },
      visionAnalyze: async ({ prompt, images }) => {
        visionCalls += 1;
        assert.match(prompt, /logo/i);
        assert.equal(images.length, 1);
        assert.equal(images[0].media_type, "image/png");
        assert.ok(images[0].data_base64);
        assert.equal(
          JSON.stringify({ prompt, images }).includes("test-gateway-key-not-real"),
          false
        );
        return {
          ok: true,
          status: "ok",
          model: "google/gemini-3.8-flash",
          description: "A tiny logo.",
          ocr_text: "ACME",
          answer_text: "It shows the word ACME.",
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.command, "image inspect");
    assert.equal(result.source, "url");
    assert.equal(fetchCalls, 1);
    assert.equal(visionCalls, 1);
    assert.equal(result.ocr_text, "ACME");
    assert.match(result.answer_text, /ACME/);
    assert.equal(result.images[0].data_base64, "");
    assert.equal(JSON.stringify(result).includes(PNG_1X1_BASE64), false);
    assert.equal(JSON.stringify(result).includes("test-gateway-key-not-real"), false);
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

test("phoneclawImageInspect email path reuses shared vision implementation", async () => {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key-not-real";
  const inspection = inspectEmailImagesFromRawMessage(
    buildRawEmailWithPng({ contentId: "shared@cid" }),
    { includeData: true, maxImages: 2 }
  );
  try {
    const result = await phoneclawImageInspect({
      id: "99",
      folder: "INBOX",
      imageIndex: 0,
      emailImagesFn: async () => ({
        ok: true,
        status: "ok",
        returned_count: inspection.images.length,
        has_more: false,
        images: inspection.images,
        answer_text: "extracted",
      }),
      visionAnalyze: async () => ({
        ok: true,
        status: "ok",
        model: "google/gemini-3.8-flash",
        description: "Shared path logo.",
        ocr_text: "OK",
        answer_text: "Shared path says OK.",
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, "image inspect");
    assert.equal(result.source, "email");
    assert.match(result.answer_text, /OK/);
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

test("catalog and adapters expose image inspect as a read", async () => {
  const entry = CLI_COMMAND_CATALOG.find((item) => item.command === "image inspect");
  assert.ok(entry);
  assert.equal(entry.legacy_path, "/cli/image/inspect");
  assert.equal(typeof commandAdapters["image inspect"], "function");
  const help = await runUniversalCli({
    command: "phoneclaw",
    args: ["image", "inspect", "--help"],
  });
  assert.equal(help.ok, true);
  assert.equal(help.data.command, "image inspect");
});
