// memory-lib — read-only ledger hybrid search (FTS + vector via Ollama + RRF).
// Reads the plugin's derived ledger (indexes/sqlite/openclaw-memory-ledger.sqlite)
// READ-ONLY only. If the ledger is absent, returns null so the caller falls back
// to file-first search. Scope filtering happens BEFORE returning (authRoots).
// Vector lane: query embedding via Ollama, cosine similarity over vector_blob.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { inferSourceType } from "./read-only-core.mjs";

const LEDGER_REL = ["indexes", "sqlite", "openclaw-memory-ledger.sqlite"];
const DEFAULT_OLLAMA = { endpoint: "http://127.0.0.1:11434", model: "bge-m3", dimension: 1024 };
// nomic measured same-pair mean=0.7284, unrelated-pair mean=0.6510, and best
// threshold=0.7311; 0.695 filters most unrelated noise while retaining useful
// similarity. Values below this range leave unrelated noise as the majority of accepted vector hits.
const DEFAULT_VECTOR_THRESHOLDS = { "nomic-embed-text": 0.695, "bge-m3": 0.60 };

export function ledgerPathFor(dataRoot) {
  return path.join(dataRoot, ...LEDGER_REL);
}

export function openLedgerReadonly(dataRoot) {
  try {
    return new DatabaseSync(ledgerPathFor(dataRoot), { readOnly: true });
  } catch {
    return null;
  }
}

