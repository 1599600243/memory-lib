import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMemoryLib } from "../src/memory-lib.mjs";

const TMP = path.join(process.env.TEMP ?? ".", "memory-lib-retrieval-p0");
const principal = { tenant_id: "default", framework_id: "framework", group_id: "group", user_id: "user", agent_id: "agent", role_id: "role" };

async function fixture() {
  const root = path.join(TMP, `case-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const docDir = path.join(root, "evidence", "documents");
  const sharedDir = path.join(root, "curated", "shared");
  await fs.mkdir(docDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(path.join(docDir, "slot-order.md"), "---\nid: kb-probe-memory-slot-order\ncontainer: knowledge\nvisibility: platform\nstatus: active\n---\n\n双通道内存条插槽装机说明。\n", "utf8");
  await fs.writeFile(path.join(sharedDir, "morning.md"), "---\nid: morning\ncontainer: long-term\nvisibility: shared\nstatus: active\n---\n\n当天要点与首条诉求。\n", "utf8");
  await fs.mkdir(path.join(root, "indexes", "sqlite"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "indexes", "sqlite", "memory-lib-index.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime REAL NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, token_estimate INTEGER NOT NULL, content_hash TEXT NOT NULL); CREATE TABLE embeddings (chunk_id TEXT PRIMARY KEY, backend TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, vector_blob BLOB, content_hash TEXT NOT NULL, vector_status TEXT NOT NULL, indexed_at TEXT, stale_reason TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED,path UNINDEXED,heading,text, tokenize='trigram');");
  for (const [rel, id, text] of [["evidence/documents/slot-order.md", "chunk-doc", "双通道内存条插槽装机说明。"], ["curated/shared/morning.md", "chunk-shared", "当天要点与首条诉求。"]]) {
    const abs = path.join(root, rel); const stat = await fs.stat(abs);
    db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?)").run(`file-${id}`, rel, "hash", stat.size, stat.mtimeMs, "active", new Date().toISOString());
    db.prepare("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)").run(id, `file-${id}`, 0, "", text, 0, text.length, 1, "hash");
    db.prepare("INSERT INTO fts_chunks VALUES (?,?,?,?)").run(id, rel, "", text);
  }
  db.close();
  return root;
}

test("RETRIEVAL-P0 query sensitivity, fresh document search, id lookup, and empty lanes", async () => {
  const root = await fixture();
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: [{ layer: "memory", visibility: "agent", project: "home-owner-agent" }, { layer: "memory", visibility: "user", project: "user-owner" }, { layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "platform" }], agentId: "home-circle", roleId: "home-owner-agent", principal: { ...principal, group_id: "home-circle", user_id: "user-owner", agent_id: "home-circle", role_id: "home-owner-agent" }, ollama: { endpoint: "http://127.0.0.1:1", model: "bge-m3", dimension: 1024 } });
  const daily = await lib.search({ query: "当天要点", limit: 10, graphExpand: false });
  const unique = await lib.search({ query: "双通道", limit: 10, documentQuota: 5, graphExpand: false });
  assert.notDeepEqual(daily.map((x) => x.path), unique.map((x) => x.path));
  assert.ok(unique.some((x) => x.path === path.join(root, "evidence", "documents", "slot-order.md")));
  const idHit = await lib.search({ query: "kb-probe-memory-slot-order", limit: 10, documentQuota: 5, graphExpand: false });
  assert.ok(idHit.some((x) => x.path === path.join(root, "evidence", "documents", "slot-order.md")));
  const noDocuments = await lib.search({ query: "双通道", limit: 10, documentQuota: 0, graphExpand: false });
  assert.ok(!noDocuments.some((x) => x.path === path.join(root, "evidence", "documents", "slot-order.md")));
  const empty = await lib.search({ query: "never-seen-retrieval-p0-token", limit: 10, documentQuota: 5, graphExpand: false });
  assert.deepEqual(empty, []);
});
