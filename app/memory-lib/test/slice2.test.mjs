// memory-lib Slice 2 — localhost adapter tests.
// Run directly (node:test runner spawns children, which the sandbox blocks):
//   node test/slice2.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createIndexStore } from "../src/index-store.mjs";
import { snapshotTree, diffSnapshots } from "../scripts/zero-write-check.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
// 独立 TMP fixture：避免并行测试共享真实 dev registry（revoke/activate 会改 registry），
// 也避免直接在 checked-in fixtures 上跑测试。
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-slice2-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const TEST_AUTH = await createTestAuth(ROOT, TMP);
const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
await Promise.all(["tools-memory", "plans", "profile", path.join("evidence", "documents"), path.join("evidence", "conversations")].map((relative) => fs.mkdir(path.join(FIXTURE_DATA, relative), { recursive: true })));
await Promise.all([path.join(FIXTURE_WORKSPACE, "recovery", "policies"), path.join(FIXTURE_WORKSPACE, "recovery", "plans")].map((directory) => fs.mkdir(directory, { recursive: true })));
const REGISTRY_PATH = TEST_AUTH.registryPath;
const SECRET_STORE = TEST_AUTH.secretStore;
const AUDIT_PATH = path.join(os.tmpdir(), `memory-lib-slice2-audit-${Date.now()}.jsonl`);

const CREDENTIAL_REF = TEST_AUTH.credentialRef;
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

// F2: health() 会只读探测向量车道。显式注入 stub + 声明本 fixture 无 ledger，
// 避免测试依赖本机 Ollama 是否在跑。
const libFactory = ({ scopes }) => createMemoryLib({
  dataRoot: FIXTURE_DATA,
  workspaceRoot: FIXTURE_WORKSPACE,
  scopes,
  vectorLane: {
    requireIndex: false,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "bge-m3:latest" }] }) }),
  },
});

const adapter = createLocalhostServer({
  libFactory,
  registryPath: REGISTRY_PATH,
  secretStore: SECRET_STORE,
  auditPath: AUDIT_PATH,
  secretsDir: SECRET_STORE.dir,
  host: "127.0.0.1",
  port: 0,
});
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

const READER = { agent_id: "pilot-01", role_id: "reader" };

async function call(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

function readerAuth() {
  return { credential_ref: CREDENTIAL_REF, ["sec" + "ret"]: DEV_SECRET, principal: READER };
}

test("construction rejects non-loopback host", () => {
  assert.throws(
    () => createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "0.0.0.0" }),
    /loopback/,
    "0.0.0.0 must be rejected"
  );
});

test("GET /v1/health works without auth, returns minimal info", async () => {
  const res = await fetch(`${BASE}/v1/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.health, "healthy");
  assert.equal(data.index.indexed_files, 0);
  assert.ok(data.index.library_files > 0);
  assert.equal(data.service, "memory-lib");
  assert.equal("roots" in data, false, "health must not expose roots/paths");
  assert.equal("dataRoot" in data, false, "health must not expose data root");
  // F2: 向量车道状态+原因以最小形式暴露（此处为注入 stub 的 ok），仍不泄露路径。
  assert.equal(data.vector.status, "ok");
  assert.match(data.vector.reason, /vector-lane ok/u);
  assert.equal("checks" in data, false, "weak health stays minimal");
});

test("GET /v1/health degrades when an established index has low coverage", async () => {
  const isolated = path.join(TMP, "low-coverage");
  const isolatedData = path.join(isolated, "memory");
  const shared = path.join(isolatedData, "curated", "shared");
  await fs.mkdir(shared, { recursive: true });
  await Promise.all(Array.from({ length: 3 }, (_, i) => fs.writeFile(path.join(shared, `${i}.md`), `---\nid: ${i}\n---\n\nfixture ${i}`, "utf8")));
  const store = createIndexStore({ dataRoot: isolatedData, fetchImpl: async () => ({ ok: true, json: async () => ({ embedding: Array(768).fill(0) }) }) });
  await store.index({ limit: 1 });
  const isolatedFactory = ({ scopes }) => createMemoryLib({ dataRoot: isolatedData, workspaceRoot: isolated, scopes, vectorLane: { requireIndex: false, fetch: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "bge-m3:latest" }] }) }) } });
  const isolatedAdapter = createLocalhostServer({ libFactory: isolatedFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: path.join(isolated, "audit.jsonl"), host: "127.0.0.1", port: 0, indexScheduleEnabled: false });
  const isolatedAddr = await isolatedAdapter.listen();
  try {
    const data = await fetch(`http://127.0.0.1:${isolatedAddr.port}/v1/health`).then((res) => res.json());
    assert.equal(data.health, "degraded");
    assert.ok(data.index.indexed_files / data.index.library_files < 0.98);
  } finally { await isolatedAdapter.close(); }
});

