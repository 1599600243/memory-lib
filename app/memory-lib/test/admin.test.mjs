// memory-lib — management API (admin) tests.
// Run directly: node test/admin.test.mjs
// Uses TEMP copies of the fixture workspace and the identity registry so the
// checked-in dev registry / fixture stay pristine (revoke/activate mutate the registry).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { snapshotTree, diffSnapshots } from "../scripts/zero-write-check.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-admin-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
await Promise.all([
  path.join(TMP, "workspace", "recovery", "policies"),
  path.join(TMP, "workspace", "recovery", "plans"),
  path.join(TMP, "workspace", "memory", "tools-memory"),
  path.join(TMP, "workspace", "memory", "plans"),
  path.join(TMP, "workspace", "memory", "profile"),
  path.join(TMP, "workspace", "memory", "evidence", "documents"),
  path.join(TMP, "workspace", "memory", "evidence", "conversations"),
].map((directory) => fs.mkdir(directory, { recursive: true })));
const TEST_AUTH = await createTestAuth(ROOT, TMP);

const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const REGISTRY_PATH = TEST_AUTH.registryPath;
const SECRET_STORE = TEST_AUTH.secretStore;
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const CREDENTIAL_REF = TEST_AUTH.credentialRef;
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

const ADMIN = { agent_id: "admin-01", role_id: "librarian-admin" };
const READER = { agent_id: "pilot-01", role_id: "reader" };
const RESEARCHER = { agent_id: "pilot-01", role_id: "researcher" };

// F2: health() 只读探测向量车道 —— 显式注入 stub 并声明本 fixture 无 ledger，
// 使 admin 健康检查与测试机器上是否跑着 Ollama 无关。
const libFactory = ({ scopes }) => createMemoryLib({
  dataRoot: FIXTURE_DATA,
  workspaceRoot: FIXTURE_WORKSPACE,
  scopes,
  vectorLane: {
    requireIndex: false,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "bge-m3:latest" }] }) }),
  },
});
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

async function call(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const adminCall = (route, extra = {}) => call(route, { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: ADMIN, ...extra });

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("admin status codes distinguish 401, 403, and 404", async () => {
  const missing = await call("/v1/admin/health", { principal: READER });
  assert.equal(missing.status, 401);
  assert.equal(missing.data.error.code, "UNAUTHENTICATED");
  const reader = await call("/v1/admin/health", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER });
  assert.equal(reader.status, 403);
  assert.equal(reader.data.error.detail, "ACTION_DENIED");
  const unknown = await adminCall("/v1/admin/does-not-exist");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, "NOT_FOUND");
});

test("admin health -> 200 with checks (including the F2 vector lane)", async () => {
  const { status, data } = await adminCall("/v1/admin/health");
  assert.equal(status, 200);
  assert.equal(data.health, "healthy");
  assert.ok(Array.isArray(data.checks) && data.checks.length > 0);
  const vector = data.checks.find((c) => c.name === "vector-lane");
  assert.ok(vector, "admin health checks must include vector-lane");
  assert.equal(vector.status, "ok");
  assert.equal(data.vector.status, "ok");
});

test("public health exposes the current minimal status shape", async () => {
  const health = await fetch(`${BASE}/v1/health`).then((res) => res.json());
  assert.equal(health.service, "memory-lib");
  assert.ok(["healthy", "reduced", "degraded"].includes(health.health));
  assert.ok(health.index && typeof health.index.indexed_files === "number");
  assert.ok(health.vector && ["ok", "skipped", "down", "stale"].includes(health.vector.status));
  assert.equal("consolidation" in health, false);
});

