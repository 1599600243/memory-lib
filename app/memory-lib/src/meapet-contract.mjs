// memory-lib - transport-neutral contract for desktop-pet clients.
// Desktop clients may carry this contract over OpenAI-compatible SSE today;
// another client can use a different transport without changing these fields.

const MOODS = new Set(["neutral", "happy", "sad", "angry", "surprised", "thinking"]);

export function normalizePetSessionId(value, fallback = "pet-session") {
  const id = String(value ?? fallback).trim();
  if (!id || id.length > 256 || /[\u0000\r\n]/.test(id)) throw new Error("invalid session id");
  return id;
}

export function normalizePetHistory(history, maxTurns = 8) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .map((item) => ({ role: item.role, content: String(item.content ?? "").slice(0, 8000) }))
    .filter((item) => item.content.trim())
    .slice(-Math.max(0, maxTurns));
}

export function normalizePetSegment({ text, mood = "neutral", motion = "", voiceText = "", voiceLanguage = "zh-CN", ttsStyle = "" } = {}) {
  const displayText = String(text ?? "").trim();
  if (!displayText) throw new Error("segment text is required");
  return {
    display_text: displayText,
    voice_text: String(voiceText || displayText).trim(),
    voice_language: String(voiceLanguage || "zh-CN").slice(0, 32),
    mood: MOODS.has(mood) ? mood : "neutral",
    motion: String(motion ?? "").slice(0, 120),
    tts_style: String(ttsStyle ?? "").slice(0, 120),
  };
}

export function makePetReply({ reply, mood = "neutral", motion = "", voiceText = "", voiceLanguage = "zh-CN", ttsStyle = "", contextHits = 0 } = {}) {
  const segment = normalizePetSegment({ text: reply, mood, motion, voiceText, voiceLanguage, ttsStyle });
  return {
    segments: [segment],
    context_hits: Number.isFinite(contextHits) ? Math.max(0, contextHits) : 0,
  };
}

export function makeSafePetError(code, message, retryable = false) {
  const safeCodes = new Set(["authentication", "permission", "rate_limit", "backend_unavailable", "connection", "timeout", "protocol", "cancelled", "internal_error"]);
  return {
    category: safeCodes.has(code) ? code : "internal_error",
    code: String(code || "INTERNAL_ERROR").toUpperCase().slice(0, 64),
    safe_message: String(message || "桌宠后端暂时无法生成回复。").replace(/[\u0000\r\n]+/g, " ").slice(0, 500),
    retryable: Boolean(retryable),
  };
}

export function toOpenAiAssistantMessage(reply) {
  const normalized = Array.isArray(reply?.segments) ? reply.segments : [];
  const text = normalized.map((segment) => segment.display_text).join("\n\n").trim();
  return {
    role: "assistant",
    content: text,
    pet: {
      segments: normalized,
    },
  };
}