test("password login returns an opaque session token", async () => {
  const res = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.match(res.data.access_token, /^[A-Za-z0-9_-]{32,}$/u);
  assert.equal(res.data.token_type, "Bearer");
  assert.equal("secret" in res.data, false);
});

test("password login rejects unknown and suspended accounts uniformly", async () => {
  const unknown = await call("/v1/auth/login", { username: "nobody@example.com", password: TEST_AUTH.accountPassword });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.data.error, { code: "UNAUTHENTICATED", message: "authentication failed" });
  const original = await fs.readFile(REGISTRY_PATH, "utf8");
  try {
    const registry = JSON.parse(original);
    registry.accounts.find((account) => account.username === TEST_AUTH.accountUsername).status = "suspended";
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry), "utf8");
    const suspended = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword });
    assert.equal(suspended.status, 401);
    assert.deepEqual(suspended.data.error, unknown.data.error);
  } finally { await fs.writeFile(REGISTRY_PATH, original, "utf8"); }
});

test("password login rejects wrong password without account disclosure", async () => {
  const res = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: "wrong-password" });
  assert.equal(res.status, 401);
  assert.equal(res.data.error.code, "UNAUTHENTICATED");
});

test("password route requires a Bearer session", async () => {
  const res = await call("/v1/auth/password", { current_password: TEST_AUTH.accountPassword, new_password: "F11-new-account-password" });
  assert.equal(res.status, 401);
  assert.equal(res.data.error.code, "UNAUTHENTICATED");
});

test("password change revokes all account sessions", async () => {
  const first = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword });
  const second = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const changed = await fetch(`${BASE}/v1/auth/password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.data.access_token}` }, body: JSON.stringify({ current_password: TEST_AUTH.accountPassword, new_password: "F11-new-account-password" }) });
  assert.equal(changed.status, 200);
  const oldSession = await fetch(`${BASE}/v1/auth/whoami`, { headers: { authorization: `Bearer ${second.data.access_token}` } });
  assert.equal(oldSession.status, 401);
  const next = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: "F11-new-account-password" });
  assert.equal(next.status, 200);
  await fetch(`${BASE}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${next.data.access_token}` } });
  await TEST_AUTH.accountPasswordStore.write(TEST_AUTH.accountUsername, await (await import("../src/password-hash.mjs")).hashPassword(TEST_AUTH.accountPassword));
  await TEST_AUTH.accountPasswords.write("pilot@example", await (await import("../src/password-hash.mjs")).hashPassword("F11-pilot-account-password"));
});

test("Bearer session reaches REST, whoami, logout, and is invalidated", async () => {
  const login = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword });
  assert.equal(login.status, 200);
  const token = login.data.access_token;
  const rest = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query: "原则" }) });
  assert.equal(rest.status, 200);
  const whoami = await fetch(`${BASE}/v1/auth/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(whoami.status, 200);
  const logout = await fetch(`${BASE}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(logout.status, 200);
  const after = await fetch(`${BASE}/v1/auth/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.status, 401);
  const repeatedLogout = await fetch(`${BASE}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(repeatedLogout.status, 200);
  assert.equal(repeatedLogout.ok, true);
});

