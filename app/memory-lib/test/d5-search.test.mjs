import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createIndexStore } from "../src/index-store.mjs";
import { createConversationMemory } from "../src/conversation-memory.mjs";
import { createMemoryLib, resolveRootsForScopes } from "../src/memory-lib.mjs";
import { timestampValue } from "../src/time-util.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d5-search-"));
const dataRoot = path.join(TMP, "memory");
const workspaceRoot = TMP;
after(async () => fs.rm(TMP, { recursive: true, force: true }));

test("raw conversation roots are available only through authorized scopes", () => {
  const roots = resolveRootsForScopes([{ layer: "memory", visibility: "shared" }], dataRoot, workspaceRoot).map((root) => String(root));
  assert.ok(roots.some((root) => root.includes(`${path.sep}evidence${path.sep}conversations`)));
  const owned = resolveRootsForScopes([{ layer: "memory", visibility: "agent", project: "role-capture" }], dataRoot, workspaceRoot).map((root) => String(root));
  assert.ok(owned.some((root) => root.includes(`${path.sep}evidence${path.sep}conversations`)));
});

test("quoted and unquoted frontmatter timestamps have identical parsed values", () => {
  const quoted = timestampValue({ updated_at: '"2026-09-30T11:28:00.496Z"' });
  const plain = timestampValue({ updated_at: "2026-09-30T11:28:00.496Z" });
  assert.equal(quoted.value, plain.value);
});

function fetchImpl() {
  return async (_url, request) => {
    const prompt = JSON.parse(request.body).prompt;
    const vector = Array.from({ length: 768 }, (_, i) => i === (String(prompt).includes("权限") ? 1 : 0) ? 1 : 0);
    return { ok: true, json: async () => ({ embedding: vector }) };
  };
}

test("quoted recent timestamps contribute recency and outrank older equivalent matches", async () => {
  const root = path.join(TMP, "recency-memory");
  const shared = path.join(root, "curated", "shared");
  await fs.mkdir(shared, { recursive: true });
  const recent = path.join(shared, "recent.md");
  const old = path.join(shared, "old.md");
  await fs.writeFile(recent, `---\nid: recent\nupdated_at: "${new Date().toISOString()}"\nstatus: active\n---\n\n巡库下沉规则用于管理无人借阅的旧书。`, "utf8");
  await fs.writeFile(old, "---\nid: old\nupdated_at: 2020-01-01T00:00:00.000Z\nstatus: active\n---\n\n巡库下沉规则曾用于整理普通历史记录。", "utf8");
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: null, vectorLane: { enabled: false } });
  const hits = await lib.search({ query: "巡库下沉规则", limit: 5, mode: "file", graphExpand: false });
  assert.equal(hits[0]?.path, recent);
  assert.ok(hits[0]?.scoreParts?.recency > 0);
  assert.ok(hits[0]?.score > hits.find((item) => item.path === old)?.score);
});

test("D5.2 new owned index is searchable and restricted agent root cannot see other agents", async () => {
  const own = path.join(dataRoot, "curated", "agents", "pilot-01");
  const other = path.join(dataRoot, "curated", "agents", "other-agent");
  await fs.mkdir(own, { recursive: true }); await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(own, "role.md"), `---\nid: role-pilot\nlayer: role\nagent_id: pilot-01\n---\n\n## 经验\n\n这个角色以前踩过测试权限不足的坑，先检查授权身份和路径边界。\n`, "utf8");
  await fs.writeFile(path.join(other, "role.md"), `---\nid: role-other\nlayer: role\nagent_id: other-agent\n---\n\n## 经验\n\n其他角色的权限经验不能被 pilot-01 读取。\n`, "utf8");
  const store = createIndexStore({ dataRoot, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fetchImpl() });
  const built = await store.index();
  assert.ok(built.changed >= 2);
  const self = createMemoryLib({ dataRoot, workspaceRoot, scopes: [{ layer: "memory", visibility: "shared" }], agentId: "pilot-01", ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 }, embeddingFetch: fetchImpl() });
  const hits = await self.search({ query: "这个角色以前踩过什么坑", limit: 5, mode: "hybrid", graphExpand: false });
  assert.ok(hits.some((h) => h.path.includes("curated" + path.sep + "agents" + path.sep + "pilot-01")), "owned index candidate should reach self role memory");
  assert.ok(!hits.some((h) => h.path.includes("other-agent")), "authorized roots must reject other agent");
});

