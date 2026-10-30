// INDEX-2 — exact, principal-filterable document-frequency postings for recall.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { parseFrontmatterTyped } from "./frontmatter-util.mjs";
import { memoryFactOf } from "./recall-fact.mjs";

const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;

function normalize(text) {
  return String(text ?? "").replace(DASH_RE, "-").toLowerCase();
}

function visibilityMetadata(frontmatter) {
  const out = {};
  for (const key of ["status", "container", "visibility", "project", "group_id", "user_id", "agent_id", "role_id"]) {
    if (frontmatter?.[key] !== undefined) out[key] = frontmatter[key];
  }
  return out;
}

function adjacentPairs(text) {
  const chars = [...String(text ?? "")];
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

function ftsLiteral(value) {
  return `"${String(value).replace(/"/gu, '""')}"`;
}

export function ensureRecallDfSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_df_docs (
      file_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      source_sha256 TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      hay TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      has_fact INTEGER NOT NULL,
      complete INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recall_df_bigrams (
      token TEXT NOT NULL,
      file_id TEXT NOT NULL,
      PRIMARY KEY(token,file_id)
    );
    CREATE INDEX IF NOT EXISTS idx_recall_df_bigrams_file ON recall_df_bigrams(file_id);
  `);
  const fts = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='recall_df_fts'").get();
  if (fts && !/tokenize\s*=\s*["']trigram["']/iu.test(String(fts.sql))) db.exec("DROP TABLE recall_df_fts");
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS recall_df_fts USING fts5(file_id UNINDEXED,hay, tokenize="trigram");');
}

export function recallDfDocumentCurrent(db, fileId, sourceSha256) {
  const row = db.prepare("SELECT source_sha256,complete FROM recall_df_docs WHERE file_id=?").get(fileId);
  return Boolean(row && row.source_sha256 === sourceSha256 && Number(row.complete) === 1);
}

export function upsertRecallDfDocument(db, { fileId, relativePath, sourceSha256, text, complete = true }) {
  if (!String(relativePath).startsWith("curated/shared/")) return;
  const { frontmatter, body } = parseFrontmatterTyped(text);
  const fact = memoryFactOf(body);
  const memoryId = String(frontmatter.id ?? path.posix.basename(relativePath, ".md"));
  const hay = fact ? normalize(`${fact}\n${memoryId}`) : "";
  const safeComplete = complete ? 1 : 0;
  db.prepare(`INSERT INTO recall_df_docs(file_id,path,source_sha256,memory_id,hay,metadata_json,has_fact,complete)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(file_id) DO UPDATE SET path=excluded.path,source_sha256=excluded.source_sha256,memory_id=excluded.memory_id,
      hay=excluded.hay,metadata_json=excluded.metadata_json,has_fact=excluded.has_fact,complete=excluded.complete`)
    .run(fileId, relativePath, sourceSha256, memoryId, safeComplete ? hay : "", JSON.stringify(visibilityMetadata(frontmatter)), fact ? 1 : 0, safeComplete);
  db.prepare("DELETE FROM recall_df_bigrams WHERE file_id=?").run(fileId);
  db.prepare("DELETE FROM recall_df_fts WHERE file_id=?").run(fileId);
  if (!safeComplete || !fact) return;
  const insertPair = db.prepare("INSERT OR IGNORE INTO recall_df_bigrams(token,file_id) VALUES(?,?)");
  for (const token of adjacentPairs(hay)) insertPair.run(token, fileId);
  db.prepare("INSERT INTO recall_df_fts(file_id,hay) VALUES(?,?)").run(fileId, hay);
}

export function deleteRecallDfDocument(db, fileId) {
  db.prepare("DELETE FROM recall_df_bigrams WHERE file_id=?").run(fileId);
  db.prepare("DELETE FROM recall_df_fts WHERE file_id=?").run(fileId);
  db.prepare("DELETE FROM recall_df_docs WHERE file_id=?").run(fileId);
}

export function readRecallDfStats({ dataRoot, tokens }) {
  let db;
  try {
    db = new DatabaseSync(path.join(dataRoot, "indexes", "sqlite", "memory-lib-index.sqlite"), { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => String(row.name)));
    if (!tables.has("recall_df_docs") || !tables.has("recall_df_bigrams") || !tables.has("recall_df_fts")) {
      return { ok: false, reason: "df-index-missing" };
    }
    const activePaths = db.prepare("SELECT id,path,sha256 FROM files WHERE status='active' AND path LIKE 'curated/shared/%'").all();
    const docs = db.prepare("SELECT file_id,path,source_sha256,memory_id,hay,metadata_json,has_fact,complete FROM recall_df_docs ORDER BY path").all();
    const byId = new Map(docs.map((row) => [String(row.file_id), row]));
    for (const file of activePaths) {
      const doc = byId.get(String(file.id));
      if (!doc || doc.path !== file.path || doc.source_sha256 !== file.sha256 || Number(doc.complete) !== 1) {
        return { ok: false, reason: "df-index-incomplete" };
      }
    }
    if (docs.some((doc) => Number(doc.complete) !== 1)) return { ok: false, reason: "df-index-incomplete" };

    const postings = new Map();
    const pairQuery = db.prepare("SELECT file_id FROM recall_df_bigrams WHERE token=?");
    const ftsQuery = db.prepare("SELECT file_id FROM recall_df_fts WHERE recall_df_fts MATCH ?");
    for (const tokenValue of tokens ?? []) {
      const token = normalize(tokenValue);
      let ids;
      if ([...token].length === 2) ids = pairQuery.all(token).map((row) => String(row.file_id));
      else ids = ftsQuery.all(ftsLiteral(token)).map((row) => String(row.file_id));
      // FTS trigram is a candidate accelerator; validate against the exact normalized hay.
      postings.set(tokenValue, new Set(ids.filter((fileId) => byId.get(fileId)?.hay.includes(token))));
    }
    return {
      ok: true,
      docs: docs.map((row) => ({
        fileId: String(row.file_id),
        path: String(row.path),
        memoryId: String(row.memory_id),
        hasFact: Number(row.has_fact) === 1,
        frontmatter: JSON.parse(String(row.metadata_json || "{}")),
      })),
      postings,
    };
  } catch (error) {
    return { ok: false, reason: `df-index-query-failed:${String(error?.message ?? error).slice(0, 120)}` };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}
