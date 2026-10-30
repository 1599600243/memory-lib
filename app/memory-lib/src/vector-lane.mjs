// memory-lib — read-only vector-lane health probe (F2).
//
// Why: hybrid retrieval's semantic lane needs (a) a reachable embedding service
// serving the configured model and (b) a usable local index. When either is gone
// the lane silently degrades to file-first/FTS — production reported
// `healthy` while Ollama was not running, so health was lying. Probing the lane
// makes that degradation explicit instead of silent.
//
// Read-only contract (probed on every health() call):
//   - Ollama is only asked for `GET /api/tags` (reachability + model presence):
//     no embedding request is issued, so no inference, no model load, no POST.
//   - The ledger/index is opened READ-ONLY and only counted. Nothing is written,
//     nothing is repaired, and a missing index is never created.
//   - Freshness is deliberately NOT derived by comparing `embeddings.content_hash`
//     against `files.sha256`: the first is a per-chunk content hash, the second is
//     a whole-file hash, so the values are not comparable at all. "Repairing" an
//     index from that comparison would be wrong, so this probe uses index
//     availability/status instead — `vector_status = 'active'`, the very
//     predicate the ledger vector lane itself uses.
//   - `status`/`reason` never contain filesystem paths (they are surfaced on the
//     weak-auth GET /v1/health); diagnostics live in `detail`, which only the
//     authorized admin payload returns.
//
// probeVectorLane() never throws: an unusable lane is a health fact, not an
// error, and health must stay diagnosable (never 5xx) while the lane is down.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { indexPathFor } from "./index-store.mjs";
import { ledgerPathFor } from "./ledger-search.mjs";

const DEFAULT_OLLAMA = { endpoint: "http://127.0.0.1:11434", model: "bge-m3" };
const DEFAULT_TIMEOUT_MS = 2000;

const REASON = {
  skipped: "vector-lane skipped: probing disabled by configuration",
  unreachable: "vector-lane down: ollama unreachable",
  tagsUnavailable: "vector-lane down: ollama tags unavailable",
  noFetch: "vector-lane down: fetch unavailable",
  probeFailed: "vector-lane down: probe failed",
};

// Injected probe configuration. `ollama` is the existing embedding config used by
// search(); `vectorLane` only tunes the probe itself:
//   enabled      (default true)  — false reports "skipped" instead of probing
//   requireIndex (default true)  — false for deployments that legitimately ship
//                                  without a ledger (read-only file-first only)
//   timeoutMs    (default 2000)  — hard ceiling on the single GET /api/tags
//   fetch        (default global fetch) — injectable for tests
export function vectorLaneConfig({ ollama, vectorLane } = {}) {
  const config = vectorLane && typeof vectorLane === "object" ? vectorLane : {};
  const ollamaConfig = ollama && typeof ollama === "object" ? ollama : {};
  return {
    enabled: config.enabled !== false,
    requireIndex: config.requireIndex !== false,
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
    fetchImpl: typeof config.fetch === "function" ? config.fetch : globalThis.fetch,
    endpoint: String(ollamaConfig.endpoint ?? DEFAULT_OLLAMA.endpoint).replace(/\/+$/u, ""),
    model: String(ollamaConfig.model ?? DEFAULT_OLLAMA.model),
    dimension: Number(ollamaConfig.dimension ?? 1024),
  };
}

