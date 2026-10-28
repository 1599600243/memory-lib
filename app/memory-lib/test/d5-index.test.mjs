import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkDocument } from "../src/chunker.mjs";
import { createIndexStore, indexPathFor } from "../src/index-store.mjs";
import { memoryIndexSearch } from "../src/index-search.mjs";
import { defaultVectorThreshold } from "../src/ledger-search.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d5-index-"));
after(async () => fs.rm(TMP, { recursive: true, force: true }));

function fakeFetch() {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    const prompt = String(body.prompt ?? "");
    const vector = Array.from({ length: 768 }, (_, i) => (i === (prompt.includes("权限") ? 1 : 0) ? 1 : 0));
    return { ok: true, status: 200, json: async () => ({ embedding: vector }) };
  };
}

async function snapshot(root) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else { const s = await fs.stat(p); out.push([path.relative(root, p), s.size, s.mtimeMs]); }
    }
  }
  await walk(root);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

test("D5.1 chunker splits by headings, bounds chunks, and overlaps adjacent lines", () => {
  const body = [
    "---", "id: fixture", "layer: role", "---", "",
    "## 经验", ...Array.from({ length: 50 }, (_, i) => `第${i}行经验内容用于测试按标题切分和字符边界。`),
    "### 边界", ...Array.from({ length: 50 }, (_, i) => `第${i}行边界说明强调不能越权并保持上下文重叠。`),
  ].join("\n");
  const chunks = chunkDocument(body);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  assert.ok(chunks.some((c) => c.heading === "经验"));
  assert.ok(chunks.some((c) => c.heading === "边界"));
  assert.ok(chunks.every((c) => c.text.length <= 800));
  assert.ok(chunks.some((c, i) => i > 0 && chunks[i - 1].heading === c.heading && chunks[i - 1].text.split("\n").at(-1) === c.text.split("\n")[0]), "same-heading chunks should overlap one line");
});

test("index redacts local paths but skips credential chunks with visible reporting", async () => {
  const root = path.join(TMP, "redaction-memory");
  const dir = path.join(root, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "path.md"), "---\\nid: path-memory\\n---\\n\\nGLPI deployed at D:\\\\AI\\\\deepseek-harness\\\\GLPI with tenant isolation.", "utf8");
  await fs.writeFile(path.join(dir, "credential.md"), "---\\nid: credential-memory\\n---\\n\\napi_key=sk-1234567890abcdefghijklmnop", "utf8");
  const store = createIndexStore({ dataRoot: root, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fakeFetch() });
  const result = await store.index();
  assert.equal(result.skippedSensitive, 1);
  assert.deepEqual(result.skippedSensitivePaths, ["curated/shared/credential.md"]);
  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    const pathText = db.prepare("SELECT text FROM fts_chunks WHERE path=?").get("curated/shared/path.md")?.text ?? "";
    assert.match(pathText, /路径（已省略）/);
    assert.doesNotMatch(pathText, /D:\\\\AI\\\\deepseek-harness/);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fts_chunks WHERE path=?").get("curated/shared/path.md").n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fts_chunks WHERE path=?").get("curated/shared/credential.md").n), 0);
  } finally { db.close(); }
});

