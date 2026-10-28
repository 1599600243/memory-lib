// memory-lib Slice 1 — fixture contract tests.
// Run: node --test test/contract.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMemoryLib, hasStrongVectorSignal, isExactLookupQuery, scopeAllows } from "../src/memory-lib.mjs";
import { snapshotTree, diffSnapshots } from "../scripts/zero-write-check.mjs";
import { ftsSearch, inAuthRoots, ledgerFileState, openLedgerReadonly } from "../src/ledger-search.mjs";
import { semanticSearch, upsertSemanticFile } from "../src/semantic-index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-contract-"));
const FIXTURE_WORKSPACE = path.join(fixtureRoot, "workspace");
await fs.cp(path.join(here, "fixtures", "workspace"), FIXTURE_WORKSPACE, { recursive: true });
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const FIXTURE_LEARNING = path.join(FIXTURE_WORKSPACE, "learning");

// Health fixtures are owned by this test, so results do not depend on checked-in directory drift.
await Promise.all([
  path.join(FIXTURE_WORKSPACE, "recovery", "policies"),
  path.join(FIXTURE_WORKSPACE, "recovery", "plans"),
  path.join(FIXTURE_DATA, "tools-memory"),
  path.join(FIXTURE_DATA, "plans"),
  path.join(FIXTURE_DATA, "profile"),
  path.join(FIXTURE_DATA, "evidence", "documents"),
  path.join(FIXTURE_DATA, "evidence", "conversations"),
].map((directory) => fs.mkdir(directory, { recursive: true })));

after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));

const SHARED_SCOPE = [{ layer: "memory", visibility: "shared" }];

function rel(p) {
  return path.relative(FIXTURE_WORKSPACE, p).replace(/\\/g, "/");
}

test("ledger authorization matches complete path segments", () => {
  const root = path.join("I:\\OpenClaw\\memory-data\\memory\\project-state", "pilot");
  assert.equal(inAuthRoots(path.join(root, "state.md"), [root]), true);
  assert.equal(inAuthRoots(path.join("I:\\OpenClaw\\memory-data\\memory\\project-state", "pilot2", "state.md"), [root]), false);
});

test("scope authorization supports bounded project wildcards", () => {
  assert.equal(scopeAllows({ layer: "memory", visibility: "project", project: "*" }, { layer: "memory", visibility: "project", project: "pilot" }), true);
  assert.equal(scopeAllows({ layer: "memory", visibility: "project", project: "pilot" }, { layer: "memory", visibility: "project", project: "other" }), false);
  assert.equal(scopeAllows({ layer: "memory", visibility: "project", project: "*" }, { layer: "memory", visibility: "agent", project: "pilot" }), false);
  assert.equal(scopeAllows({ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "shared" }), true);
});

test("pure-vector policy distinguishes exact lookup from natural language", () => {
  assert.equal(isExactLookupQuery("DSH_ACCEPTANCE_RANDOM_9f7b2e31c4"), true);
  assert.equal(isExactLookupQuery("mem_20260805_memory_loop"), true);
  assert.equal(isExactLookupQuery("zqxjkvmwq"), true, "unknown single tokens must not fall through to pure-vector retrieval");
  assert.equal(isExactLookupQuery("memory2026"), true, "single-token alphanumeric queries use lexical/id lookup only");
  assert.equal(isExactLookupQuery("记忆治理生命周期"), false, "unsegmented CJK natural language keeps semantic retrieval");
  assert.equal(isExactLookupQuery("记忆 治理 生命周期"), false);
  assert.equal(isExactLookupQuery("Windows durable fence process start identity"), false);
  assert.equal(hasStrongVectorSignal(0.56, 0.55), true, "natural-language semantic retrieval uses a low health floor");
  assert.equal(hasStrongVectorSignal(0.49, 0.20), false, "very weak vector results remain rejected");
});

// F2: health() 现在会只读探测向量车道（src/vector-lane.mjs）。这里显式注入
// stub + 声明 fixture 无 ledger（requireIndex:false），避免依赖本机 Ollama 状态。
const VECTOR_LANE_FIXTURE = {
  requireIndex: false,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "bge-m3:latest" }] }) }),
};

