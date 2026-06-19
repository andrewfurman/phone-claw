const PHONE_VALUE_KEYS = new Set([
  "Called",
  "Caller",
  "From",
  "To",
  "called",
  "caller",
  "from",
  "to",
  "forwardedFrom",
  "ForwardedFrom",
]);

export function attachStreamStatusCallback(twiml, statusCallbackUrl) {
  if (!twiml || !statusCallbackUrl) return twiml;

  return String(twiml).replace(/<Stream\b([^>]*)>/i, (match, attrs) => {
    if (/\sstatusCallback\s*=/.test(attrs)) return match;

    let normalizedAttrs = attrs;
    let selfClosingSuffix = "";
    if (normalizedAttrs.trimEnd().endsWith("/")) {
      normalizedAttrs = normalizedAttrs.replace(/\/\s*$/, "");
      selfClosingSuffix = " /";
    }

    const methodAttr = /\sstatusCallbackMethod\s*=/.test(attrs)
      ? ""
      : ' statusCallbackMethod="POST"';
    return `<Stream${normalizedAttrs} statusCallback="${escapeXmlAttribute(
      statusCallbackUrl
    )}"${methodAttr}${selfClosingSuffix}>`;
  });
}

export function buildTwilioEvent({ source, payload, receivedAt = new Date().toISOString() }) {
  const eventType =
    payload.StreamEvent ||
    payload.CallStatus ||
    payload.CallbackSource ||
    payload.StatusCallbackEvent ||
    "twilio_callback";
  const callSid = payload.CallSid || payload.call_sid || "";
  const streamSid = payload.StreamSid || payload.stream_sid || "";

  return {
    id: randomId(),
    received_at: receivedAt,
    source,
    event_type: eventType,
    call_sid: callSid,
    stream_sid: streamSid,
    stream_name: payload.StreamName || "",
    stream_event: payload.StreamEvent || "",
    stream_error: payload.StreamError || "",
    call_status: payload.CallStatus || "",
    call_duration: payload.CallDuration || payload.Duration || "",
    callback_source: payload.CallbackSource || "",
    sequence_number: payload.SequenceNumber || "",
    from_last4: lastFourDigits(payload.From || payload.Caller || payload.from),
    to_last4: lastFourDigits(payload.To || payload.Called || payload.to),
    payload: sanitizeTwilioPayload(payload),
  };
}

export function summarizeTwilioEvent(event) {
  return {
    id: event.id,
    received_at: event.received_at,
    source: event.source,
    event_type: event.event_type,
    call_sid: event.call_sid,
    stream_sid: event.stream_sid,
    stream_event: event.stream_event,
    stream_error: event.stream_error,
    call_status: event.call_status,
    call_duration: event.call_duration,
    from_last4: event.from_last4,
    to_last4: event.to_last4,
  };
}

export function sanitizeTwilioPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload || {}).map(([key, value]) => [key, sanitizeTwilioValue(key, value)])
  );
}

function sanitizeTwilioValue(key, value) {
  if (value == null) return value;

  if (/token|secret|signature|auth/i.test(key)) {
    return "[redacted]";
  }

  if (PHONE_VALUE_KEYS.has(key)) {
    return redactedPhone(value);
  }

  if (typeof value !== "string") return value;

  return value
    .replace(/\+1\d{10}\b/g, (match) => redactedPhone(match))
    .replace(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, (match) => redactedPhone(match));
}

function redactedPhone(value) {
  const last4 = lastFourDigits(value);
  return last4 ? `[redacted-phone-last4:${last4}]` : "[redacted-phone]";
}

function lastFourDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(-4);
}

function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}