// Read the derived file registry for freshness-aware file-first fallback.
// A missing/unreadable ledger is represented as null so callers retain the
// existing bounded file-first behavior instead of treating every file as new.
function normalizeLedgerPath(filePath) {
  const normalized = path.normalize(String(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function ledgerFileState(dataRoot) {
  const db = openLedgerReadonly(dataRoot);
  if (!db) return null;
  try {
    const columns = db.prepare("PRAGMA table_info(files)").all().map((row) => row.name);
    if (!columns.includes("path")) return null;
    const hasSha = columns.includes("sha256");
    const hasStatus = columns.includes("status");
    const shaCol = hasSha ? "sha256" : "NULL AS sha256";
    const statusCol = hasStatus ? "status" : "NULL AS status";
    const rows = db.prepare(`SELECT path, ${shaCol}, ${statusCol} FROM files`).all();
    return new Map(rows.filter((row) => typeof row.path === "string").map((row) => [normalizeLedgerPath(row.path), {
      sha256: hasSha ? String(row.sha256 ?? "") : null,
      status: row.status == null ? null : String(row.status),
    }]));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function inAuthRoots(filePath, authRoots) {
  if (!Array.isArray(authRoots) || authRoots.length === 0) return true; // unrestricted
  return authRoots.some((root) => {
    const relative = path.relative(root, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function loadChunk(db, chunkId) {
  try {
    const row = db.prepare(
      "SELECT f.path, f.role, c.item_id AS itemId, c.text_excerpt FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ?"
    ).get(chunkId);
    if (!row) return null;
    return { path: row.path, itemId: row.itemId ?? null, sourceType: inferSourceType(row.path), excerpt: String(row.text_excerpt ?? "").slice(0, 400) };
  } catch {
    return null;
  }
}

// FTS lane: FTS5 MATCH primary, LIKE fallback (robust for CJK)
export function ftsSearch(db, query, limit, authRoots) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  let rows = [];
  try {
    const phrase = q.replace(/"/g, '""');
    rows = db.prepare("SELECT chunk_id, item_id, text_excerpt FROM fts_chunks WHERE fts_chunks MATCH ?").all(`"${phrase}"`);
  } catch {
    rows = [];
  }
  if (!rows.length) {
    try {
      rows = db.prepare("SELECT id AS chunk_id, item_id, text_excerpt FROM chunks WHERE text_excerpt LIKE ?").all(`%${q}%`);
    } catch {
      rows = [];
    }
  }
  const out = [];
  for (const row of rows) {
    const meta = loadChunk(db, row.chunk_id);
    if (!meta || !inAuthRoots(meta.path, authRoots)) continue;
    out.push({ chunkId: row.chunk_id, itemId: row.item_id, path: meta.path, excerpt: meta.excerpt, sourceType: meta.sourceType, lanes: ["fts"] });
    if (out.length >= limit) break;
  }
  return out;
}

// Vector lane: query embedding via Ollama + cosine over vector_blob (Float32 LE).
// Low-similarity hits are dropped below `vectorThreshold`: without a floor, ANY
// query (even a random string) returns top-N unrelated chunks, which (a) breaks
// "expect empty" semantics and (b) crowds out the file-first top-up that makes
// newly written memory searchable (P0). Cosine for nomic-embed-text: related
// bge-m3 calibration uses 0.60, below the measured best threshold 0.6020 so
// borderline relevant results are retained. The threshold is model-bound.
export async function vectorSearch(db, query, limit, authRoots, ollama = DEFAULT_OLLAMA, vectorThreshold = defaultVectorThreshold(ollama), fetchImpl = globalThis.fetch) {
  let embedding;
  try {
    const res = await fetchImpl(`${ollama.endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: ollama.model, prompt: String(query ?? "") }),
    });
    const data = await res.json();
    embedding = data?.embedding;
  } catch {
    return [];
  }
  if (!Array.isArray(embedding) || embedding.length !== ollama.dimension) return [];
  const qv = new Float32Array(embedding);
  const qn = norm(qv);
  if (qn === 0) return [];
  let rows = [];
  try {
    rows = db.prepare("SELECT chunk_id, vector_blob FROM embeddings WHERE vector_status = 'active' AND model = ? AND dimension = ?").all(ollama.model, ollama.dimension);
  } catch {
    return [];
  }
  const scored = [];
  for (const row of rows) {
    const blob = row.vector_blob;
    if (!blob || blob.length < ollama.dimension * 4) continue;
    const vec = new Float32Array(blob.buffer, blob.byteOffset, ollama.dimension);
    const sim = dot(qv, vec, qn);
    if (sim < vectorThreshold) continue;
    scored.push({ chunkId: row.chunk_id, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const out = [];
  for (const s of scored) {
    const meta = loadChunk(db, s.chunkId);
    if (!meta || !inAuthRoots(meta.path, authRoots)) continue;
    out.push({ chunkId: s.chunkId, itemId: meta.itemId ?? null, path: meta.path, excerpt: meta.excerpt, sourceType: meta.sourceType, score: Number(s.sim.toFixed(4)), lanes: ["vector"] });
    if (out.length >= limit) break;
  }
  return out;
}

// Hybrid: RRF merge of FTS + vector, dedupe by chunkId. Returns null if no ledger.
// `bestVectorSim` = raw max cosine from the vector lane (BEFORE RRF rewriting),
// so callers can apply a weak-relevance floor without confusing RRF scores with
// cosine similarity.
export async function hybridSearch(dataRoot, { query, limit = 10, authRoots = null, ollama = DEFAULT_OLLAMA, vectorThreshold = defaultVectorThreshold(ollama) } = {}) {
  const db = openLedgerReadonly(dataRoot);
  if (!db) return null;
  try {
    const cap = Math.max(limit * 2, 10);
    const [fts, vec] = await Promise.all([ftsSearch(db, query, cap, authRoots), vectorSearch(db, query, cap, authRoots, ollama, vectorThreshold)]);
    if (!fts.length && !vec.length) return { results: [], lanes: { fts: 0, vector: 0 }, bestVectorSim: 0, secondVectorSim: 0 };
    const vectorScores = vec.map((v) => Number(v.score) || 0).sort((a, b) => b - a);
    return {
      results: rrfMerge(fts, vec, limit),
      lanes: { fts: fts.length, vector: vec.length },
      bestVectorSim: vectorScores[0] ?? 0,
      secondVectorSim: vectorScores[1] ?? 0,
    };
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

function rrfMerge(fts, vec, limit) {
  const scores = new Map();
  const byChunk = new Map();
  const addList = (list, boost) => {
    list.forEach((item, idx) => {
      const key = item.chunkId;
      const rank = idx + 1;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + rank) + boost);
      byChunk.set(key, item);
    });
  };
  addList(fts, 0.001);
  addList(vec, 0.002);
  const merged = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key]) => {
    const item = byChunk.get(key);
    return { ...item, lanes: [...new Set([...(item.lanes ?? []), ...(fts.some((f) => f.chunkId === key) ? ["fts"] : []), ...(vec.some((v) => v.chunkId === key) ? ["vector"] : [])])], score: Number(scores.get(key).toFixed(4)) };
  });
  return merged;
}

export function defaultVectorThreshold(ollama) {
  return DEFAULT_VECTOR_THRESHOLDS[ollama?.model] ?? 0.60;
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function dot(a, b, an) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / (an * norm(b) || 1);
}