test("admin registry -> no secrets, shows agents/roles", async () => {
  const { status, data } = await adminCall("/v1/admin/registry");
  assert.equal(status, 200);
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes("secret:") && !raw.includes("SECRET"), "registry view must not contain secrets");
  assert.ok(!raw.includes(DEV_SECRET), "registry view must not contain the actual secret");
  const dsh = data.frameworks.find((f) => f.framework_id === "deepseek-harness");
  assert.ok(dsh);
  assert.equal(dsh.credential_status, "active");
  assert.ok(dsh.agents.some((a) => a.agent_id === "admin-01" && a.roles.some((r) => r.role_id === "librarian-admin")));
  assert.ok(dsh.agents.some((a) => a.agent_id === "pilot-01"));
  assert.ok(Array.isArray(data.accounts), "registry view should expose only safe account metadata");
  assert.ok(!raw.includes("hash_b64") && !raw.includes("salt_b64"), "registry view must not expose password hashes");
  assert.ok(Array.isArray(data.accounts) || !("accounts" in data), "account metadata may be exposed only as a safe registry view");
});

test("admin revoke -> normal request 401 REVOKED; activate -> works again", async () => {
  const revoke = await adminCall("/v1/admin/registry/revoke", { framework_id: "deepseek-harness" });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.data.status, "revoked");

  const denied = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: RESEARCHER, query: "x" });
  assert.equal(denied.status, 401);
  assert.equal(denied.data.error.code, "REVOKED");

  const activate = await adminCall("/v1/admin/registry/activate", { framework_id: "deepseek-harness" });
  assert.equal(activate.status, 200);
  assert.equal(activate.data.status, "active");

  const ok = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: RESEARCHER, query: "原则" });
  assert.equal(ok.status, 200);
});

test("admin revoke unknown framework -> 404", async () => {
  const { status, data } = await adminCall("/v1/admin/registry/revoke", { framework_id: "nobody" });
  assert.equal(status, 404);
  assert.equal(data.error.code, "NOT_FOUND");
});

test("admin audit -> returns recorded events, including admin denies", async () => {
  const { status, data } = await adminCall("/v1/admin/audit", { limit: 50 });
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.events) && data.events.length > 0);
  const denied = data.events.find((e) => e.denyReason === "ACTION_DENIED");
  assert.ok(denied, "admin authorization denial remains auditable");
  for (const ev of data.events) {
    assert.ok(!JSON.stringify(ev).includes(DEV_SECRET), "audit must not contain secrets");
  }
});

test("admin ops are zero-write on curated", async () => {
  const before = await snapshotTree(path.join(FIXTURE_DATA, "curated"));
  await adminCall("/v1/admin/inbox");
  await adminCall("/v1/admin/registry");
  await adminCall("/v1/admin/audit");
  const after = await snapshotTree(path.join(FIXTURE_DATA, "curated"));
  assert.deepEqual(diffSnapshots(before, after), [], "curated must be untouched");
});

// MAINT11：四个"调用点存在、实现从未存在"的死路径必须返回 410（不是 500）。
// 这些能力在 D29 被整体删除（steward / 候选链 / librarian maintenance），路由仍留在 API 面上，
// 目的是让旧调用方拿到明确的"这东西没了"，而不是一个 500。
test("removed D29 endpoints answer 410 GONE, never 500", async () => {
  const cases = [
    ["/v1/agents/steward/run", "STEWARD_REMOVED"],
    ["/v1/admin/maintenance/run", "MAINTENANCE_RUN_REMOVED"],
    ["/v1/admin/inbox", "INBOX_REMOVED"],
    ["/v1/admin/inbox/read", "INBOX_REMOVED"],
  ];
  for (const [route, detail] of cases) {
    const res = await adminCall(route);
    assert.equal(res.status, 410, `${route} must answer 410, got ${res.status} ${JSON.stringify(res.data)}`);
    assert.equal(res.data.ok, false, `${route} must not report ok`);
    assert.equal(res.data.error.code, "GONE", `${route} must use code GONE`);
    assert.equal(res.data.error.detail, detail, `${route} must carry a machine-readable detail`);
    assert.ok(res.data.error.message.length > 20, `${route} message must explain why (got ${JSON.stringify(res.data.error.message)})`);
  }
  // 对照：真正存在的 admin 路由仍是 200，说明 410 不是"整段路由坏了"
  const health = await adminCall("/v1/admin/health");
  assert.equal(health.status, 200);
});
