// memory-lib owned semantic index. It is rebuildable derived state and never
// touches the host/plugin ledger.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { inferSourceType, parseFrontmatter, readTextFile } from "./read-only-core.mjs";
import { unquote } from "./frontmatter-util.mjs";

export function semanticIndexPath(dataRoot) {
  return path.join(dataRoot, "indexes", "sqlite", "memory-semantic.sqlite");
}

function open(dataRoot) {
  const db = new DatabaseSync(semanticIndexPath(dataRoot));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, item_id TEXT, hash TEXT NOT NULL, body TEXT NOT NULL, embedding BLOB NOT NULL, updated_at TEXT NOT NULL)");
  return db;
}

function openReadonly(dataRoot) {
  return new DatabaseSync(semanticIndexPath(dataRoot), { readOnly: true });
}

function hash(text) { return crypto.createHash("sha256").update(text).digest("hex"); }
function cosine(a, b) { let dot = 0; let an = 0; let bn = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] * a[i]; bn += b[i] * b[i]; } return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1); }

async function embed(text, ollama) {
  const res = await fetch(`${ollama.endpoint}/api/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: ollama.model, prompt: text }) });
  const data = await res.json();
  if (!Array.isArray(data?.embedding) || data.embedding.length !== ollama.dimension) throw new Error("invalid embedding response");
  return new Float32Array(data.embedding);
}

export async function upsertSemanticFile(dataRoot, filePath, ollama) {
  const text = await readTextFile(filePath);
  if (!text) return { ok: false, skipped: true, reason: "missing" };
  const { frontmatter, body } = parseFrontmatter(text);
  if (String(frontmatter.status ?? "active").toLowerCase() === "deprecated") return removeSemanticFile(dataRoot, filePath);
  const digest = hash(text);
  await fs.mkdir(path.dirname(semanticIndexPath(dataRoot)), { recursive: true });
  let db = open(dataRoot);
  try {
    const existing = db.prepare("SELECT hash FROM documents WHERE path = ?").get(filePath);
    if (existing?.hash === digest) return { ok: true, skipped: true, reason: "unchanged" };
  } finally { db.close(); }
  const vector = await embed(body, ollama);
  db = open(dataRoot);
  try {
    const existing = db.prepare("SELECT hash FROM documents WHERE path = ?").get(filePath);
    if (existing?.hash === digest) return { ok: true, skipped: true, reason: "unchanged" };
    db.prepare("INSERT OR REPLACE INTO documents (path,item_id,hash,body,embedding,updated_at) VALUES (?,?,?,?,?,?)").run(filePath, unquote(frontmatter.id), digest, body, Buffer.from(vector.buffer), new Date().toISOString());
    return { ok: true, indexed: true, path: filePath };
  } finally { db.close(); }
}

export function removeSemanticFile(dataRoot, filePath) {
  if (!existsSync(semanticIndexPath(dataRoot))) return { ok: true, removed: false, skipped: true };
  let db;
  try { db = new DatabaseSync(semanticIndexPath(dataRoot)); } catch { return { ok: true, removed: false, skipped: true }; }
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get();
    if (!table) return { ok: true, removed: false, skipped: true };
    db.prepare("DELETE FROM documents WHERE path = ?").run(filePath);
    return { ok: true, removed: true, path: filePath };
  } finally { db.close(); }
}

export async function semanticSearch(dataRoot, query, limit, authRoots, ollama, threshold = 0.35) {
  if (!existsSync(semanticIndexPath(dataRoot))) return [];
  let vector;
  try { vector = await embed(query, ollama); } catch { return []; }
  let db;
  try { db = openReadonly(dataRoot); } catch { return []; }
  try {
    const rows = db.prepare("SELECT path,item_id,hash,body,embedding FROM documents").all();
    const out = [];
    for (const row of rows) {
      if (Array.isArray(authRoots) && authRoots.length && !authRoots.some((root) => { const rel = path.relative(root, row.path); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); })) continue;
      const current = await readTextFile(row.path).catch(() => null);
      if (!current) continue;
      const currentMeta = parseFrontmatter(current).frontmatter;
      if (String(currentMeta.status ?? "active").toLowerCase() === "deprecated") continue;
      if (hash(current) !== row.hash) continue;
      const raw = row.embedding;
      if (!raw || raw.length < vector.length * 4) continue;
      const score = cosine(vector, new Float32Array(raw.buffer, raw.byteOffset, vector.length));
      if (score < threshold) continue;
      out.push({ path: row.path, itemId: row.item_id || null, excerpt: String(row.body).slice(0, 400), sourceType: inferSourceType(row.path), score: Number(score.toFixed(4)), lanes: ["semantic"] });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  } finally { db.close(); }
}
