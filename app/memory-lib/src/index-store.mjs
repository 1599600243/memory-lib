// memory-lib D5.1 — owned SQLite index. Never opens or modifies the legacy ledger.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { walkFiles } from "./read-only-core.mjs";
import { chunkDocument } from "./chunker.mjs";
import {
  deleteRecallDfDocument,
  ensureRecallDfSchema,
  recallDfDocumentCurrent,
  upsertRecallDfDocument,
} from "./recall-df-index.mjs";
const CREDENTIAL_RE = /(?:sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/u;
function containsCredentialSensitiveText(text) { return CREDENTIAL_RE.test(String(text ?? "")); }
const LOCAL_PATH_RE = /[A-Za-z]:\\[^\r\n\s]+/gu;
function redactSensitiveText(text) { return String(text ?? "").replace(LOCAL_PATH_RE, "路径（已省略）").replace(CREDENTIAL_RE, "[REDACTED]"); }

// Searchable containers. Raw conversation evidence is indexed as a separate low-priority tier.
const REL_ROOTS = ["curated/shared", "curated/agents", "project-state", "tools-memory", "plans", "profile", "evidence/documents", "evidence/conversations"];
const INDEX_REL = path.join("indexes", "sqlite", "memory-lib-index.sqlite");
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function id(prefix, value) { return `${prefix}_${sha(value).slice(0, 24)}`; }
function posix(value) { return String(value).split(path.sep).join("/"); }

export function indexPathFor(dataRoot) { return path.join(dataRoot, INDEX_REL); }

function ensureSchema(db) {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,mtime REAL NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY,file_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,heading TEXT,text TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,token_estimate INTEGER NOT NULL,content_hash TEXT NOT NULL,UNIQUE(file_id,chunk_index));
    CREATE TABLE IF NOT EXISTS embeddings (chunk_id TEXT PRIMARY KEY,backend TEXT NOT NULL,model TEXT NOT NULL,dimension INTEGER NOT NULL,vector_blob BLOB,content_hash TEXT NOT NULL,vector_status TEXT NOT NULL,indexed_at TEXT,stale_reason TEXT);
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_status ON embeddings(vector_status);
    CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const fts = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_chunks'").get();
  const migrated = Boolean(fts && !/tokenize\s*=\s*["']trigram["']/iu.test(String(fts.sql)));
  if (migrated) db.exec("DROP TABLE fts_chunks");
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(chunk_id UNINDEXED,path UNINDEXED,heading,text, tokenize="trigram");');
  ensureRecallDfSchema(db);
  return migrated;
}
function parseVector(data, dimension) {
  const vector = data?.embedding;
  if (!Array.isArray(vector) || vector.length !== dimension || vector.some((v) => !Number.isFinite(Number(v)))) return null;
  return Buffer.from(new Float32Array(vector.map(Number)).buffer);
}
async function embed(text, { endpoint, model, dimension, fetchImpl }) {
  const res = await fetchImpl(`${endpoint}/api/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt: text }) });
  if (!res?.ok) throw new Error(`embedding HTTP ${res?.status ?? "error"}`);
  const vector = parseVector(await res.json(), dimension);
  if (!vector) throw new Error(`invalid embedding dimension (expected ${dimension})`);
  return vector;
}

export function createIndexStore({ dataRoot, ollama = {}, fetchImpl = globalThis.fetch, onError = null } = {}) {
  if (!dataRoot) throw new Error("index-store: dataRoot is required");
  const dbPath = indexPathFor(dataRoot);
  const embeddingConfig = { endpoint: ollama.endpoint ?? "http://127.0.0.1:11434", model: ollama.model ?? "bge-m3", dimension: Number(ollama.dimension ?? 1024) };

  async function scanFiles(paths = null) {
    if (Array.isArray(paths)) {
      const found = [];
      for (const candidate of paths) {
        const filePath = path.resolve(String(candidate));
        const rel = posix(path.relative(dataRoot, filePath));
        if (!rel || rel.startsWith("../") || !REL_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`))) continue;
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile() || path.extname(filePath).toLowerCase() !== ".md" || path.basename(filePath).toLowerCase() === "readme.md" || rel.split("/").some((part) => part.startsWith("_"))) continue;
        found.push({ path: filePath, rel });
      }
      return [...new Map(found.map((f) => [f.rel, f])).values()].sort((a, b) => a.rel.localeCompare(b.rel));
    }
    const found = [];
    for (const relRoot of REL_ROOTS) {
      const root = path.join(dataRoot, ...relRoot.split("/"));
      for (const filePath of await walkFiles(root, [".md"])) {
        const rel = posix(path.relative(dataRoot, filePath));
        if (path.basename(filePath).toLowerCase() === "readme.md" || rel.split("/").some((part) => part.startsWith("_"))) continue;
        found.push({ path: filePath, rel });
      }
    }
    return [...new Map(found.map((f) => [f.rel, f])).values()].sort((a, b) => a.rel.localeCompare(b.rel));
  }

  async function index({ rebuild = false, limit = Infinity, paths = null } = {}) {
    const started = Date.now();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      const ftsMigrated = ensureSchema(db);
      const previousConfig = db.prepare("SELECT value FROM index_meta WHERE key='embedding_config'").get();
      const configValue = JSON.stringify({ model: embeddingConfig.model, dimension: embeddingConfig.dimension });
      const embeddingMigrated = previousConfig?.value !== configValue;
      if (embeddingMigrated) {
        db.prepare("DELETE FROM embeddings").run();
        db.prepare("INSERT INTO index_meta(key,value) VALUES('embedding_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(configValue);
      }
      const previousRows = db.prepare("SELECT id,path,sha256,status FROM files").all();
      const previous = new Map(previousRows.map((r) => [r.path, r]));
      const scanned = await scanFiles(paths);
      const seen = paths == null ? new Set(scanned.map((f) => f.rel)) : null;
      const result = { scanned: scanned.length, changed: 0, chunks: 0, embedded: 0, skippedSensitive: 0, skippedSensitivePaths: [], failed: 0, ms: 0 };
      const now = new Date().toISOString();
      let processed = 0;

      for (const entry of scanned) {
        if (processed >= limit) break;
        processed += 1;
        let fileSkipped = false;
        try {
          const text = await fs.readFile(entry.path, "utf8");
          const digest = sha(text);
          const old = previous.get(entry.rel);
          if (!rebuild && !ftsMigrated && !embeddingMigrated && old?.sha256 === digest && old.status === "active") {
            if (!recallDfDocumentCurrent(db, old.id, digest)) {
              db.exec("BEGIN IMMEDIATE");
              try {
                upsertRecallDfDocument(db, {
                  fileId: old.id,
                  relativePath: entry.rel,
                  sourceSha256: digest,
                  text,
                  complete: !containsCredentialSensitiveText(text),
                });
                db.exec("COMMIT");
              } catch (error) { db.exec("ROLLBACK"); throw error; }
            }
            continue;
          }
          const stat = await fs.stat(entry.path);
          const fileId = id("file", entry.rel);
          const prepared = [];
          for (const chunk of chunkDocument(text)) {
            if (containsCredentialSensitiveText(chunk.text)) { result.skippedSensitive += 1; fileSkipped = true; continue; }
            const indexedText = redactSensitiveText(chunk.text);
            const contentHash = sha(indexedText);
            const chunkId = id("chunk", `${entry.rel}\0${chunk.chunk_index}\0${contentHash}`);
            let vector = null; let vectorError = null;
            try { vector = await embed(indexedText, { ...embeddingConfig, fetchImpl }); }
            catch (error) { vectorError = String(error?.message ?? error).slice(0, 240); result.failed += 1; onError?.({ path: entry.rel, chunk_id: chunkId, error }); }
            prepared.push({ ...chunk, text: indexedText, chunkId, contentHash, vector, vectorError });
          }

          db.exec("BEGIN IMMEDIATE");
          try {
            if (old) {
              const oldChunks = db.prepare("SELECT id FROM chunks WHERE file_id=?").all(old.id);
              for (const row of oldChunks) {
                db.prepare("DELETE FROM fts_chunks WHERE chunk_id=?").run(row.id);
                db.prepare("DELETE FROM embeddings WHERE chunk_id=?").run(row.id);
                db.prepare("DELETE FROM chunks WHERE id=?").run(row.id);
              }
            }
            db.prepare(`INSERT INTO files(id,path,sha256,size_bytes,mtime,status,updated_at) VALUES(?,?,?,?,?,'active',?)
              ON CONFLICT(path) DO UPDATE SET id=excluded.id,sha256=excluded.sha256,size_bytes=excluded.size_bytes,mtime=excluded.mtime,status='active',updated_at=excluded.updated_at`)
              .run(fileId, entry.rel, digest, stat.size, stat.mtimeMs, now);
            upsertRecallDfDocument(db, {
              fileId,
              relativePath: entry.rel,
              sourceSha256: digest,
              text,
              complete: !containsCredentialSensitiveText(text),
            });
            for (const c of prepared) {
              db.prepare("INSERT INTO chunks(id,file_id,chunk_index,heading,text,start_offset,end_offset,token_estimate,content_hash) VALUES(?,?,?,?,?,?,?,?,?)")
                .run(c.chunkId, fileId, c.chunk_index, c.heading, c.text, c.start_offset, c.end_offset, c.token_estimate, c.contentHash);
              db.prepare("INSERT INTO fts_chunks(chunk_id,path,heading,text) VALUES(?,?,?,?)").run(c.chunkId, entry.rel, c.heading ?? "", c.text);
              if (c.vector) {
                db.prepare("INSERT INTO embeddings(chunk_id,backend,model,dimension,vector_blob,content_hash,vector_status,indexed_at,stale_reason) VALUES(?,'ollama',?,?,?,?,'active',?,NULL)")
                  .run(c.chunkId, embeddingConfig.model, embeddingConfig.dimension, c.vector, c.contentHash, now);
                result.embedded += 1;
              } else {
                db.prepare("INSERT INTO embeddings(chunk_id,backend,model,dimension,vector_blob,content_hash,vector_status,indexed_at,stale_reason) VALUES(?,'ollama',?,?,NULL,?,'failed',?,?)")
                  .run(c.chunkId, embeddingConfig.model, embeddingConfig.dimension, c.contentHash, now, c.vectorError ?? "embedding unavailable");
              }
              result.chunks += 1;
            }
            db.exec("COMMIT");
            result.changed += 1;
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        } catch (error) { result.failed += 1; onError?.({ path: entry.rel, error }); }
        if (fileSkipped) result.skippedSensitivePaths.push(entry.rel);
      }

      const deleted = seen ? previousRows.filter((old) => !seen.has(old.path) && old.status !== "deleted") : [];
      if (deleted.length) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const old of deleted) {
            if (old.status !== "deleted") db.prepare("UPDATE files SET status='deleted',updated_at=? WHERE id=?").run(now, old.id);
            deleteRecallDfDocument(db, old.id);
            const oldChunks = db.prepare("SELECT id FROM chunks WHERE file_id=?").all(old.id);
            for (const row of oldChunks) {
              db.prepare("DELETE FROM fts_chunks WHERE chunk_id=?").run(row.id);
              db.prepare("DELETE FROM embeddings WHERE chunk_id=?").run(row.id);
              db.prepare("DELETE FROM chunks WHERE id=?").run(row.id);
            }
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      result.ms = Date.now() - started;
      return result;
    } finally { db.close(); }
  }

  function withDb(fn) {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); return fn(db); }
    catch { return null; }
    finally { try { db?.close(); } catch { /* noop */ } }
  }
  let lastIndexResult = null;
  async function stats() {
    const scanned = await scanFiles();
    const current = withDb((db) => {
      const files = db.prepare("SELECT path,sha256 FROM files WHERE status='active'").all();
      const emb = db.prepare("SELECT COUNT(*) AS n,MAX(indexed_at) AS last FROM embeddings WHERE vector_status='active'").get();
      const raw = db.prepare("SELECT COUNT(*) AS n FROM files WHERE status='active' AND path LIKE 'evidence/conversations/%'").get();
      const failed = db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE vector_status='failed'").get();
      return { indexedFiles: files.length, indexed: new Map(files.map((row) => [row.path, row.sha256])), activeEmbeddings: Number(emb?.n ?? 0), rawIndexedFiles: Number(raw?.n ?? 0), lastIndexedAt: emb?.last ?? null, failed: Number(failed?.n ?? 0) };
    }) ?? { indexedFiles: 0, indexed: new Map(), activeEmbeddings: 0, rawIndexedFiles: 0, lastIndexedAt: null, failed: 0 };
    let pendingChanges = 0;
    for (const entry of scanned) {
      const digest = sha(await fs.readFile(entry.path, "utf8"));
      if (current.indexed.get(entry.rel) !== digest) pendingChanges += 1;
    }
    pendingChanges += [...current.indexed.keys()].filter((filePath) => !scanned.some((entry) => entry.rel === filePath)).length;
    const { indexed, ...summary } = current;
    return { ...summary, libraryFiles: scanned.length, pendingChanges, skippedSensitive: lastIndexResult?.skippedSensitive ?? 0, skippedSensitivePaths: lastIndexResult?.skippedSensitivePaths ?? [], lastIndexMs: lastIndexResult?.ms ?? null, path: dbPath };
  }
  async function runIndex(options = {}) { lastIndexResult = await index(options); return lastIndexResult; }
  return { index: runIndex, stats, dbPath, dataRoot, embeddingConfig };
}
export async function indexMemoryRoot(options) { return createIndexStore(options).index(options); }
