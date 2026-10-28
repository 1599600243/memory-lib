import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m16-daily-"));
const auth = await createTestAuth(root, tmp);
const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const framework = identity.frameworks.find((item) => item.credential_ref === auth.credentialRef);
for (const [agentId, roleId] of [["home-owner-agent", "home-owner-agent"], ["home-friend-agent", "home-friend-agent"], ["ops-agent", "ops-agent"], ["ops-collector", "ops-collector"]]) {
  framework.agents.push({ agent_id: agentId, roles: [{ role_id: roleId, scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "user", project: `${agentId}-user` }, { layer: "memory", visibility: "agent", project: roleId }], actions: ["search", "get", "propose"] }] });
}
await fs.writeFile(auth.registryPath, JSON.stringify(identity, null, 2) + "\n", "utf8");
const apiKeyFile = path.join(tmp, "api-keys.json");
await fs.writeFile(apiKeyFile, JSON.stringify({ version: 1, groups: [{ id: "home", name: "home" }, { id: "ops", name: "ops" }], users: [{ id: "home-owner-user", name: "owner", group_id: "home" }, { id: "home-friend-user", name: "friend", group_id: "home" }, { id: "ops-user", name: "ops", group_id: "ops" }, { id: "ops-collector-user", name: "collector", group_id: "ops" }], roles: [{ id: "home-owner-agent", name: "home-owner-agent", user_id: "home-owner-user", group_id: "home" }, { id: "home-friend-agent", name: "home-friend-agent", user_id: "home-friend-user", group_id: "home" }, { id: "ops-agent", name: "ops-agent", user_id: "ops-user", group_id: "ops" }, { id: "ops-collector", name: "ops-collector", user_id: "ops-collector-user", group_id: "ops" }], api_keys: [] }) + "\n", "utf8");
const dataRoot = path.join(tmp, "memory");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"), apiKeyFile, apiKeyPepper: "m16-pepper", host: "127.0.0.1", port: 0, indexRefreshIntervalMinutes: 10,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const admin = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } };
const keys = {};
for (const [role, group, user] of [["home-owner-agent", "home", "home-owner-user"], ["home-friend-agent", "home", "home-friend-user"], ["ops-agent", "ops", "ops-user"], ["ops-collector", "ops", "ops-collector-user"]]) {
  const response = await fetch(`${base}/v1/admin/roles/${role}/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...admin, group_id: group, group_name: group, user_id: user, user_name: user }) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  keys[role] = data.key.secret;
}
async function call(route, body, token) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function search(token, query) { return call("/v1/search", { query, limit: 20 }, token); }
test.after(async () => { await adapter.close(); for (let i = 0; i < 8; i += 1) { try { await fs.rm(tmp, { recursive: true, force: true }); break; } catch (error) { if (error.code !== "EBUSY" || i === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); } } });

test("M1.6【契约变更】shared/user 写入：自报身份不匹配 ⇒ 403；匹配 ⇒ 200 且按 principal 作用域可检索", async () => {
  // 【契约变更 WRITE-DENY-1-REJECT2（裁决2）】旧契约：body 里的 agent/role 被忽略（200）。
  // 新契约：与服务端 principal 不匹配 ⇒ 403 IDENTITY_MISMATCH。匹配时行为不变（正对照见下）。
  const spoofed = await call("/v1/write", { visibility: "shared", id: "m16-shared-spoof", body: "M16 spoof sentinel", evidence_refs: ["evidence:m16-shared"], agent: "spoof-agent", role_id: "spoof-role" }, keys["home-owner-agent"]);
  assert.equal(spoofed.status, 403, `spoofed identity must be refused: ${JSON.stringify(spoofed.data)}`);
  assert.equal(spoofed.data.error.detail, "IDENTITY_MISMATCH", `${JSON.stringify(spoofed.data)}`);

  const shared = await call("/v1/write", { visibility: "shared", id: "m16-shared", body: "M16 shared home sentinel", evidence_refs: ["evidence:m16-shared"] }, keys["home-owner-agent"]);
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  assert.ok(["created", "updated"].some((key) => shared.data[key]));
  const ownerShared = await search(keys["home-owner-agent"], "M16 shared home sentinel");
  const friendShared = await search(keys["home-friend-agent"], "M16 shared home sentinel");
  const opsShared = await search(keys["ops-agent"], "M16 shared home sentinel");
  const collectorShared = await search(keys["ops-collector"], "M16 shared home sentinel");
  for (const result of [ownerShared, friendShared, opsShared, collectorShared]) assert.equal(result.status, 200, JSON.stringify(result.data));
  const has = (result, id) => result.data.results.some((item) => item.id === id || item.path.endsWith(`${id}.md`));
  assert.ok(has(ownerShared, "m16-shared"), JSON.stringify({ write: shared.data, owner: ownerShared.data }));
  const sharedText = await fs.readFile(shared.data.path, "utf8");
  assert.ok(has(friendShared, "m16-shared"), JSON.stringify({ friend: friendShared.data, owner: ownerShared.data, sharedText }));
  assert.equal(has(opsShared, "m16-shared"), false);
  assert.equal(has(collectorShared, "m16-shared"), false);

  const user = await call("/v1/write", { visibility: "user", id: "m16-user", body: "M16 owner user sentinel", evidence_refs: ["evidence:m16-user"] }, keys["home-owner-agent"]);
  assert.equal(user.status, 200, JSON.stringify(user.data));
  const ownerUser = await search(keys["home-owner-agent"], "M16 owner user sentinel");
  const friendUser = await search(keys["home-friend-agent"], "M16 owner user sentinel");
  assert.equal(ownerUser.status, 200); assert.equal(friendUser.status, 200);
  assert.ok(has(ownerUser, "m16-user"));
  assert.equal(has(friendUser, "m16-user"), false);
  const fm = await fs.readFile(path.join(dataRoot, "curated", "shared", "m16-user.md"), "utf8");
  assert.match(fm, /group_id: "home"/u); assert.match(fm, /user_id: "home-owner-user"/u); assert.doesNotMatch(fm, /home-friend-user/u);
});

test("M1.6 invalid visibility and platform escalation are rejected", async () => {
  // WRITE-DENY-1：显式 platform 是**写授权**拒绝，不是"输入不合法" —— 403 + WRITE_SCOPE_DENIED，
  // detail 点名"要 admin"，与提炼提交门禁同一口径（旧实现把它和不合法的可见性名字一起回 400）。
  const platform = await call("/v1/write", { visibility: "platform", id: "m16-denied-platform", body: "denied", evidence_refs: ["evidence:m16-platform"], group_id: "ops", user_id: "ops-user" }, keys["home-owner-agent"]);
  assert.equal(platform.status, 403, `platform: ${JSON.stringify(platform.data)}`);
  assert.equal(platform.data.error.code, "WRITE_SCOPE_DENIED", `platform: ${JSON.stringify(platform.data)}`);
  assert.equal(platform.data.error.detail, "PLATFORM_REQUIRES_ADMIN", `platform: ${JSON.stringify(platform.data)}`);

  // 不存在的可见性名字仍然是 400 BAD_REQUEST / WRITE_REJECTED（这两件事不许被合并掉）。
  for (const visibility of ["other-user", "other-group"]) {
    const result = await call("/v1/write", { visibility, id: `m16-denied-${visibility}`, body: "denied", evidence_refs: [`evidence:m16-${visibility}`], group_id: "ops", user_id: "ops-user" }, keys["home-owner-agent"]);
    assert.equal(result.status, 400, `${visibility}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.error.code, "BAD_REQUEST", `${visibility}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.error.detail, "WRITE_REJECTED", `${visibility}: ${JSON.stringify(result.data)}`);
  }
});

test("M1.6 three consecutive writes are all indexed by the write response", async () => {
  const started = Date.now();
  for (const id of ["m16-burst-1", "m16-burst-2", "m16-burst-3"]) {
    const result = await call("/v1/write", { visibility: "shared", id, body: `M16 burst ${id}`, evidence_refs: [`evidence:${id}`] }, keys["home-owner-agent"]);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const found = await search(keys["home-friend-agent"], `M16 burst ${id}`);
    assert.ok(found.data.results.some((item) => item.id === id || item.path.endsWith(`${id}.md`)), `${id} not searchable: ${JSON.stringify(found.data)}`);
  }
  assert.ok(Date.now() - started < 5000, "burst writes should complete within the M1.6 five-second budget");
});