export async function probeVectorLane(dataRoot, options = {}) {
  const config = vectorLaneConfig(options);
  const detail = { endpoint: config.endpoint, model: config.model, request: "GET /api/tags" };
  if (!config.enabled) return { status: "skipped", reason: REASON.skipped, detail };
  if (typeof config.fetchImpl !== "function") return { status: "down", reason: REASON.noFetch, detail };

  try {
    const tags = await listOllamaModels(config);
    if (tags.outcome === "unreachable") return { status: "down", reason: REASON.unreachable, detail };
    if (tags.outcome !== "ok") return { status: "down", reason: REASON.tagsUnavailable, detail };
    // 模型名带 tag（生产：nomic-embed-text:latest）时按基名匹配。
    if (!tags.models.some((name) => modelBase(name) === modelBase(config.model))) {
      return { status: "down", reason: `vector-lane down: embedding model missing (${config.model})`, detail };
    }
    if (!config.requireIndex) {
      return { status: "ok", reason: "vector-lane ok: ollama reachable, model present", detail: { ...detail, index: "not-required" } };
    }
    const index = readIndexStatus(dataRoot, config);
    if (!index.ok) return { status: "stale", reason: `vector-lane stale: ${index.reason}`, detail: { ...detail, ...index.detail } };
    return {
      status: "ok",
      reason: `vector-lane ok: ollama reachable, model present, ${index.active} active embeddings`,
      detail: { ...detail, ...index.detail },
    };
  } catch (error) {
    return { status: "down", reason: REASON.probeFailed, detail: { ...detail, error: String(error?.message ?? error) } };
  }
}

// 单次只读 GET /api/tags：端点为回环地址；超时后 abort，避免拖住 /v1/health。
async function listOllamaModels({ endpoint, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(`${endpoint}/api/tags`, { method: "GET", signal: controller.signal });
    } catch {
      return { outcome: "unreachable" };
    }
    if (res && res.ok === false) return { outcome: "error" };
    let data;
    try {
      data = await res.json();
    } catch {
      return { outcome: "error" };
    }
    if (!Array.isArray(data?.models)) return { outcome: "error" };
    return { outcome: "ok", models: data.models.map((model) => String(model?.name ?? "")) };
  } finally {
    clearTimeout(timer);
  }
}

function readIndexStatus(dataRoot, config) {
  const ownedIndexPath = indexPathFor(dataRoot);
  const legacyIndexPath = ledgerPathFor(dataRoot);
  const indexPath = existsSync(ownedIndexPath) ? ownedIndexPath : existsSync(legacyIndexPath) ? legacyIndexPath : null;
  const backend = existsSync(ownedIndexPath) ? "memory-lib-index" : "legacy-ledger-compat";
  if (!indexPath) {
    return { ok: false, reason: "ledger unavailable", detail: { index: "missing", backend } };
  }
  let db;
  try {
    db = new DatabaseSync(indexPath, { readOnly: true });
  } catch {
    return { ok: false, reason: "ledger unreadable", detail: { index: "unreadable", backend } };
  }
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'").get();
    if (!table) return { ok: false, reason: "ledger has no embeddings table", detail: { index: "missing-table" } };
    let active = 0;
    let stale = 0;
    const embeddingColumns = columnsFor(db, "embeddings");
    const modelFilter = embeddingColumns.includes("model") && embeddingColumns.includes("dimension") ? " AND model = ? AND dimension = ?" : "";
    const modelArgs = modelFilter ? [config.model, Number(config.dimension ?? 1024)] : [];
    for (const row of db.prepare(`SELECT vector_status AS status, COUNT(*) AS count FROM embeddings WHERE 1=1${modelFilter} GROUP BY vector_status`).all(...modelArgs)) {
      const count = Number(row.count) || 0;
      if (String(row.status ?? "").toLowerCase() === "active") active += count;
      else stale += count;
    }
    const columns = db.prepare("PRAGMA table_info(embeddings)").all().map((row) => String(row.name));
    const lastIndexed = columns.includes("indexed_at")
      ? db.prepare("SELECT MAX(indexed_at) AS last FROM embeddings WHERE vector_status='active'").get()
      : { last: null };
    const detail = { index: "ok", backend, model: config.model, dimension: Number(config.dimension ?? 1024), activeEmbeddings: active, staleEmbeddings: stale, lastIndexedAt: lastIndexed?.last ?? null };
    if (active < 1) return { ok: false, reason: "no active embeddings", detail };
    return { ok: true, active, stale, detail };
  } catch {
    return { ok: false, reason: "owned index unreadable", detail: { index: "unreadable", backend: "memory-lib-index" } };
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

function columnsFor(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function modelBase(name) {
  return String(name ?? "").trim().toLowerCase().split(":")[0];
}
