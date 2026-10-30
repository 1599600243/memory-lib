import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { createTestAuth } from "./test-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m14-http-e2e-"));
const auth = await createTestAuth(root, tmp);
const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
// WRITE-DENY-1：写者 role-a 窄口径持有 project:m14-real-http（project 可见性写入的前提）；role-b 不持有，
// 所以 keyB 的 graph/joint 负对照仍然断言"看不见"。
identity.frameworks[0].agents.push({ agent_id: "role-a", roles: [{ role_id: "role-a", scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "m14-real-http" }], actions: ["search", "get", "propose"] }] }, { agent_id: "role-b", roles: [{ role_id: "role-b", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get", "propose"] }] });
await fs.writeFile(auth.registryPath, JSON.stringify(identity, null, 2) + "\n");
await fs.writeFile(path.join(tmp, "api-keys.json"), JSON.stringify({ version: 1, groups: [{ id: "group-a", name: "group-a" }, { id: "group-b", name: "group-b" }], users: [{ id: "group-a-user", name: "group-a", group_id: "group-a" }, { id: "group-b-user", name: "group-b", group_id: "group-b" }], roles: [{ id: "role-a", name: "role-a", user_id: "group-a-user", group_id: "group-a" }, { id: "role-b", name: "role-b", user_id: "group-b-user", group_id: "group-b" }, { id: "librarian-admin", name: "librarian-admin", user_id: "group-a-user", group_id: "group-a" }], api_keys: [] }, null, 2));
const dataRoot = path.join(tmp, "memory");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes, agentId, roleId, principal, audit }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"),
  apiKeyFile: path.join(tmp, "api-keys.json"), apiKeyPepper: "m14-http-pepper", host: "127.0.0.1", port: 0,
  indexRefreshIntervalMinutes: 0.001,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const adminBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } };
const createKey = async (role, group) => {
  const response = await fetch(`${base}/v1/admin/roles/${role}/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...adminBody, group_id: group, group_name: group, user_id: `${group}-user`, user_name: group }) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data.key.secret;
};
const keyAdmin = await createKey("librarian-admin", "group-a");
const keyA = await createKey("role-a", "group-a");
const keyB = await createKey("role-b", "group-b");
async function call(route, body, token) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function health(token) {
  const response = await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, data: await response.json() };
}
async function waitForIndex() {
  for (let i = 0; i < 80; i += 1) {
    const healthResult = await health(keyA);
    if (healthResult.data?.index?.last_status === "completed" && healthResult.data.index.pending_changes === 0 && healthResult.data.index.failed === 0) return healthResult;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("index did not complete through scheduled refresh");
}
test.after(async () => {
  await adapter.close();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await fs.rm(tmp, { recursive: true, force: true }); break; }
    catch (error) { if (error.code !== "EBUSY" || attempt === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
});

test("M1.4 real HTTP project writer feeds tenant-filtered FTS/vector and graph reads", async () => {
  const write = await call("/v1/project/decision", {
    project: "m14-real-http", slug: "decision", sections: { "决定": "M14 real HTTP searchable decision", "理由": "真实 API key route", "影响": "joint and graph" }, evidence_refs: ["evidence:m14-http"], tenant_id: "spoofed-tenant", group_id: "spoofed-group", principal: { tenant_id: "spoofed-tenant", group_id: "spoofed-group" },
  }, keyA);
  assert.equal(write.status, 200, JSON.stringify(write.data));
  const file = path.join(dataRoot, "project-state", "m14-real-http", "decisions", "2026-01-01-decision.md");
  const files = await fs.readdir(path.dirname(file));
  const actual = path.join(path.dirname(file), files[0]);
  const { frontmatter } = parseFrontmatterTyped(await fs.readFile(actual, "utf8"));
  assert.equal(frontmatter.tenant_id, "default");
  assert.equal(frontmatter.group_id, "group-a");
  await waitForIndex();
  const joint = await call("/v1/search/joint", { query: "M14 real HTTP searchable decision", tenant_id: "spoofed-tenant", group_id: "spoofed-group", principal: { tenant_id: "spoofed-tenant" } }, keyA);
  assert.equal(joint.status, 200, JSON.stringify(joint.data));
  const hit = joint.data.results.find((row) => row.id === write.data.id || row.path === actual);
  assert.ok(hit, JSON.stringify(joint.data));
  assert.ok(hit.matched_by.includes("fts"), JSON.stringify(hit));
  assert.ok(hit.matched_by.includes("vector"), JSON.stringify(hit));
  const graph = await call("/v1/graph/query", { project_id: "m14-real-http", tenant_id: "spoofed-tenant", group_id: "spoofed-group", principal: { tenant_id: "spoofed-tenant" } }, keyA);
  assert.equal(graph.status, 200, JSON.stringify(graph.data));
  assert.deepEqual(graph.data.graph.memories, [write.data.id]);
  const otherJoint = await call("/v1/search/joint", { query: "M14 real HTTP searchable decision" }, keyB);
  assert.equal(otherJoint.status, 200, JSON.stringify(otherJoint.data));
  assert.equal(otherJoint.data.results.some((row) => row.id === write.data.id || row.path === actual), false);
  const otherGraph = await call("/v1/graph/query", { project_id: "m14-real-http" }, keyB);
  assert.equal(otherGraph.status, 200, JSON.stringify(otherGraph.data));
  assert.deepEqual(otherGraph.data.graph.memories, []);
});

test("M1.4 real HTTP rewrite entrypoints preserve body and fields", async () => {
  const progress = await call("/v1/write", {
    layer: "project-progress", project: "m14-http-rewrites", body: "HTTP progress body", evidence_refs: ["evidence:m14-progress"],
    entries: [{ topic: "进展", at: "2026-01-01", text: "HTTP progress first" }],
  }, keyA);
  assert.equal(progress.status, 200, JSON.stringify(progress.data));
  const progressAgain = await call("/v1/write", {
    layer: "project-progress", project: "m14-http-rewrites", body: "HTTP progress body", evidence_refs: ["evidence:m14-progress"],
    entries: [{ topic: "进展", at: "2026-01-02", text: "HTTP progress second" }],
  }, keyA);
  assert.equal(progressAgain.status, 200, JSON.stringify(progressAgain.data));
  const progressRead = await call("/v1/project/get", { project: "m14-http-rewrites" }, keyA);
  assert.equal(progressRead.status, 200, JSON.stringify(progressRead.data));
  assert.equal((progressRead.data.item?.progress?.body.match(/# 项目进度 · m14-http-rewrites/g) ?? []).length, 1);
  assert.equal((progressRead.data.item?.progress?.body.match(/HTTP progress first/g) ?? []).length, 1);
  await waitForIndex();
  const progressJoint = await call("/v1/search/joint", { query: "HTTP progress first" }, keyA);
  assert.equal(progressJoint.status, 200, JSON.stringify(progressJoint.data));
  assert.ok(progressJoint.data.results.some((row) => row.matched_by.includes("fts")), JSON.stringify(progressJoint.data));
  const progressOther = await call("/v1/search/joint", { query: "HTTP progress first" }, keyB);
  assert.equal(progressOther.status, 200, JSON.stringify(progressOther.data));
  assert.equal(progressOther.data.results.some((row) => row.matched_by.includes("fts")), false);

  const roleSections = (suffix) => ({ "经验": `HTTP role rewrite evidence ${suffix} is long enough`, "适用场景": "real route", "边界": "test boundary" });
  const roleFirst = await call("/v1/roles/note", { kind: "lesson", confidence: "medium", sections: roleSections("first"), evidence_refs: ["evidence:m14-role"] }, keyA);
  assert.equal(roleFirst.status, 200, JSON.stringify(roleFirst.data));
  const roleSecond = await call("/v1/roles/note", { kind: "lesson", confidence: "medium", sections: roleSections("first"), evidence_refs: ["evidence:m14-role-merge"] }, keyA);
  assert.equal(roleSecond.status, 200, JSON.stringify(roleSecond.data));
  assert.equal(roleSecond.data.merged, true, JSON.stringify(roleSecond.data));
  const roleList = await call("/v1/roles/list", {}, keyA);
  assert.equal(roleList.status, 200, JSON.stringify(roleList.data));
  const roleItem = roleList.data.items.find((item) => item.id === roleSecond.data.id);
  assert.ok(roleItem, JSON.stringify(roleList.data));
  const roleOtherList = await call("/v1/roles/list", {}, keyB);
  assert.equal(roleOtherList.status, 200, JSON.stringify(roleOtherList.data));
  assert.equal(roleOtherList.data.items.some((item) => item.id === roleSecond.data.id), false);
  await waitForIndex();
  const roleJoint = await call("/v1/search/joint", { query: "HTTP role rewrite evidence first" }, keyA);
  assert.equal(roleJoint.status, 200, JSON.stringify(roleJoint.data));
  const roleHit = roleJoint.data.results.find((row) => row.path === roleItem.path || row.id === roleItem.path);
  assert.ok(roleHit?.matched_by.includes("fts"), JSON.stringify(roleJoint.data));
  const roleOtherJoint = await call("/v1/search/joint", { query: "HTTP role rewrite evidence first" }, keyB);
  assert.equal(roleOtherJoint.status, 200, JSON.stringify(roleOtherJoint.data));
  assert.equal(roleOtherJoint.data.results.some((row) => row.path === roleItem.path || row.id === roleItem.path), false);

  const profileDraft = await call("/v1/write", { layer: "profile", id: "m14-http-profile", body: "HTTP profile body", kind: "profile", status: "draft", evidence_refs: ["evidence:m14-profile"] }, keyAdmin);
  assert.equal(profileDraft.status, 200, JSON.stringify(profileDraft.data));
  const profile = await call("/v1/profile/confirm", { id: "m14-http-profile", evidence_refs: ["evidence:m14-profile"] }, keyAdmin);
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  const profileList = await call("/v1/profile/list", { include_draft: false }, keyAdmin);
  assert.equal(profileList.status, 200, JSON.stringify(profileList.data));
  const profileItem = profileList.data.items.find((item) => item.id === "m14-http-profile");
  assert.ok(profileItem, JSON.stringify(profileList.data));
  const profileOtherList = await call("/v1/profile/list", { include_draft: false }, keyB);
  assert.equal(profileOtherList.status, 200, JSON.stringify(profileOtherList.data));
  assert.equal(profileOtherList.data.items.some((item) => item.id === "m14-http-profile"), false);
  await waitForIndex();
  const profileJoint = await call("/v1/search/joint", { query: "HTTP profile body" }, keyAdmin);
  assert.equal(profileJoint.status, 200, JSON.stringify(profileJoint.data));
  assert.ok(profileJoint.data.results.some((row) => row.matched_by.includes("fts")), JSON.stringify(profileJoint.data));
  const profileOtherJoint = await call("/v1/search/joint", { query: "HTTP profile body" }, keyB);
  assert.equal(profileOtherJoint.status, 200, JSON.stringify(profileOtherJoint.data));
  assert.equal(profileOtherJoint.data.results.some((row) => row.matched_by.includes("fts")), false);
});

test("P1 HTTP supersede preserves current and historical retrieval", async () => {
  const oldWrite = await call("/v1/write", { layer: "curated-shared", visibility: "shared", id: "p1-http-old", body: "P1 HTTP preference old value", evidence_refs: ["evidence:p1-http"], valid_from: "2026-01-01T00:00:00.000Z" }, keyA);
  assert.equal(oldWrite.status, 200, JSON.stringify(oldWrite.data));
  const replacement = await call("/v1/memory/supersede", { old_id: "p1-http-old", layer: "curated-shared", id: "p1-http-new", body: "P1 HTTP preference new value", evidence_refs: ["evidence:p1-http"], valid_from: "2026-02-01T00:00:00.000Z" }, keyA);
  assert.equal(replacement.status, 200, JSON.stringify(replacement.data));
  const current = await call("/v1/search", { query: "P1 HTTP preference", searchMode: "formal", graphExpand: false }, keyA);
  assert.equal(current.status, 200, JSON.stringify(current.data));
  assert.ok(current.data.results.some((item) => item.path.endsWith("p1-http-new.md")));
  assert.equal(current.data.results.some((item) => item.path.endsWith("p1-http-old.md")), false);
  const past = await call("/v1/search", { query: "P1 HTTP preference", searchMode: "formal", as_of: "2026-01-15T00:00:00.000Z", graphExpand: false }, keyA);
  assert.equal(past.status, 200, JSON.stringify(past.data));
  assert.ok(past.data.results.some((item) => item.path.endsWith("p1-http-old.md")));
  const history = await call("/v1/search", { query: "P1 HTTP preference", searchMode: "formal", include_superseded: true, graphExpand: false }, keyA);
  assert.ok(history.data.results.some((item) => item.path.endsWith("p1-http-old.md")));
  const denied = await call("/v1/memory/supersede", { old_id: "p1-http-old", layer: "curated-shared", id: "p1-http-cross", body: "cross scope", evidence_refs: ["evidence:p1-http"] }, keyB);
  assert.equal(denied.status, 404);
});