test("health: all current fixture checks present -> healthy", async () => {
  await Promise.all([
    "tools-memory", "plans", "profile", path.join("evidence", "documents"), path.join("evidence", "conversations"),
  ].map((relative) => fs.mkdir(path.join(FIXTURE_DATA, relative), { recursive: true })));
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: null, vectorLane: VECTOR_LANE_FIXTURE });
  const h = await lib.health();
  assert.equal(h.health, "healthy", JSON.stringify(h.checks, null, 2));
  assert.equal(h.backend, "file-first");
  assert.equal(h.checks.find((c) => c.name === "vector-lane")?.status, "ok", "the vector lane is reported among the checks");
});

test("health: missing pieces -> reduced", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: null, vectorLane: VECTOR_LANE_FIXTURE });
  // simulate by pointing recoveryRoot somewhere empty
  const h = await createMemoryLib({
    dataRoot: FIXTURE_DATA,
    workspaceRoot: FIXTURE_WORKSPACE,
    recoveryRoot: path.join(FIXTURE_WORKSPACE, "does-not-exist"),
    vectorLane: VECTOR_LANE_FIXTURE,
  }).health();
  assert.ok(["reduced", "degraded"].includes(h.health));
});

test("search parity (scopes=null): shared + agent + project-state searchable, inbox excluded", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: null });

  const shared = await lib.search({ query: "原则" });
  assert.ok(shared.length >= 1, "shared keyword should match");
  assert.ok(shared.some((r) => r.path.includes(`${path.sep}curated${path.sep}shared${path.sep}`)), "shared result present");

  const agent = await lib.search({ query: "主智能体" });
  assert.ok(agent.length >= 1, "agent keyword should match in parity mode");
  assert.ok(agent.some((r) => r.path.includes(`${path.sep}curated${path.sep}agents${path.sep}main${path.sep}`)), "agent result present");

  const project = await lib.search({ query: "项目状态" });
  assert.ok(project.some((r) => rel(r.path).startsWith("memory/project-state/")), "project-state result present");

  const inbox = await lib.search({ query: "候选记忆" });
  assert.equal(inbox.length, 0, "inbox must never be searched");
});

test("search restricted (memory/shared): only curated/shared reachable", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: SHARED_SCOPE });

  const shared = await lib.search({ query: "原则" });
  assert.ok(shared.length >= 1);
  for (const r of shared) {
    assert.ok(rel(r.path).startsWith("memory/curated/shared/"), `out of scope result: ${rel(r.path)}`);
  }

  const agent = await lib.search({ query: "主智能体" });
  assert.equal(agent.length, 0, "agent memory must be denied for shared scope");

  const knowledge = await lib.search({ query: "共享事实" });
  assert.equal(knowledge.length, 0, "knowledge layer must be denied for memory/shared scope");
});

test("search restricted: deny-by-default for unmapped scopes", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: [{ layer: "recovery", visibility: "shared" }] });
  const results = await lib.search({ query: "原则" });
  assert.equal(results.length, 0, "unmapped scope -> no roots -> deny everything");
});

test("search restricted: agent scope only reaches that agent's dir", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: [{ layer: "memory", visibility: "agent", project: "main" }] });
  const agent = await lib.search({ query: "主智能体" });
  assert.ok(agent.length >= 1);
  for (const r of agent) {
    assert.ok(rel(r.path).startsWith("memory/curated/agents/main/"), `out of agent scope: ${rel(r.path)}`);
  }
  const steward = await lib.search({ query: "管家" });
  assert.equal(steward.length, 0, "other agent memory must be denied");
});

test("get: shared scope can read shared item, cannot read agent item (no leak)", async () => {
  const sharedLib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: SHARED_SCOPE });

  const ok = await sharedLib.get("mem_fixture_shared_business");
  assert.ok(ok, "shared item should be readable");
  assert.equal(ok.id, "mem_fixture_shared_business");

  const denied = await sharedLib.get("mem_fixture_agent_main");
  assert.equal(denied, null, "agent item must be invisible to shared scope (null, not leak)");

  const unknown = await sharedLib.get("mem_no_such_id");
  assert.equal(unknown, null, "unknown id -> null");
});

test("get: parity mode reads any curated item", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: null });
  const ok = await lib.get("mem_fixture_agent_main");
  assert.ok(ok, "parity mode may read agent item");
  assert.equal(ok.frontmatter.scope, "agent");
});

