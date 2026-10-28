// memory-lib D5.2 — read-only search adapter for memory-lib-index.sqlite.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexPathFor } from "./index-store.mjs";
import { inferSourceType } from "./read-only-core.mjs";
import { inAuthRoots } from "./ledger-search.mjs";

function open(dataRoot) {
  try { return new DatabaseSync(indexPathFor(dataRoot), { readOnly: true }); } catch { return null; }
}
function safeMatchQuery(query) {
  return String(query ?? "").trim().split(/\s+/u).map((part) => part.replace(/["*:^(){}\[\]]/gu, "")).filter(Boolean).map((part) => `"${part.replace(/"/g, '""')}"`).join(" OR ");
}
function bodyExcerpt(text, limit = 400) {
  const source = String(text ?? "");
  const body = source.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").replace(/^\s+/u, "");
  return (body || source).slice(0, limit);
}

function rowToCandidate(row, dataRoot, authRoots, lane) {
  if (!row?.path || row.file_status !== "active") return null;
  if (String(row.path).split("/").some((part) => part.startsWith("_"))) return null;
  const absPath = path.resolve(dataRoot, ...String(row.path).split("/"));
  // Authorization is rechecked on resolved paths. The index is never an authority.
  if (!inAuthRoots(absPath, authRoots)) return null;
  return { path: absPath, line: 1, excerpt: bodyExcerpt(row.text, 400), sourceType: inferSourceType(absPath), lanes: [lane], chunkId: row.chunk_id };
}
function rrf(lists, limit) {
  const scores = new Map(); const entries = new Map();
  for (const list of lists) list.forEach((item, i) => {
    const old = entries.get(item.path);
    entries.set(item.path, old ? { ...old, lanes: [...new Set([...old.lanes, ...item.lanes])] } : item);
    scores.set(item.path, (scores.get(item.path) ?? 0) + 1 / (60 + i + 1));
  });
  return [...entries.values()].sort((a, b) => scores.get(b.path) - scores.get(a.path)).slice(0, limit);
}
function norm(v) { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); }

export async function memoryIndexSearch(dataRoot, query, limit, authRoots, ollama = {}, fetchImpl = globalThis.fetch) {
  const db = open(dataRoot);
  if (!db) return null;
  const endpoint = ollama.endpoint ?? "http://127.0.0.1:11434";
  const model = ollama.model ?? "bge-m3";
  const dimension = Number(ollama.dimension ?? 1024);
  const lists = [];
  try {
    const match = safeMatchQuery(query);
    if (match) {
      let rows = [];
      try {
        rows = db.prepare(`SELECT c.id AS chunk_id,c.text,f.path,f.status AS file_status FROM fts_chunks x JOIN chunks c ON c.id=x.chunk_id JOIN files f ON f.path=x.path WHERE fts_chunks MATCH ? AND f.status='active' LIMIT ?`).all(match, Math.max(limit * 8, 32));
      } catch {
        rows = [];
      }
      lists.push(rows.map((r) => rowToCandidate(r, dataRoot, authRoots, "fts")).filter(Boolean));
    }

    try {
      const response = await fetchImpl(`${endpoint}/api/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt: String(query ?? "") }) });
      if (response?.ok) {
        const embedding = (await response.json())?.embedding;
        if (Array.isArray(embedding) && embedding.length === dimension && embedding.every((v) => Number.isFinite(Number(v)))) {
          const q = embedding.map(Number); const qn = norm(q); const scored = [];
          for (const row of db.prepare(`SELECT e.chunk_id,e.vector_blob,c.text,f.path,f.status AS file_status FROM embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN files f ON f.id=c.file_id WHERE e.vector_status='active' AND f.status='active' AND e.model=? AND e.dimension=?`).all(model, dimension)) {
            const blob = row.vector_blob;
            if (!blob || blob.length < dimension * 4) continue;
            const vector = new Float32Array(blob.buffer, blob.byteOffset, dimension); const vn = norm(vector);
            if (!qn || !vn) continue;
            let dot = 0; for (let i = 0; i < dimension; i += 1) dot += q[i] * vector[i];
            scored.push({ row, score: dot / (qn * vn) });
          }
          scored.sort((a, b) => b.score - a.score);
          lists.push(scored.slice(0, Math.max(limit * 8, 32)).map(({ row, score }) => ({ ...rowToCandidate(row, dataRoot, authRoots, "vector"), score })).filter((r) => r?.path));
        }
      }
    } catch { /* embedding lane unavailable; FTS remains usable */ }

    return { results: rrf(lists, limit), laneResults: { fts: lists[0] ?? [], vector: lists[1] ?? [] }, lanes: { fts: lists[0]?.length ?? 0, vector: lists[1]?.length ?? 0 }, bestVectorSim: Math.max(0, ...((lists[1] ?? []).map((r) => Number(r.score) || 0))) };
  } finally { db.close(); }
}