test("Chinese retrieval covers long sentences, no-space substrings, and semantic paraphrases", async () => {
  const root = path.join(TMP, "cjk-memory");
  const dir = path.join(root, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "patrol.md"), "---\nid: patrol\n---\n\n图书管理员定期巡库，把老旧无人借阅的书放到最下层，避免常用书架长期拥挤。", "utf8");
  const store = createIndexStore({ dataRoot: root, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fakeFetch() });
  await store.index();
  const lexicalGroups = [
    ["图书管理员定期巡库，把老旧无人借阅的书放到最下层", "老旧无人借阅的书放到最下层，避免常用书架长期拥挤", "图书管理员定期巡库，把老旧无人借阅的书放到最下层，避免常用书架长期拥挤"],
    ["定期巡库", "无人借阅", "最下层"],
  ];
  for (const queries of lexicalGroups) for (const query of queries) {
    const found = await memoryIndexSearch(root, query, 5, null, store.embeddingConfig, async () => ({ ok: false }));
    assert.ok(found.results.some((item) => item.path.endsWith("patrol.md")), `expected Chinese FTS hit for ${query}`);
    assert.ok(found.lanes.fts > 0);
  }
  const semanticFetch = async () => ({ ok: true, json: async () => ({ embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) }) });
  for (const query of ["把很久没人看的资料移出黄金位置", "腾出热门区域给经常使用的内容", "周期性整理低使用率藏书"]) {
    const found = await memoryIndexSearch(root, query, 5, null, store.embeddingConfig, semanticFetch);
    assert.ok(found.results.some((item) => item.path.endsWith("patrol.md") && item.lanes.includes("vector")), `expected semantic hit for ${query}`);
    assert.ok(found.lanes.vector > 0);
  }
});

test("model and dimension changes force a clean full re-embed", async () => {
  const root = path.join(TMP, "model-migration");
  const dir = path.join(root, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "one.md"), "---\nid: one\n---\n\n模型迁移必须重建所有向量。", "utf8");
  const vectors = (dimension) => async () => ({ ok: true, status: 200, json: async () => ({ embedding: Array.from({ length: dimension }, (_, i) => i === 0 ? 1 : 0) }) });
  const first = createIndexStore({ dataRoot: root, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: vectors(768) });
  await first.index();
  const second = createIndexStore({ dataRoot: root, ollama: { model: "bge-m3", dimension: 1024 }, fetchImpl: vectors(1024) });
  const migrated = await second.index();
  assert.equal(migrated.changed, 1);
  assert.equal(migrated.failed, 0);
  const db = new DatabaseSync(second.dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT model,dimension,vector_status,COUNT(*) AS n FROM embeddings GROUP BY model,dimension,vector_status").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "bge-m3");
    assert.equal(rows[0].dimension, 1024);
    assert.equal(rows[0].vector_status, "active");
    assert.equal(Number(rows[0].n), 1);
  } finally { db.close(); }
});

test("vector thresholds follow measured model mappings and safe fallback", () => {
  assert.equal(defaultVectorThreshold({ model: "nomic-embed-text" }), 0.695);
  assert.equal(defaultVectorThreshold({ model: "bge-m3" }), 0.60);
  assert.equal(defaultVectorThreshold({ model: "unknown-model" }), 0.60);
});

test("deleted files retain audit rows but remove orphan chunks and search rows", async () => {
  const root = path.join(TMP, "deleted-cleanup");
  const dir = path.join(root, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "vanished.md");
  await fs.writeFile(file, "---\nid: vanished\n---\n\nunique orphan cleanup marker", "utf8");
  const store = createIndexStore({ dataRoot: root, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fakeFetch() });
  await store.index();
  const dbBefore = new DatabaseSync(store.dbPath, { readOnly: true });
  const fileId = dbBefore.prepare("SELECT id FROM files WHERE path=?").get("curated/shared/vanished.md").id;
  const beforeChunks = Number(dbBefore.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_id=?").get(fileId).n);
  dbBefore.close();
  assert.ok(beforeChunks > 0);
  await fs.rm(file);
  const result = await store.index();
  assert.equal(result.failed, 0);
  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT status FROM files WHERE id=?").get(fileId).status, "deleted");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_id=?").get(fileId).n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fts_chunks WHERE path=?").get("curated/shared/vanished.md").n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.file_id=?").get(fileId).n), 0);
  } finally { db.close(); }
  const found = await memoryIndexSearch(root, "unique orphan cleanup marker", 5, null, store.embeddingConfig, async () => ({ ok: false }));
  assert.ok(!found.results.some((item) => item.path.endsWith("vanished.md")));

});