test("D5.2 index candidates outside authorization roots are discarded", async () => {
  const own = path.join(dataRoot, "curated", "agents", "pilot-01");
  const other = path.join(dataRoot, "curated", "agents", "other-agent");
  const restricted = createMemoryLib({ dataRoot, workspaceRoot, scopes: [{ layer: "memory", visibility: "shared" }], agentId: "unknown-agent", ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 }, embeddingFetch: fetchImpl() });
  const hits = await restricted.search({ query: "其他角色的权限经验不能被 pilot-01 读取", limit: 10, mode: "hybrid", graphExpand: false });
  assert.ok(hits.every((h) => !h.path.startsWith(own)), "own role must be denied outside the caller root");
  assert.ok(hits.every((h) => !h.path.startsWith(other)), "other role must be discarded by authorization filtering");
});

test("D17.4 default retrieval keeps durable quota, then documents, while raw conversations require evidence lane", async () => {
  const root = path.join(TMP, "d17-document-layers");
  const durable = path.join(root, "curated", "shared");
  const episode = path.join(root, "episodes", "2026-09-25");
  const evidence = path.join(root, "evidence", "conversations");
  const documents = path.join(root, "evidence", "documents", "acceptance-smoke");
  const captures = path.join(root, "project-state", "demo", "captures");
  await Promise.all([durable, episode, evidence, documents, captures].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(durable, "current.md"), "---\nid: durable-current\nstatus: active\n---\n\n记忆核心长期状态与治理结论，包含霁青资料检索词；当前负责人需要每周复核索引健康。\n", "utf8");
  await fs.writeFile(path.join(durable, "policy.md"), "---\nid: durable-policy\nstatus: active\n---\n\n霁青资料检索词对应长期治理规则；发布前必须完成第二审核人的批准记录。\n", "utf8");
  await fs.writeFile(path.join(episode, "session.md"), "---\nid: episode-session\nstatus: active\n---\n\n记忆核心会话经历。\n", "utf8");
  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(evidence, `conversation-${i}.md`), `---\nid: evidence-${i}\nstatus: active\n---\n\n记忆核心霁青资料检索词原始证据 ${i}。\n`, "utf8");
  const documentDetails = ["港口航线审计", "青铜器编目", "冬季仓储盘点", "南区服务迁移", "季度预算核验"];
  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(documents, `document-${i}.md`), `---\nid: document-${i}\nstatus: active\nsource: acceptance-smoke\noriginal_path: sample-${i}.txt\ncontent_hash: hash-${i}\n---\n\n霁青资料检索词。资料主题：${documentDetails[i]}；独立核验编号：${i}。\n`, "utf8");
  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(captures, `capture-${i}.md`), `---\nid: capture-${i}\nstatus: active\n---\n\n记忆核心原始采集 ${i}。\n`, "utf8");
  const projectState = path.join(root, "project-state", "memory-lib", "current-state.md");
  const projectReadme = path.join(root, "project-state", "README.md");
  const dbxNote = path.join(root, "tools-memory", "dbx.md");
  const promotedExtract = path.join(root, "project-state", "demo", "promoted-conversation-extract.md");
  await Promise.all([path.dirname(projectState), path.dirname(projectReadme), path.dirname(dbxNote)].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(projectState, "---\nid: memory-lib-current\nlayer: project\nkind: current-state\nstatus: active\n---\n\nCanonical status record for the memory library project. Goal: stable memory search. Current progress: indexing and retrieval. Next step: validate ranking. Blockers: none. 记忆核心长期状态。\n", "utf8");
  await fs.writeFile(projectReadme, "---\nid: memory-lib-readme\nstatus: active\n---\n\nProject documentation. DBX is mentioned once as an unrelated tool used during development.\n", "utf8");
  await fs.writeFile(dbxNote, "---\nid: dbx-tool\ntool_name: DBX\nstatus: active\n---\n\nDBX is the database client. Configure a connection and use it to inspect SQL tables.\n", "utf8");
  await fs.writeFile(promotedExtract, "---\nid: promoted-extract\nstatus: promoted\nsource: conversation-auto:dsh-session\nmemoryType: conversation-extract\n---\n\n排序规则要求记忆核心保持首位。\n", "utf8");
  await fs.writeFile(path.join(durable, "current.md"), "---\nid: durable-current\nstatus: active\n---\n\n记忆核心长期状态与治理结论。\n", "utf8");
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: null, ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 } });
  const hits = await lib.search({ query: "霁青资料检索词", limit: 10, searchMode: "hybrid", rawQuota: 3, mode: "hybrid", graphExpand: false });
  assert.equal(hits[0]?.sourceType, "curated", "durable results rank before documents");
  const documentHits = hits.filter((hit) => hit.sourceType === "document");
  const rawHits = hits.filter((hit) => hit.sourceType === "conversation-evidence");
  assert.ok(hits.length <= 10, "hybrid respects the requested top result limit");
  assert.ok(rawHits.length <= 3, "hybrid evidence is capped at three results");
  assert.ok(rawHits.every((hit) => hit.quotaLayer === "raw"));
  assert.ok(documentHits.every((hit) => hit.quotaLayer === "document"));
  assert.ok(hits.filter((hit) => hit.quotaLayer === "long-term").every((hit) => !["document", "conversation-evidence"].includes(hit.sourceType)));
  const formalHits = await lib.search({ query: "霁青资料检索词", limit: 2, searchMode: "formal", rawQuota: 5, mode: "hybrid", graphExpand: false });
  assert.ok(!formalHits.some((hit) => ["conversation-evidence", "document"].includes(hit.sourceType)), "formal mode excludes raw conversations and documents");
  const rawModeHits = await lib.search({ query: "霁青资料检索词", limit: 2, searchMode: "raw", rawQuota: 2, mode: "hybrid", graphExpand: false });
  assert.ok(rawModeHits.length <= 2 && rawModeHits.every((hit) => hit.sourceType === "conversation-evidence"), "raw mode is independently quota-limited");
  const noDocuments = await lib.search({ query: "霁青资料检索词", limit: 2, documentQuota: 0, rawQuota: 1, searchMode: "formal", mode: "hybrid", graphExpand: false });
  assert.ok(noDocuments.length <= 2);
  assert.ok(!noDocuments.some((hit) => hit.sourceType === "document"));
  assert.ok(documentHits.every((hit) => hit.path.includes(`${path.sep}evidence${path.sep}documents${path.sep}`)));
  assert.ok(hits.some((hit) => hit.path.includes(`${path.sep}evidence${path.sep}conversations${path.sep}`)), "raw conversations are present in default hybrid retrieval");
  const stateHits = await lib.search({ query: "记忆核心", limit: 10, mode: "hybrid", graphExpand: false });
  assert.ok(stateHits.slice(0, 3).some((hit) => hit.path === projectState));
  const evidenceHits = await lib.search({ query: "霁青资料检索词", limit: 10, searchMode: "raw", mode: "hybrid", graphExpand: false });
  assert.ok(evidenceHits.some((hit) => hit.path.includes(`${path.sep}evidence${path.sep}conversations${path.sep}`)), "raw mode returns conversation evidence");
  assert.ok(!evidenceHits.some((hit) => hit.sourceType !== "conversation-evidence"), `raw mode excludes formal memory and imported documents: ${JSON.stringify(evidenceHits.map((hit) => ({ path: hit.path, sourceType: hit.sourceType, quotaLayer: hit.quotaLayer })))}`);
  for (const query of ["记忆库当前状态", "memory-lib 现在做到哪了", "项目 当前进展 下一步 阻塞", "记忆系统 索引 进展"]) {
    const genericHits = await lib.search({ query, limit: 10, mode: "hybrid", graphExpand: false });
    assert.ok(genericHits.slice(0, 3).some((hit) => hit.path === projectState), `canonical state should rank in top 3 for ${query}`);
  }
  const dbxHits = await lib.search({ query: "DBX", limit: 10, mode: "hybrid", graphExpand: false });
  assert.equal(dbxHits[0]?.path, dbxNote, "dedicated tool memory must outrank incidental mentions in project status files");
  const defaultAgain = await lib.search({ query: "记忆核心", limit: 10, searchMode: "hybrid", mode: "hybrid", graphExpand: false });
  assert.ok(defaultAgain.some((hit) => hit.path.includes(`${path.sep}evidence${path.sep}conversations${path.sep}`)), `hybrid retrieval includes raw conversations after durable results: ${JSON.stringify(defaultAgain.map((hit) => ({ path: hit.path, sourceType: hit.sourceType, quotaLayer: hit.quotaLayer })))}`);
  const firstDocument = defaultAgain.findIndex((hit) => hit.sourceType === "document");
  const lastDurable = defaultAgain.findLastIndex((hit) => ["curated", "project-state", "tool", "plan", "profile"].includes(hit.sourceType));
  assert.ok(firstDocument === -1 || lastDurable < firstDocument, "documents cannot rank before durable memory");
});

