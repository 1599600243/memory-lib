// memory-lib — F2: read-only vector-lane health probing (regression tests).
// Run directly: node test/vector-lane-health.test.mjs
//
// Why this file exists: production GET /v1/health reported "healthy" while Ollama
// was not running, so the semantic (vector) lane had silently degraded to
// file-first / FTS. health() must probe the vector lane READ-ONLY and degrade
// the overall status with a reason instead of claiming healthy.
//
// Determinism: nothing here depends on the machine's Ollama. Every probe input
// (the /api/tags request -> fetch stub, the ledger fixture) is configured
// explicitly, and the only "unreachable" case uses the closed loopback port
// already used by contract.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { snapshotTree, diffSnapshots } from "../scripts/zero-write-check.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const OLLAMA = { endpoint: "http://127.0.0.1:11434", model: "nomic-embed-text", dimension: 768 };
// 关闭的回环端口：既有 contract 测试就用它表示「不可达」，不依赖本机 Ollama 状态。
const CLOSED_OLLAMA = { endpoint: "http://127.0.0.1:1", model: "nomic-embed-text", dimension: 768 };

const created = [];
let adapterToClose = null;
after(async () => {
  if (adapterToClose) await adapterToClose.close();
  for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
});

// --- fixtures ----------------------------------------------------------------
// 每个用例一份独立 tmp 副本：既能建 ledger fixture，又不碰 checked-in fixtures。
async function fixtureRoot(label, ledger = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `memory-lib-${label}-`));
  created.push(root);
  const workspace = path.join(root, "workspace");
  await fs.cp(path.join(here, "fixtures", "workspace"), workspace, { recursive: true });
  const dataRoot = path.join(workspace, "memory");
  await Promise.all(["tools-memory", "plans", "profile", path.join("evidence", "documents"), path.join("evidence", "conversations")].map((relative) => fs.mkdir(path.join(dataRoot, relative), { recursive: true })));
  await Promise.all([path.join(workspace, "recovery", "policies"), path.join(workspace, "recovery", "plans")].map((directory) => fs.mkdir(directory, { recursive: true })));
  if (ledger) await writeLedgerFixture(dataRoot, ledger);
  return { workspace, dataRoot };
}

// 最小 ledger fixture（只读探针要读的列）：embeddings.content_hash 故意与
// files.sha256 不可比（分块哈希 vs 整文件哈希）——F2 明确不得跨车道比哈希，
// 因此探针只用可用性/状态，不做这种比较。
async function writeLedgerFixture(dataRoot, { active = 2, stale = 0, wal = false } = {}) {
  const file = path.join(dataRoot, "indexes", "sqlite", "openclaw-memory-ledger.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    if (wal) db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT, role TEXT, sha256 TEXT)");
    db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, item_id TEXT, file_id TEXT, text_excerpt TEXT)");
    db.exec("CREATE TABLE embeddings (id TEXT PRIMARY KEY, chunk_id TEXT, model TEXT, dimension INTEGER, vector_status TEXT, content_hash TEXT)");
    for (let i = 0; i < active + stale; i++) {
      db.prepare("INSERT INTO files (id,path,role,sha256) VALUES (?,?,?,?)").run(`fil_${i}`, path.join(dataRoot, "curated", "shared", `f${i}.md`), "canonical", `sha-of-file-${i}`);
      db.prepare("INSERT INTO chunks (id,item_id,file_id,text_excerpt) VALUES (?,?,?,?)").run(`chk_${i}`, `itm_${i}`, `fil_${i}`, `chunk body ${i}`);
      db.prepare("INSERT INTO embeddings (id,chunk_id,model,dimension,vector_status,content_hash) VALUES (?,?,?,?,?,?)")
        .run(`emb_${i}`, `chk_${i}`, "nomic-embed-text", 768, i < active ? "active" : "stale", `sha-of-chunk-${i}`);
    }
  } finally {
    db.close();
  }
  return file;
}

// 显式注入的 Ollama /api/tags stub：记录调用以便断言「只读探测」。
function stubTagsFetch({ models = ["nomic-embed-text:latest"], mode = "ok", calls = [] } = {}) {
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (mode === "unreachable") throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    if (mode === "http-error") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ models: models.map((name) => ({ name })) }) };
  };
  return { fetchImpl, calls };
}

const vectorCheck = (h) => h.checks.find((c) => c.name === "vector-lane");