test("index creates only owned index, skips sensitive chunks, incremental second run changes zero", async () => {
  const workspace = path.join(TMP, "workspace");
  const dataRoot = path.join(workspace, "memory");
  const roleDir = path.join(dataRoot, "curated", "agents", "pilot-01");
  const toolDir = path.join(dataRoot, "tools-memory");
  const inboxDir = path.join(dataRoot, "inbox");
  const legacyDir = path.join(dataRoot, "curated", "_legacy-old");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.mkdir(toolDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(legacyDir, { recursive: true });
  const rolePath = path.join(roleDir, "role-one.md");
  const toolPath = path.join(toolDir, "dbx.md");
  const secretPath = path.join(toolDir, "secret.md");
  await fs.writeFile(rolePath, `---\nid: role-one\nlayer: role\nagent_id: pilot-01\n---\n\n## 经验\n\n遇到测试权限不足时先检查当前进程使用的身份和目录授权边界。\n`, "utf8");
  await fs.writeFile(toolPath, `---\nid: tool-dbx\nlayer: tool\ntool_name: DBX\n---\n\n## 用途\n\nDBX 是本地数据库桌面客户端，适用于检查 SQLite 记录和连接状态。\n`, "utf8");
  await fs.writeFile(secretPath, `---\nid: secret\nlayer: tool\n---\n\n## 凭证\n\napi_key=sk-1234567890abcdefghijklmnop should never be indexed.\n`, "utf8");
  await fs.writeFile(path.join(inboxDir, "candidate.md"), "inbox should never enter index", "utf8");
  await fs.writeFile(path.join(legacyDir, "old.md"), "legacy should never enter index", "utf8");

  const contentDirs = [path.join(dataRoot, "curated"), path.join(dataRoot, "tools-memory"), inboxDir];
  const before = [];
  for (const d of contentDirs) before.push(await snapshot(d));
  const store = createIndexStore({ dataRoot, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fakeFetch() });
  const first = await store.index();
  assert.ok(first.changed >= 3);
  assert.ok(first.embedded >= 1);
  assert.ok(first.skippedSensitive >= 1);
  assert.equal(first.failed, 0);
  assert.equal(store.dbPath, indexPathFor(dataRoot));
  const newPath = path.join(roleDir, "new-memory.md");
  await fs.writeFile(newPath, "---\nid: new-memory\n---\n\nunique incremental refresh marker", "utf8");
  before[0] = await snapshot(contentDirs[0]);
  const pending = await store.stats();
  assert.equal(pending.pendingChanges, 1);
  const refreshed = await store.index();
  assert.equal(refreshed.changed, 1);
  const second = await store.index();
  assert.equal(second.changed, 0, "same content must be incremental no-op");
  assert.equal(second.embedded, 0);

  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    const indexedPaths = db.prepare("SELECT path FROM files WHERE status='active' ORDER BY path").all().map((r) => r.path);
    assert.ok(indexedPaths.includes("curated/agents/pilot-01/role-one.md"));
    assert.ok(indexedPaths.includes("tools-memory/dbx.md"));
    assert.ok(!indexedPaths.some((p) => p.startsWith("inbox/")));
    assert.ok(!indexedPaths.some((p) => p.includes("_legacy")));
    const secretChunks = db.prepare("SELECT COUNT(*) AS n FROM fts_chunks WHERE path=? AND text LIKE '%sk-1234567890%' ").get("tools-memory/secret.md").n;
    assert.equal(Number(secretChunks), 0, "sensitive secret text must not be indexed");
    const secretVectors = db.prepare("SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN files f ON f.id=c.file_id WHERE f.path=? AND c.text LIKE '%sk-1234567890%' AND e.vector_status='active'").get("tools-memory/secret.md").n;
    assert.equal(Number(secretVectors), 0, "sensitive secret text must not have an embedding");
  } finally { db.close(); }
  for (let i = 0; i < contentDirs.length; i += 1) assert.deepEqual(await snapshot(contentDirs[i]), before[i], "indexing must not modify memory content files");

  const ledgerPath = path.join(dataRoot, "indexes", "sqlite", "openclaw-memory-ledger.sqlite");
  assert.ok(!(await fs.stat(ledgerPath).then(() => true, () => false)), "new indexer must not create/open-write legacy ledger");
});