test("raw conversation ownership rejects cross-group and cross-user principals", async () => {
  const root = path.join(TMP, "capture-ownership");
  const owner = { framework_id: "framework", group_id: "group-owner", user_id: "user-owner", agent_id: "agent-owner", role_id: "role-owner" };
  const conversation = createConversationMemory({ dataRoot: root });
  const result = await conversation.capture({ conversationId: "ownership-1", source: "test", principal: owner, messages: [{ role: "user", content: "隔离鲸鱼唯一原文词。" }] });
  const store = createIndexStore({ dataRoot: root, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fetchImpl() });
  await store.index({ paths: [result.evidencePath] });
  const sameOwnerDifferentAgent = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: [{ layer: "memory", visibility: "agent", project: "other-agent" }], agentId: "other-agent", principal: { ...owner, agent_id: "other-agent", role_id: "other-role" }, ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 } });
  assert.equal((await sameOwnerDifferentAgent.search({ query: "隔离鲸鱼", searchMode: "raw", graphExpand: false })).length, 1);
  const denied = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: [{ layer: "memory", visibility: "agent", project: "role-owner" }], agentId: "agent-owner", principal: { ...owner, group_id: "other-group" }, ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 } });
  assert.deepEqual(await denied.search({ query: "隔离鲸鱼", searchMode: "raw", graphExpand: false }), []);
});