test("ledger file state tolerates schemas without status", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-ledger-schema-"));
  const dataRoot = path.join(tmp, "memory");
  const indexRoot = path.join(dataRoot, "indexes", "sqlite");
  await fs.mkdir(indexRoot, { recursive: true });
  const db = new DatabaseSync(path.join(indexRoot, "openclaw-memory-ledger.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT, sha256 TEXT);");
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?)").run("file-1", path.join(tmp, "item.md"), "curated", "abc");
  db.close();
  try {
    const state = ledgerFileState(dataRoot);
    assert.ok(state, "ledger state must remain available when status is absent");
    assert.equal(state.size, 1);
    assert.equal(state.values().next().value.sha256, "abc");
    assert.equal(state.values().next().value.status, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("ledger hybrid candidates preserve item identity", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-ledger-item-id-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  const indexRoot = path.join(dataRoot, "indexes", "sqlite");
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.mkdir(indexRoot, { recursive: true });
  const target = path.join(sharedRoot, "item.md");
  await fs.writeFile(target, "---\nid: mem_item\nstatus: active\n---\n\nitem identity fixture\n");
  const db = new DatabaseSync(path.join(indexRoot, "openclaw-memory-ledger.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED, item_id UNINDEXED, text_excerpt);");
  db.prepare("INSERT INTO files VALUES (?, ?, ?)").run("file-item", target, "curated");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("chunk-item", "file-item", "mem_item", "item identity fixture");
  db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run("chunk-item", "mem_item", "item identity fixture");
  db.close();
  try {
    const readDb = openLedgerReadonly(dataRoot);
    const results = ftsSearch(readDb, "item identity fixture", 5, [sharedRoot]);
    readDb.close();
    assert.equal(results[0]?.itemId, "mem_item", "ledger candidates must preserve item_id");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("file-first fallback finds new files even when ledger results fill the limit", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-ledger-gap-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  const indexRoot = path.join(dataRoot, "indexes", "sqlite");
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.mkdir(indexRoot, { recursive: true });
  const oldFiles = [];
  for (let i = 0; i < 10; i++) {
    const file = path.join(sharedRoot, `old-${i}.md`);
    oldFiles.push(file);
    await fs.writeFile(file, `---\nid: mem_old_${i}\nstatus: active\n---\n\n# Old\nLegacy database record ${i}.\n`);
  }
  const target = path.join(sharedRoot, "new-common-word.md");
  await fs.writeFile(target, "---\nid: mem_new_common\nstatus: active\n---\n\n# New memory\nThe project uses PostgreSQL database infrastructure.\n");
  const db = new DatabaseSync(path.join(indexRoot, "openclaw-memory-ledger.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED, item_id UNINDEXED, text_excerpt);");
  for (let i = 0; i < oldFiles.length; i++) {
    const id = `file-${i}`;
    const chunk = `chunk-${i}`;
    const excerpt = `Legacy database record ${i}.`;
    db.prepare("INSERT INTO files VALUES (?, ?, ?)").run(id, oldFiles[i], "curated");
    db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run(chunk, id, `mem_old_${i}`, excerpt);
    db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run(chunk, `mem_old_${i}`, excerpt);
  }
  db.close();
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: SHARED_SCOPE, ollama: { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 } });
    const results = await lib.search({ query: "database", limit: 10, graphExpand: false });
    assert.ok(results.some((item) => item.path === target), "new common-word file must be visible when ledger already fills the limit");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("file-first prioritizes files whose content changed after ledger indexing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-ledger-stale-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  const indexRoot = path.join(dataRoot, "indexes", "sqlite");
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.mkdir(indexRoot, { recursive: true });
  const oldFiles = [];
  for (let i = 0; i < 10; i++) {
    const file = path.join(sharedRoot, `old-${i}.md`);
    oldFiles.push(file);
    await fs.writeFile(file, `---\nid: mem_old_${i}\nstatus: active\n---\n\n# Old\nLegacy database record ${i}.\n`);
  }
  const target = path.join(sharedRoot, "changed-common-word.md");
  const original = "---\nid: mem_changed_common\nstatus: active\n---\n\n# Old\nLegacy database record.\n";
  await fs.writeFile(target, original);
  const db = new DatabaseSync(path.join(indexRoot, "openclaw-memory-ledger.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT, sha256 TEXT, status TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED, item_id UNINDEXED, text_excerpt);");
  const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
  for (let i = 0; i < oldFiles.length; i++) {
    const id = `file-${i}`;
    const chunk = `chunk-${i}`;
    const excerpt = `Legacy database record ${i}.`;
    db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?)").run(id, oldFiles[i], "curated", hash(await fs.readFile(oldFiles[i], "utf8")), "active");
    db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run(chunk, id, `mem_old_${i}`, excerpt);
    db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run(chunk, `mem_old_${i}`, excerpt);
  }
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?)").run("file-changed", target, "curated", hash(original), "active");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("chunk-changed", "file-changed", "mem_changed_common", "Legacy database record.");
  db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run("chunk-changed", "mem_changed_common", "Legacy database record.");
  db.close();
  await fs.writeFile(target, "---\nid: mem_changed_common\nstatus: active\n---\n\n# Changed\nThe changed database record is the current source of truth.\n");
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: SHARED_SCOPE, ollama: { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 } });
    const results = await lib.search({ query: "database", limit: 5, graphExpand: false });
    const changedIndex = results.findIndex((item) => item.path === target);
    const firstSyncedIndex = results.findIndex((item) => item.path !== target && item.path.includes("old-"));
    assert.ok(changedIndex >= 0, "changed file must be visible when stale ledger results fill the limit");
    assert.ok(firstSyncedIndex === -1 || changedIndex < firstSyncedIndex, "changed file must rank before synced files");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("file-first excerpt prefers body matches over frontmatter matches", async () => {
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: SHARED_SCOPE, ollama: { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 } });
  const target = path.join(FIXTURE_DATA, "curated", "shared", "frontmatter-noise.md");
  const text = "---\nid: mem_frontmatter_noise\nreviewState: reviewed\nstatus: active\n---\n\n# Decision\nWe chose React because the team has five years of experience.\n";
  const fs = await import("node:fs/promises");
  await fs.writeFile(target, text);
  try {
    const results = await lib.search({ query: "we", limit: 10, mode: "file-first", graphExpand: false });
    const hit = results.find((item) => item.path === target);
    assert.ok(hit, "body match should be returned");
    assert.match(hit.excerpt, /We chose React/);
  } finally {
    await fs.unlink(target);
  }
});

test("ordinary cross-session queries keep lexical relevance ahead of recency", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-cross-session-rank-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(sharedRoot, { recursive: true });
  const query = "what caused the out of memory crash";
  await fs.writeFile(path.join(sharedRoot, "older-relevant.md"), `---\nid: mem_older_relevant\nstatus: active\neventAt: 2026-01-01T00:00:00.000Z\n---\n\n${query}. The unbounded cache in UserService caused it.\n${query}.\n`);
  await fs.writeFile(path.join(sharedRoot, "newer-noise.md"), `---\nid: mem_newer_noise\nstatus: active\neventAt: 2026-08-01T00:00:00.000Z\n---\n\n${query}. Unrelated diagnostic note.\n`);
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: null });
    const results = await lib.search({ query, limit: 2, mode: "file-first", graphExpand: false });
    assert.equal(path.basename(results[0]?.path ?? ""), "older-relevant.md", "ordinary questions must not be reordered as current-intent queries");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("explicit current-intent queries rank the latest event first", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-current-rank-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(sharedRoot, { recursive: true });
  const query = "current database";
  await fs.writeFile(path.join(sharedRoot, "older-repeated.md"), `---\nid: mem_older_database\nstatus: active\neventAt: 2026-01-01T00:00:00.000Z\n---\n\n${query}: MySQL.\n${query}: MySQL.\n`);
  await fs.writeFile(path.join(sharedRoot, "newer.md"), `---\nid: mem_newer_database\nstatus: active\neventAt: 2026-08-01T00:00:00.000Z\n---\n\n${query}: PostgreSQL.\n`);
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: null });
    const results = await lib.search({ query, limit: 2, mode: "file-first", graphExpand: false });
    assert.equal(path.basename(results[0]?.path ?? ""), "newer.md", "current-intent queries must prefer the latest temporal fact");
    assert.equal(results.length, 1, "current-intent queries must not return superseded historical facts");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("multi-word queries use bounded token fallback when the full phrase is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-token-fallback-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(sharedRoot, { recursive: true });
  const target = path.join(sharedRoot, "out-of-memory.md");
  await fs.writeFile(target, "---\nid: mem_out_of_memory\nstatus: active\n---\n\nThe unbounded cache in UserService caused the out of memory crash.\n");
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: null });
    const results = await lib.search({ query: "what caused the out of memory crash", limit: 5, graphExpand: false });
    assert.ok(results.some((item) => item.path === target), "token fallback must find relevant content when the full phrase is absent");
    const random = await lib.search({ query: "DSH_RANDOM_20260828", limit: 5, graphExpand: false });
    assert.equal(random.length, 0, "identifier-like random queries must not fall through to token or vector noise");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("hybrid lexical evidence keeps the exact hit ahead of token fallback", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-hybrid-lexical-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  const indexRoot = path.join(dataRoot, "indexes", "sqlite");
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.mkdir(indexRoot, { recursive: true });
  const query = "Memory Service v1 uses a search -> inbox -> review -> promote loop.";
  const target = path.join(sharedRoot, "target.md");
  await fs.writeFile(target, `---\nid: mem_target\nstatus: active\n---\n\n${query}\n`);
  const noiseFiles = [];
  for (let i = 0; i < 10; i++) {
    const file = path.join(sharedRoot, `noise-${i}.md`);
    noiseFiles.push(file);
    await fs.writeFile(file, `---\nid: mem_noise_${i}\nstatus: active\n---\n\nsearch inbox review promote service record ${i}.\n`);
  }
  const db = new DatabaseSync(path.join(indexRoot, "openclaw-memory-ledger.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED, item_id UNINDEXED, text_excerpt);");
  db.prepare("INSERT INTO files VALUES (?, ?, ?)").run("file-target", target, "curated");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("chunk-target", "file-target", "mem_target", query);
  db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run("chunk-target", "mem_target", query);
  db.close();
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: SHARED_SCOPE, ollama: { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 } });
    const results = await lib.search({ query, limit: 5, graphExpand: false });
    assert.equal(results[0]?.path, target, "an existing lexical hit must remain ahead of token fallback noise");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("deleted ledger paths are filtered from search results", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-stale-ledger-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  const indexRoot = path.join(dataRoot, "indexes", "sqlite");
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.mkdir(indexRoot, { recursive: true });
  const target = path.join(sharedRoot, "deleted-after-index.md");
  await fs.writeFile(target, "---\nid: mem_deleted_after_index\nstatus: active\n---\n\n# Delete me\nunique ghost marker.\n");
  const db = new DatabaseSync(path.join(indexRoot, "openclaw-memory-ledger.sqlite"));
  db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT); CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, item_id TEXT, text_excerpt TEXT); CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED, item_id UNINDEXED, text_excerpt);");
  db.prepare("INSERT INTO files VALUES (?, ?, ?)").run("file-stale", target, "curated");
  db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run("chunk-stale", "file-stale", "mem_deleted_after_index", "unique ghost marker.");
  db.prepare("INSERT INTO fts_chunks VALUES (?, ?, ?)").run("chunk-stale", "mem_deleted_after_index", "unique ghost marker.");
  db.close();
  await fs.unlink(target);
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: null, ollama: { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 } });
    const results = await lib.search({ query: "unique ghost marker", graphExpand: false });
    assert.equal(results.length, 0, "deleted files must never be returned from stale ledger rows");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("file-first scans newest files before the bounded scan cap", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-newest-cap-"));
  const dataRoot = path.join(tmp, "memory");
  const sharedRoot = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(sharedRoot, { recursive: true });
  for (let i = 0; i < 605; i++) {
    await fs.writeFile(path.join(sharedRoot, `old-${String(i).padStart(3, "0")}.md`), `---\nid: mem_old_${i}\nstatus: active\n---\n\nUnrelated historical content ${i}.\n`);
  }
  const target = path.join(sharedRoot, "newest.md");
  await fs.writeFile(target, "---\nid: mem_newest\nstatus: active\n---\n\nFresh seed marker DSH_NEWEST_CAP.\n");
  try {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: null, fileFirstScanCap: 600 });
    const results = await lib.search({ query: "DSH_NEWEST_CAP", limit: 5, mode: "file-first", graphExpand: false });
    assert.equal(results[0]?.path, target, "the newest file must be scanned before the bounded cap");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("exact item id remains Top1 after all-lanes overlay ranking", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-exact-id-overlay-"));
  const dataRoot = path.join(tmp, "memory");
  const root = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(root, { recursive: true });
  const id = "mem_exact_overlay_target";
  const target = path.join(root, "target.md");
  await fs.writeFile(target, `---\nid: ${id}\nstatus: active\n---\n\nCanonical target body.\n`);
  for (let i = 0; i < 30; i++) await fs.writeFile(path.join(root, `noise-${i}.md`), `---\nid: mem_noise_${i}\nstatus: active\n---\n\nHistorical report mentions ${id} repeatedly: ${id} ${id}.\n`);
  try {
    const results = await createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: null }).search({ query: id, limit: 10, graphExpand: false });
    assert.equal(results[0]?.path, target);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("semantic index search never creates an index during read-only search", async () => {
  const semanticPath = path.join(FIXTURE_DATA, "indexes", "sqlite", "memory-semantic.sqlite");
  await fs.rm(semanticPath, { force: true });
  const fixtureLib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: SHARED_SCOPE, indexRefresh: false });
  await fixtureLib.search({ query: "semantic-only-query", graphExpand: false });
  await assert.rejects(fs.stat(semanticPath), /ENOENT/);
});