// JSON.stringify 会把反斜杠转义，所以用「取出全部字符串再找盘符路径」来断言不泄路径。
// 前置字符排除字母数字/斜杠，避免把 `http://127.0.0.1:11434` 误判成盘符路径。
function jsonStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) jsonStrings(item, out);
  return out;
}
const filesystemPathLeak = (value) => jsonStrings(value).filter((text) => /(?:^|[^A-Za-z0-9/])[A-Za-z]:[\\/]/u.test(text));

// --- createMemoryLib.health() ------------------------------------------------

test("F2: ollama unreachable -> vector-lane down, overall degraded (never healthy)", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-down", { active: 2 });
  const stub = stubTagsFetch({ mode: "unreachable" });
  const h = await createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stub.fetchImpl } }).health();

  assert.equal(vectorCheck(h).status, "down", JSON.stringify(h.checks, null, 2));
  assert.match(h.vector.reason, /^vector-lane down: ollama unreachable$/u);
  assert.equal(h.health, "degraded", "a dead vector lane must not be reported healthy");
  assert.equal(h.reason, h.vector.reason, "overall degradation carries the vector-lane reason");
  assert.equal(vectorCheck(h).reason, h.vector.reason);
  // 只读探测：只发一次 GET /api/tags，不做 embedding 推理、不写索引。
  assert.deepEqual(stub.calls, [{ url: `${OLLAMA.endpoint}/api/tags`, method: "GET" }]);
  assert.deepEqual(filesystemPathLeak(h.vector), [], "vector status must not leak filesystem paths");
});

test("F2: ollama reachable, model present, active embeddings -> vector-lane ok, healthy", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-ok", { active: 3, stale: 1 });
  const stub = stubTagsFetch();
  const h = await createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stub.fetchImpl } }).health();

  assert.equal(vectorCheck(h).status, "ok", JSON.stringify(h.checks, null, 2));
  assert.match(h.vector.reason, /3 active embeddings/u);
  assert.equal(h.vector.detail.activeEmbeddings, 3);
  assert.equal(h.vector.detail.staleEmbeddings, 1);
  assert.equal(h.health, "healthy");
  assert.equal(h.reason, null, "healthy health carries no degradation reason");
  assert.equal(stub.calls.length, 1);
});

test("F2: embedding model missing on a reachable ollama -> vector-lane down", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-model-missing", { active: 2 });
  const h = await createMemoryLib({
    dataRoot,
    workspaceRoot: workspace,
    scopes: null,
    ollama: OLLAMA,
    vectorLane: { fetch: stubTagsFetch({ models: ["qwen3:latest", "gemma3:4b"] }).fetchImpl },
  }).health();

  assert.equal(vectorCheck(h).status, "down");
  assert.match(h.vector.reason, /^vector-lane down: embedding model missing \(nomic-embed-text\)$/u);
  assert.equal(h.health, "degraded");
});

test("F2: reachable ollama that fails /api/tags -> vector-lane down (not healthy)", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-tags-error", { active: 2 });
  const h = await createMemoryLib({
    dataRoot,
    workspaceRoot: workspace,
    scopes: null,
    ollama: OLLAMA,
    vectorLane: { fetch: stubTagsFetch({ mode: "http-error" }).fetchImpl },
  }).health();

  assert.equal(vectorCheck(h).status, "down");
  assert.match(h.vector.reason, /^vector-lane down: ollama tags unavailable$/u);
  assert.equal(h.health, "degraded");
});

test("F2: ledger absent -> vector-lane stale and degraded (index availability is probed)", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-no-ledger");
  const h = await createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stubTagsFetch().fetchImpl } }).health();

  assert.equal(vectorCheck(h).status, "stale", JSON.stringify(h.checks, null, 2));
  assert.match(h.vector.reason, /^vector-lane stale: ledger unavailable$/u);
  assert.equal(h.health, "degraded");
  assert.deepEqual(filesystemPathLeak(h.vector), [], "the stale reason must not leak the ledger path");
});

test("F2: index present but no active embeddings -> vector-lane stale", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-all-stale", { active: 0, stale: 4 });
  const h = await createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stubTagsFetch().fetchImpl } }).health();

  assert.equal(vectorCheck(h).status, "stale");
  assert.match(h.vector.reason, /^vector-lane stale: no active embeddings$/u);
  assert.equal(h.vector.detail.activeEmbeddings, 0);
  assert.equal(h.vector.detail.staleEmbeddings, 4);
  assert.equal(h.health, "degraded");
});

