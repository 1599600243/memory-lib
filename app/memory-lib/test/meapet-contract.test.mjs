import assert from "node:assert/strict";
import test from "node:test";
import {
  makePetReply,
  makeSafePetError,
  normalizePetHistory,
  normalizePetSessionId,
  normalizePetSegment,
  toOpenAiAssistantMessage,
} from "../src/meapet-contract.mjs";

test("normalizes bounded session and history", () => {
  assert.equal(normalizePetSessionId("  android-1 "), "android-1");
  assert.deepEqual(normalizePetHistory([
    { role: "system", content: "drop" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]), [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
});

test("normalizes segments for desktop and mobile renderers", () => {
  assert.deepEqual(normalizePetSegment({ text: "你好", mood: "happy", motion: "wave" }), {
    display_text: "你好",
    voice_text: "你好",
    voice_language: "zh-CN",
    mood: "happy",
    motion: "wave",
    tts_style: "",
  });
  assert.equal(normalizePetSegment({ text: "x", mood: "unknown" }).mood, "neutral");
});

test("maps the common reply contract to OpenAI-compatible assistant content", () => {
  const reply = makePetReply({ reply: "答复", mood: "thinking", contextHits: 2 });
  assert.equal(toOpenAiAssistantMessage(reply).content, "答复");
  assert.equal(reply.segments[0].mood, "thinking");
  assert.equal(reply.context_hits, 2);
});

test("errors are safe and bounded", () => {
  const error = makeSafePetError("permission", "拒绝\n不要泄漏内部路径", false);
  assert.deepEqual(error, {
    category: "permission",
    code: "PERMISSION",
    safe_message: "拒绝 不要泄漏内部路径",
    retryable: false,
  });
});