test("semantic index creates its parent, validates file hash, and returns fresh rows", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-semantic-index-"));
  const dataRoot = path.join(tmp, "memory");
  const target = path.join(dataRoot, "curated", "shared", "semantic.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "---\nid: mem_semantic_contract\nstatus: active\n---\n\nSensitive data uses AES-256 encryption.\n");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async ({ toString }) => ({ json: async () => ({ embedding: Array.from({ length: 4 }, (_, i) => toString ? [1, 0, 0, 0][i] : 0) }) });
  const ollama = { endpoint: "http://127.0.0.1:1", model: "fixture", dimension: 4 };
  try {
    await upsertSemanticFile(dataRoot, target, ollama);
    const hits = await semanticSearch(dataRoot, "protect information", 5, [path.dirname(target)], ollama, 0.5);
    assert.equal(hits[0]?.itemId, "mem_semantic_contract");
    await fs.appendFile(target, "Changed after indexing.\n");
    assert.deepEqual(await semanticSearch(dataRoot, "protect information", 5, [path.dirname(target)], ollama, 0.5), []);
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("semantic index accepts concurrent promoted-file upserts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-semantic-concurrent-"));
  const dataRoot = path.join(tmp, "memory");
  const root = path.join(dataRoot, "project-state", "pilot");
  await fs.mkdir(root, { recursive: true });
  const files = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const file = path.join(root, `semantic-${i}.md`);
    await fs.writeFile(file, `---\nid: mem_semantic_${i}\nstatus: active\n---\n\nConcurrent semantic memory ${i} about topic ${i}.\n`);
    return file;
  }));
  try {
    await Promise.all(files.map((file) => upsertSemanticFile(dataRoot, file, { endpoint: "http://127.0.0.1:11434", model: "nomic-embed-text", dimension: 768 })));
    const db = new DatabaseSync(path.join(dataRoot, "indexes", "sqlite", "memory-semantic.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents").get().count, files.length);
    } finally { db.close(); }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zero-write: all library ops leave the data root byte-identical", async () => {
  const before = await snapshotTree(FIXTURE_WORKSPACE);
  const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: null, vectorLane: VECTOR_LANE_FIXTURE });
  await lib.health();
  await lib.search({ query: "原则" });
  await lib.search({ query: "记忆" });
  await lib.get("mem_fixture_shared_business");
  await lib.get("mem_fixture_agent_main");
  const restricted = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: SHARED_SCOPE });
  await restricted.search({ query: "主智能体" });
  await restricted.get("mem_fixture_agent_main");
  const after = await snapshotTree(FIXTURE_WORKSPACE);
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes, [], `data root was modified: ${JSON.stringify(changes)}`);
});