test("F2: probing disabled by configuration -> skipped, and no probe is issued", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-disabled");
  const h = await createMemoryLib({
    dataRoot,
    workspaceRoot: workspace,
    scopes: null,
    ollama: OLLAMA,
    vectorLane: { enabled: false, fetch: async () => { throw new Error("probe must not run when disabled"); } },
  }).health();

  assert.equal(vectorCheck(h).status, "skipped");
  assert.equal(h.vector.status, "skipped");
  assert.match(h.vector.reason, /disabled by configuration/u);
  // 目录检查全绿 -> 显式关闭探测时不额外降级，但状态明确标注 skipped（不冒充 ok）
  assert.equal(h.health, "healthy");
});

test("F2: probing is zero-write (no ledger file created, data root byte-identical)", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-zero-write", { active: 1 });
  const withLedger = await snapshotTree(workspace);
  await createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stubTagsFetch().fetchImpl } }).health();
  assert.deepEqual(diffSnapshots(withLedger, await snapshotTree(workspace)), [], "the health probe must not touch the ledger or the data root");

  const bare = await fixtureRoot("vector-zero-write-bare");
  const before = await snapshotTree(bare.workspace);
  const h = await createMemoryLib({ dataRoot: bare.dataRoot, workspaceRoot: bare.workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stubTagsFetch().fetchImpl } }).health();
  assert.equal(vectorCheck(h).status, "stale");
  assert.deepEqual(diffSnapshots(before, await snapshotTree(bare.workspace)), [], "a missing ledger must not be created by the probe");
});

test("zero-write diff: allowWal exempts -shm/-wal sidecars but still flags .sqlite changes", () => {
  const before = [
    { path: "ledger.sqlite", size: 100, mtimeMs: 1, sha256: "aaa" },
    { path: "ledger.sqlite-shm", size: 32, mtimeMs: 1, sha256: "bbb" },
    { path: "ledger.sqlite-wal", size: 64, mtimeMs: 1, sha256: "ccc" },
  ];
  const sidecarChurn = [
    { path: "ledger.sqlite", size: 100, mtimeMs: 1, sha256: "aaa" },
    { path: "ledger.sqlite-shm", size: 32768, mtimeMs: 999, sha256: "changed" },
    { path: "ledger.sqlite-wal", size: 128, mtimeMs: 999, sha256: "changed" },
  ];
  assert.deepEqual(diffSnapshots(before, sidecarChurn, { allowWal: true }), [], "WAL sidecar churn is exempted under allowWal");
  assert.equal(diffSnapshots(before, sidecarChurn).length, 2, "strict mode still reports sidecar changes");

  const corrupted = [
    { path: "ledger.sqlite", size: 999, mtimeMs: 999, sha256: "changed" },
    { path: "ledger.sqlite-shm", size: 32768, mtimeMs: 999, sha256: "changed" },
  ];
  const flagged = diffSnapshots(before, corrupted, { allowWal: true });
  assert.equal(flagged.length, 1, "the main .sqlite byte change must still be flagged");
  assert.equal(flagged[0].path, "ledger.sqlite");
});

test("F2: read-only probe on a WAL ledger keeps the .sqlite bytes identical", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-wal", { active: 2, wal: true });
  const before = await snapshotTree(workspace);
  await createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: OLLAMA, vectorLane: { fetch: stubTagsFetch().fetchImpl } }).health();
  const after = await snapshotTree(workspace);
  const changes = diffSnapshots(before, after, { allowWal: true });
  assert.deepEqual(changes.filter((change) => !/(?:-shm|-wal)$/u.test(change.path)), [], "only WAL sidecar files may change; the .sqlite must stay byte-identical");
  const beforeDb = before.find((f) => f.path.endsWith(".sqlite"));
  const afterDb = after.find((f) => f.path.endsWith(".sqlite"));
  assert.ok(beforeDb && afterDb, "the ledger .sqlite must be present before and after");
  assert.equal(afterDb.sha256, beforeDb.sha256, "the read-only probe must not alter the ledger .sqlite bytes");
});

// --- degraded state is observable through search ------------------------------