test("captured conversation becomes searchable without refinement", async () => {
  const root = path.join(TMP, "capture-searchable");
  const principal = { framework_id: "framework", group_id: "group-capture", user_id: "user-capture", agent_id: "agent-capture", role_id: "role-capture" };
  const captured = [];
  const conversation = createConversationMemory({ dataRoot: root, onCaptured: async (event) => { captured.push(event); return { status: "indexed" }; } });
  const result = await conversation.capture({ conversationId: "capture-search-1", source: "test", principal, messages: [{ role: "user", content: "这是一段棱镜鲸落唯一原文词。" }] });
  assert.equal(result.searchStatus, "indexed");
  assert.equal(captured.length, 1);
  const store = createIndexStore({ dataRoot: root, ollama: { model: "nomic-embed-text", dimension: 768 }, fetchImpl: fetchImpl() });
  const indexed = await store.index({ paths: [result.evidencePath] });
  assert.equal(indexed.failed, 0);
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: [{ layer: "memory", visibility: "agent", project: "role-capture" }], agentId: "agent-capture", principal, ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 } });
  const hits = await lib.search({ query: "棱镜鲸落", searchMode: "raw", rawQuota: 1, graphExpand: false });
  assert.ok(hits.some((hit) => hit.path === result.evidencePath));
  assert.equal(hits[0].quotaLayer, "raw");
});