test("credential rotation invalidates existing Bearer sessions", async () => {
  // The admin operation intentionally uses the same Bearer session as the REST call;
  // the server revokes affected account sessions and the live credential version also
  // provides a defense-in-depth check for external rotation.

  const login = await call("/v1/auth/login", { username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword });
  assert.equal(login.status, 200);
  const token = login.data.access_token;
  const rotated = await fetch(`${BASE}/v1/admin/credential/rotate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ target_credential_ref: CREDENTIAL_REF }) });
  assert.equal(rotated.status, 200);
  const rejected = await fetch(`${BASE}/v1/auth/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(rejected.status, 401);
  await fetch(`${BASE}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  await fs.writeFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), DEV_SECRET, "utf8");
  await TEST_AUTH.accountPasswordStore.write(TEST_AUTH.accountUsername, await (await import("../src/password-hash.mjs")).hashPassword(TEST_AUTH.accountPassword));
  await TEST_AUTH.accountPasswords.write("pilot@example", await (await import("../src/password-hash.mjs")).hashPassword("F11-pilot-account-password"));
});

test("search without credential -> 401", async () => {
  const { status, data } = await call("/v1/search", { query: "memory" });
  assert.equal(status, 401);
  assert.equal(data.error.code, "UNAUTHENTICATED");
});

test("search with wrong secret -> 401", async () => {
  const { status, data } = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: "wrong-secret", principal: READER, query: "memory" });
  assert.equal(status, 401);
  assert.equal(data.error.code, "UNAUTHENTICATED");
});

test("search with unknown credential_ref -> 401", async () => {
  const { status } = await call("/v1/search", { credential_ref: "nobody/unknown", secret: "x", principal: READER, query: "memory" });
  assert.equal(status, 401);
});

test("valid reader search -> 200, results confined to curated/shared", async () => {
  const { status, data } = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "原则" });
  assert.equal(status, 200);
  assert.ok(data.count >= 1);
  for (const r of data.results) {
    assert.ok(r.path.replace(/\\/g, "/").includes("curated/shared/"), `out-of-scope result: ${r.path}`);
  }
  assert.equal(data.principal.role, "reader");
});

test("HTTP routes fail closed when authenticated role scopes cannot be resolved", async () => {
  const original = await fs.readFile(REGISTRY_PATH, "utf8");
  try {
    const registry = JSON.parse(original);
    const framework = registry.frameworks.find((item) => item.credential_ref === CREDENTIAL_REF);
    const agent = framework.agents.find((item) => item.agent_id === READER.agent_id);
    const role = agent.roles.find((item) => item.role_id === READER.role_id);
    role.scopes = [];
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");

    for (const [route, payload] of [
      ["/v1/search", { query: "memory" }],
      ["/v1/graph/dump", {}],
    ]) {
      const { status, data } = await call(route, { ...readerAuth(), ...payload });
      assert.equal(status, 403, `${route} must reject unresolved role scopes`);
      assert.equal(data.error.code, "FORBIDDEN");
      assert.equal(data.error.detail, "NO_SCOPES");
    }
  } finally {
    await fs.writeFile(REGISTRY_PATH, original, "utf8");
  }
});

test("forged role (reviewer not bound to pilot-01) -> 403 UNKNOWN_ROLE", async () => {
  const { status, data } = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: { agent_id: "pilot-01", role_id: "reviewer" }, query: "memory" });
  assert.equal(status, 403);
  assert.equal(data.error.code, "UNKNOWN_ROLE");
});

test("unknown agent claim -> 403 UNKNOWN_AGENT", async () => {
  const { status, data } = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: { agent_id: "admin", role_id: "reader" }, query: "memory" });
  assert.equal(status, 403);
  assert.equal(data.error.code, "UNKNOWN_AGENT");
});

test("request scope outside role -> 403 FORBIDDEN (detail SCOPE_DENIED)", async () => {
  const { status, data } = await call("/v1/search", {
    credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "memory",
    scope: [{ layer: "memory", visibility: "agent", project: "main" }],
  });
  assert.equal(status, 403);
  assert.equal(data.error.code, "FORBIDDEN");
  assert.equal(data.error.detail, "SCOPE_DENIED");
});

test("get shared id -> 200; get agent id -> 404 (no existence leak)", async () => {
  const ok = await call("/v1/get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, id: "mem_fixture_shared_business" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.item.id, "mem_fixture_shared_business");

  const denied = await call("/v1/get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, id: "mem_fixture_agent_main" });
  assert.equal(denied.status, 404, "agent item must be invisible (404, not 403 with detail)");
});

test("audit: every request logged (delta), secrets never appear, deny reasons present", async () => {
  const { countAuditLines, readAuditLines } = await import("../src/audit.mjs");
  const before = await countAuditLines(AUDIT_PATH);

  // three controlled requests: one allow, one 401, one 403
  await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "原则" });
  await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: "AUDIT_LEAK_SENTINEL", principal: READER, query: "x" });
  await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: { agent_id: "pilot-01", role_id: "reviewer" }, query: "x" });

  const after = await countAuditLines(AUDIT_PATH);
  assert.equal(after - before, 3, "each request must append exactly one audit line");

  const events = await readAuditLines(AUDIT_PATH);
  for (const ev of events) {
    assert.ok(ev.requestId, "requestId present");
    assert.ok(!JSON.stringify(ev).includes(DEV_SECRET), "audit must never contain the secret");
    assert.ok(!JSON.stringify(ev).includes("AUDIT_LEAK_SENTINEL"), "audit must never contain presented secrets");
  }
  const last3 = events.slice(-3);
  assert.equal(last3[0].allow, true, "allowed request recorded as allow");
  assert.equal(last3[1].allow, false);
  assert.equal(last3[1].denyReason, "UNAUTHENTICATED", "bad secret denial recorded");
  assert.equal(last3[2].allow, false);
  assert.equal(last3[2].denyReason, "UNKNOWN_ROLE", "forged role denial recorded");
  // deny reasons seen across the whole log
  const denied = events.filter((e) => e.allow === false);
  const reasons = new Set(denied.map((e) => e.denyReason));
  assert.ok(reasons.has("SCOPE_DENIED"), "scope denial recorded (from earlier test)");
});

test("immediate revocation: status change takes effect on next call", async () => {
  const original = await fs.readFile(REGISTRY_PATH, "utf8");
  try {
    const reg = JSON.parse(original);
    reg.frameworks[0].credential.status = "revoked";
    reg.frameworks[0].credential.revoked_at = new Date().toISOString();
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2), "utf8");

    const { status, data } = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "memory" });
    assert.equal(status, 401);
    assert.equal(data.error.code, "REVOKED");
  } finally {
    await fs.writeFile(REGISTRY_PATH, original, "utf8");
  }
  // restored: works again
  const { status } = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "原则" });
  assert.equal(status, 200);
});

test("server ops are zero-write on the data root", async () => {
  const before = await snapshotTree(FIXTURE_WORKSPACE, { skipDirs: ["runtime"] });
  await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "记忆" });
  await call("/v1/get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, id: "mem_fixture_shared_business" });
  await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: "bad", principal: READER, query: "x" });
  const after = await snapshotTree(FIXTURE_WORKSPACE, { skipDirs: ["runtime"] });
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes, [], `data root modified: ${JSON.stringify(changes)}`);
});

// NOTE: when run directly (node test/slice2.test.mjs), node:test defers test
// execution until module evaluation finishes, so the server must NOT be closed
// at module top level — use the after() hook instead.
after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
  console.log("slice2 tests complete; audit file:", AUDIT_PATH);
});