test("F2: degraded vector lane is distinguishable (health says down, no result claims the vector lane)", async () => {
  const { workspace, dataRoot } = await fixtureRoot("vector-observable", { active: 2 });
  // 真实 fetch 指向关闭的回环端口（同 contract.test.mjs 惯例）：本机 Ollama 状态不影响结果。
  const lib = createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes: null, ollama: CLOSED_OLLAMA });
  const h = await lib.health();
  assert.equal(vectorCheck(h).status, "down");
  assert.equal(h.health, "degraded");

  const results = await lib.search({ query: "原则" });
  assert.ok(results.length >= 1, "lexical lanes still serve results; the degradation is reported, not hidden");
  assert.deepEqual(results.filter((r) => (r.lanes ?? []).includes("vector")), [], "no result may claim the vector lane while health reports it down");
});

// --- HTTP surfaces -----------------------------------------------------------

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-vector-http-"));
created.push(TMP);
const TEST_AUTH = await createTestAuth(ROOT, TMP);
const DEV_SECRET = (await fs.readFile(path.join(TEST_AUTH.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");
const ADMIN = { agent_id: "admin-01", role_id: "librarian-admin" };
let ollamaUp = true;
const httpCalls = [];
const mutableStub = async (url, init = {}) => {
  httpCalls.push({ url: String(url), method: init.method ?? "GET" });
  if (!ollamaUp) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  return { status: 200, ok: true, json: async () => ({ models: [{ name: "nomic-embed-text:latest" }] }) };
};

const HTTP_WS = path.join(TMP, "workspace");
await fs.cp(path.join(here, "fixtures", "workspace"), HTTP_WS, { recursive: true });
const HTTP_DATA = path.join(HTTP_WS, "memory");
await Promise.all(["tools-memory", "plans", "profile", path.join("evidence", "documents"), path.join("evidence", "conversations")].map((relative) => fs.mkdir(path.join(HTTP_DATA, relative), { recursive: true })));
await Promise.all([path.join(HTTP_WS, "recovery", "policies"), path.join(HTTP_WS, "recovery", "plans")].map((directory) => fs.mkdir(directory, { recursive: true })));
await writeLedgerFixture(HTTP_DATA, { active: 2 });

adapterToClose = createLocalhostServer({
  libFactory: ({ scopes }) => createMemoryLib({ dataRoot: HTTP_DATA, workspaceRoot: HTTP_WS, scopes, ollama: OLLAMA, vectorLane: { fetch: mutableStub } }),
  registryPath: TEST_AUTH.registryPath,
  secretStore: TEST_AUTH.secretStore,
  auditPath: path.join(TMP, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
});
const addr = await adapterToClose.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

function adminCall(route) {
  return fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: TEST_AUTH.credentialRef, secret: DEV_SECRET, principal: ADMIN }),
  });
}

test("F2: GET /v1/health tracks ollama availability and stays path-free", async () => {
  ollamaUp = false;
  const downRes = await fetch(`${BASE}/v1/health`);
  assert.equal(downRes.status, 200, "a dead vector lane must not turn /v1/health into a 5xx");
  const down = await downRes.json();
  assert.equal(down.health, "degraded");
  assert.equal(down.vector.status, "down");
  assert.match(down.vector.reason, /^vector-lane down: ollama unreachable$/u);
  assert.equal(down.service, "memory-lib");
  assert.equal("roots" in down, false, "weak health must not expose roots");
  assert.equal("dataRoot" in down, false, "weak health must not expose the data root");
  assert.equal("checks" in down, false, "weak health stays minimal (no path-bearing check list)");
  assert.deepEqual(filesystemPathLeak(down), [], "weak health must not leak filesystem paths");

  ollamaUp = true;
  const up = await (await fetch(`${BASE}/v1/health`)).json();
  assert.equal(up.health, "healthy");
  assert.equal(up.vector.status, "ok");
  assert.ok(httpCalls.length >= 2, "each health call probes the vector lane");
});

test("F2: POST /v1/admin/health checks include vector-lane", async () => {
  ollamaUp = true;
  const res = await adminCall("/v1/admin/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  const check = data.checks.find((c) => c.name === "vector-lane");
  assert.ok(check, `admin health checks must include vector-lane: ${JSON.stringify(data.checks)}`);
  assert.equal(check.status, "ok");
  assert.match(check.reason, /vector-lane ok/u);
  assert.equal(data.vector.status, "ok");
  assert.equal(data.health, "healthy");
  assert.ok(data.checks.length >= 10, "current directory checks plus the vector lane");
});
