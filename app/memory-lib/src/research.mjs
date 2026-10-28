// memory-lib — pet research skill (web correction / 联网纠偏).
// fetchUrl: fetch + strip HTML + limit length (verify a specific source).
// webSearch: pluggable http provider (endpoint + optional apiKey); returns [] when
//   provider is "none" (default) or the endpoint is unreachable — the pet degrades
//   gracefully to memory-only research. AutoSearch / ai-search-mcp / open-websearch
//   can be wired as the http provider later (see docs/protocol.md).

export async function fetchUrl(url, { maxBytes = 200_000, maxText = 6000, timeoutMs = 15000 } = {}) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "memory-lib-pet/0.1" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = await res.arrayBuffer();
    const bytes = Math.min(buf.byteLength, maxBytes);
    let text = new TextDecoder("utf-8").decode(buf.slice(0, bytes));
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { ok: true, text: text.slice(0, maxText), status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function webSearch(config, query, { maxResults = 8 } = {}) {
  if (!config || config.provider !== "http" || !config.endpoint) return [];
  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.slice(0, maxResults).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? r.summary ?? "" }));
  } catch {
    return [];
  }
}