test("document excerpts skip frontmatter and retain body relevance", async () => {
  const root = path.join(TMP, "document-body-excerpt");
  const documents = path.join(root, "evidence", "documents", "acceptance-smoke");
  await fs.mkdir(documents, { recursive: true });
  const file = path.join(documents, "alpha.md");
  await fs.writeFile(file, "---\nid: external-document-alpha\nlayer: evidence\nkind: document\nstatus: active\n---\n\n# 导入核对 Alpha\n\n外部资料导入接口核对用文档：记录 Alpha 主题的三条要点。\n", "utf8");
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: null, ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 } });
  const hits = await lib.search({ query: "导入核对 Alpha 主题三条要点", limit: 2, mode: "file-first", graphExpand: false });
  const hit = hits.find((item) => item.sourceType === "document");
  assert.ok(hit);
  assert.match(hit.excerpt, /导入核对 Alpha/u);
  assert.match(hit.excerpt, /三条要点/u);
  assert.doesNotMatch(hit.excerpt, /---|id:/u);
  assert.ok(Number(hit.scoreParts?.relevance) > 0);
});

test("legacy vector search skips rows with mismatched model or dimension", async () => {
  const root = path.join(TMP, "legacy-vector-filter");
  const sqliteDir = path.join(root, "indexes", "sqlite");
  await fs.mkdir(sqliteDir, { recursive: true });
  const ledgerPath = path.join(sqliteDir, "openclaw-memory-ledger.sqlite");
  const db = new DatabaseSync(ledgerPath);
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE TABLE embeddings (chunk_id TEXT, model TEXT, dimension INTEGER, vector_blob BLOB, vector_status TEXT);");
  const file = path.join(root, "curated", "shared", "hit.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "---\nid: hit\nstatus: active\n---\n\nfilter test", "utf8");
  db.prepare("INSERT INTO files VALUES (?, ?, ?)").run("f", file, "curated");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("good", "f", "good", "good");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("wrong-model", "f", "wrong-model", "wrong");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("wrong-dimension", "f", "wrong-dimension", "wrong");
  const blob = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, 'active')").run("good", "bge-m3", 4, blob);
  db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, 'active')").run("wrong-model", "nomic-embed-text", 4, blob);
  db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, 'active')").run("wrong-dimension", "bge-m3", 3, blob);
  db.close();
  const { openLedgerReadonly, vectorSearch } = await import("../src/ledger-search.mjs");
  const ro = openLedgerReadonly(root);
  try {
    const results = await vectorSearch(ro, "query", 10, null, { endpoint: "http://127.0.0.1:1", model: "bge-m3", dimension: 4 }, 0, async () => ({ ok: true, json: async () => ({ embedding: [1, 0, 0, 0] }) }));
    assert.deepEqual(results.map((row) => row.chunkId), ["good"]);
  } finally { ro?.close(); }
});

test("D5.2 falls back to legacy read-only ledger when owned index has no result", async () => {
  const root = path.join(TMP, "legacy-fallback");
  const shared = path.join(root, "curated", "shared");
  const sqliteDir = path.join(root, "indexes", "sqlite");
  await fs.mkdir(shared, { recursive: true });
  await fs.mkdir(sqliteDir, { recursive: true });
  const target = path.join(shared, "legacy-only.md");
  await fs.writeFile(target, "---\\nid: legacy-only\\nstatus: active\\n---\\n\\nlegacy fallback marker\\n", "utf8");
  const ledgerPath = path.join(sqliteDir, "openclaw-memory-ledger.sqlite");
  const db = new DatabaseSync(ledgerPath);
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED, item_id UNINDEXED, text_excerpt);");
  db.prepare("INSERT INTO files VALUES (?, ?, ?)").run("file-legacy", target, "curated");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("chunk-legacy", "file-legacy", "legacy-only", "legacy fallback marker");
  db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run("chunk-legacy", "legacy-only", "legacy fallback marker");
  db.close();
  const before = crypto.createHash("sha256").update(await fs.readFile(ledgerPath)).digest("hex");
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: [{ layer: "memory", visibility: "shared" }], ollama: { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 }, embeddingFetch: fetchImpl() });
  const hits = await lib.search({ query: "legacy fallback marker", limit: 5, mode: "hybrid", graphExpand: false });
  assert.ok(hits.some((h) => h.path === target), "legacy candidate should be available as fallback");
  const after = crypto.createHash("sha256").update(await fs.readFile(ledgerPath)).digest("hex");
  assert.equal(after, before, "legacy ledger must remain read-only");
});
