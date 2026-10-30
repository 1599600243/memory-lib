import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createLlmFailover } from "../src/llm.mjs";

const originalFetch = globalThis.fetch;

after(() => { globalThis.fetch = originalFetch; });

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function streamResponse(lines, status = 200) {
  const body = new ReadableStream({
    start(controller) {
      if (status >= 400) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(lines.join("\n")));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

test("ordered chat failover uses next provider after primary failure", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? jsonResponse({ error: "down" }, 503) : jsonResponse({ choices: [{ message: { content: "备用回答" } }] });
  };
  const fallback = createLlmFailover([
    { provider: "openai", base: "http://primary.test", model: "primary" },
    { provider: "openai", base: "http://backup.test", model: "backup" },
  ]);
  assert.equal(await fallback.chat([{ role: "user", content: "hi" }]), "备用回答");
  assert.deepEqual(calls, ["http://primary.test/chat/completions", "http://backup.test/chat/completions"]);
});

test("stream failover occurs only before the first emitted delta", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 503 })
      : streamResponse(['data: {"choices":[{"delta":{"content":"备用"}}]}', "data: [DONE]", ""]);
  };
  const fallback = createLlmFailover([
    { provider: "openai", base: "http://primary.test", model: "primary" },
    { provider: "openai", base: "http://backup.test", model: "backup" },
  ]);
  const chunks = [];
  for await (const chunk of fallback.chatStream([{ role: "user", content: "hi" }])) chunks.push(chunk);
  assert.deepEqual(chunks, ["备用"]);
  assert.equal(calls, 2);
});
