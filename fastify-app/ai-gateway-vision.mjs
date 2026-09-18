// Lean OpenAI-compatible vision client for Vercel AI Gateway.
// Keep secrets in env only; never log API keys.

export const DEFAULT_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const DEFAULT_VISION_MODEL = "google/gemini-3.8-flash";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_RESPONSE_CHARS = 8_000;

export function resolveVisionGatewayConfig(env = process.env) {
  const apiKey = String(env.AI_GATEWAY_API_KEY || "").trim();
  const baseUrl = String(env.AI_GATEWAY_BASE_URL || DEFAULT_AI_GATEWAY_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const model =
    String(env.PHONECLAW_VISION_MODEL || DEFAULT_VISION_MODEL).trim() ||
    DEFAULT_VISION_MODEL;
  return {
    apiKey,
    baseUrl,
    model,
    configured: Boolean(apiKey),
  };
}

export function redactGatewaySecrets(text, apiKey = "") {
  let value = String(text || "");
  if (apiKey) value = value.split(apiKey).join("[redacted]");
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/AI_GATEWAY_API_KEY[=:]\s*\S+/gi, "AI_GATEWAY_API_KEY=[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

export function buildVisionUserContent({ prompt, images }) {
  const parts = [
    {
      type: "text",
      text: String(prompt || "").slice(0, MAX_PROMPT_CHARS),
    },
  ];
  for (const image of images || []) {
    const mediaType = normalizeMediaType(
      image.media_type || image.mediaType || "image/png"
    );
    const data = String(image.data_base64 || image.dataBase64 || "").replace(
      /\s+/g,
      ""
    );
    if (!data) continue;
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${data}` },
    });
  }
  return parts;
}

export async function analyzeImagesWithGateway({
  prompt,
  images,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = resolveVisionGatewayConfig(env);
  if (!config.configured) {
    return {
      ok: false,
      status: "ai_gateway_not_configured",
      message:
        "AI gateway not configured. Set AI_GATEWAY_API_KEY on the bridge (for example in /etc/phoneclaw/bridge.env) and restart phoneclaw-bridge.",
      model: config.model,
      base_url: config.baseUrl,
    };
  }
  if (!Array.isArray(images) || images.length === 0) {
    return {
      ok: false,
      status: "no_images",
      message: "No image bytes were provided for vision analysis.",
      model: config.model,
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      status: "fetch_unavailable",
      message: "Fetch is unavailable in this runtime.",
      model: config.model,
    };
  }

  const body = {
    model: config.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You inspect images for a voice assistant. Reply with compact JSON only: " +
          '{"description":"short visual description","ocr_text":"all readable text or empty string","answer_text":"one spoken sentence for the caller"}. ' +
          "Prefer OCR accuracy. Do not invent text that is not visible.",
      },
      {
        role: "user",
        content: buildVisionUserContent({ prompt, images }),
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: "ai_gateway_error",
        message: redactGatewaySecrets(
          `AI gateway request failed with HTTP ${response.status}: ${rawText.slice(0, 500)}`,
          config.apiKey
        ),
        model: config.model,
        http_status: response.status,
      };
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        status: "ai_gateway_invalid_response",
        message: "AI gateway returned non-JSON.",
        model: config.model,
      };
    }

    const content = extractAssistantText(payload).slice(0, MAX_RESPONSE_CHARS);
    const parsed = parseVisionJson(content);
    return {
      ok: true,
      status: "ok",
      model: payload?.model || config.model,
      description: parsed.description,
      ocr_text: parsed.ocr_text,
      answer_text: parsed.answer_text,
      raw_content: content,
      usage: payload?.usage || null,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      ok: false,
      status: aborted ? "ai_gateway_timeout" : "ai_gateway_error",
      message: redactGatewaySecrets(
        aborted
          ? "AI gateway vision request timed out."
          : `AI gateway vision request failed: ${error?.message || error}`,
        config.apiKey
      ),
      model: config.model,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseVisionJson(content) {
  const fallbackAnswer = String(content || "").trim();
  const jsonText = extractJsonObject(fallbackAnswer);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const description = String(
        parsed.description || parsed.summary || ""
      ).trim();
      const ocrText = String(
        parsed.ocr_text || parsed.ocrText || parsed.text || ""
      ).trim();
      const answerText = String(
        parsed.answer_text ||
          parsed.answerText ||
          parsed.spoken ||
          description ||
          ocrText ||
          fallbackAnswer
      ).trim();
      return {
        description: description || answerText,
        ocr_text: ocrText,
        answer_text:
          answerText ||
          "I inspected the image but could not describe it clearly.",
      };
    } catch {
      // fall through
    }
  }
  return {
    description: fallbackAnswer.slice(0, 500),
    ocr_text: "",
    answer_text:
      fallbackAnswer ||
      "I inspected the image but could not describe it clearly.",
  };
}

function extractAssistantText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n")
      .trim();
  }
  return "";
}

function extractJsonObject(text) {
  const fenced = String(text || "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || text || "").trim();
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return "";
}

function normalizeMediaType(value) {
  const mediaType = String(value || "image/png").trim().toLowerCase();
  if (mediaType.startsWith("image/")) return mediaType.split(";")[0];
  return "image/png";
}
