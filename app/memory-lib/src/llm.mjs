// memory-lib — selectable LLM client (pet brain).
// provider "ollama" (default, local) | "openai" (cloud, OpenAI-compatible).
export function createLlmClient({ provider = "ollama", base = "http://127.0.0.1:11434", model = "qwen3:latest", apiKey = "", apiBase = "" } = {}) {
  async function chat(messages, { temperature = 0.7, think = false, format = null } = {}) {
    const local = provider === "ollama";
    const url = local ? `${base}/api/chat` : `${apiBase || base}/chat/completions`;
    const headers = { "content-type": "application/json" };
    if (!local && apiKey) headers["authorization"] = "Bearer " + apiKey;
    const body = local ? { model, messages, stream: false, think, ...(format ? { format } : {}), options: { temperature } } : { model, messages, temperature, ...(format ? { response_format: format } : {}) };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${provider} chat failed: HTTP ${res.status}`);
    const data = await res.json();
    return local ? data.message?.content ?? "" : data.choices?.[0]?.message?.content ?? "";
  }
  async function* chatStream(messages, { temperature = 0.7, signal, think = false } = {}) {
    const local = provider === "ollama";
    const url = local ? `${base}/api/chat` : `${apiBase || base}/chat/completions`;
    const headers = { "content-type": "application/json" };
    if (!local && apiKey) headers["authorization"] = "Bearer " + apiKey;
    const body = local ? { model, messages, stream: true, think, options: { temperature } } : { model, messages, temperature, stream: true };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`${provider} stream failed: HTTP ${res.status}`);
    if (!res.body) throw new Error(`${provider} stream returned no body`);
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) {
          const raw = line.startsWith("data:") ? line.slice(5).trim() : line.trim(); if (!raw || raw === "[DONE]") continue;
          let item; try { item = JSON.parse(raw); } catch { continue; }
          const text = local ? item.message?.content : item.choices?.[0]?.delta?.content; if (typeof text === "string" && text) yield text;
        }
      }
    } finally { reader.releaseLock(); }
  }
  return { chat, chatStream, provider, model };
}

export function createLlmFailover(providers, { onFallback } = {}) {
  const clients = (Array.isArray(providers) ? providers : []).filter(Boolean).map((config) => createLlmClient(config));
  if (!clients.length) throw new Error("llm failover requires at least one provider");
  async function chat(messages, options) {
    let lastError;
    for (let i = 0; i < clients.length; i += 1) {
      try { return await clients[i].chat(messages, options); }
      catch (error) { lastError = error; if (i + 1 < clients.length && error?.name !== "AbortError") await onFallback?.({ from: clients[i], to: clients[i + 1], error }); }
    }
    throw lastError ?? new Error("all llm providers failed");
  }
  async function* chatStream(messages, options = {}) {
    for (let i = 0; i < clients.length; i += 1) {
      let emitted = false;
      try { for await (const delta of clients[i].chatStream(messages, options)) { emitted = true; yield delta; } return; }
      catch (error) { if (emitted || i + 1 >= clients.length || error?.name === "AbortError") throw error; await onFallback?.({ from: clients[i], to: clients[i + 1], error }); }
    }
  }
  return { chat, chatStream, provider: clients.map((client) => client.provider).join(","), model: clients.map((client) => client.model).join(",") };
}
