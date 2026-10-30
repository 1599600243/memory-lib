import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-http-"));
const auth = await createTestAuth(root, tmp);
const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
// WRITE-DENY-1：写者 role-a 窄口径持有 project:alpha（project 可见性写入的前提）；role-b 不持有，
// 所以 other-group 的 graph/joint 负对照仍然断言"看不见"。
identity.frameworks[0].agents.push({ agent_id: "role-a", roles: [{ role_id: "role-a", scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "alpha" }], actions: ["search", "get", "propose"] }] }, { agent_id: "role-b", roles: [{ role_id: "role-b", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get", "propose"] }] });
await fs.writeFile(auth.registryPath, JSON.stringify(identity, null, 2) + "\n");
await fs.writeFile(path.join(tmp, "api-keys.json"), JSON.stringify({ version: 1, groups: [{ id: "group-a", name: "group-a" }, { id: "group-b", name: "group-b" }], users: [{ id: "group-a-user", name: "group-a", group_id: "group-a" }, { id: "group-b-user", name: "group-b", group_id: "group-b" }], roles: [{ id: "role-a", name: "role-a", user_id: "group-a-user", group_id: "group-a" }, { id: "role-b", name: "role-b", user_id: "group-b-user", group_id: "group-b" }], api_keys: [] }, null, 2));
const dataRoot = path.join(tmp, "memory");
const workspaceRoot = tmp;
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"),
  apiKeyFile: path.join(tmp, "api-keys.json"), apiKeyPepper: "m13-http-pepper", host: "127.0.0.1", port: 0,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const adminBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } };
const createKey = async (role, group) => {
  const response = await fetch(`${base}/v1/admin/roles/${role}/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...adminBody, group_id: group, group_name: group, user_id: `${group}-user`, user_name: group }) });
  return (await response.json()).key.secret;
};
const keyA = await createKey("role-a", "group-a");
const keyB = await createKey("role-b", "group-b");
async function call(route, body, token = "") {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test.after(async () => { await adapter.close(); await fs.rm(tmp, { recursive: true, force: true }); });

test("M1.3 HTTP read routes reject unauthenticated requests", async () => {
  const graph = await call("/v1/graph/query", { tenant_id: "tenant-a", project_id: "alpha" });
  const joint = await call("/v1/search/joint", { tenant_id: "tenant-a", query: "alpha" });
  assert.equal(graph.status, 401);
  assert.equal(joint.status, 401);
});

test("M1.3 HTTP write then graph and joint read use API-key principal", async () => {
  const write = await call("/v1/project/decision", { project: "alpha", slug: "http-decision", sections: { "决定": "HTTP project decision", "理由": "HTTP route", "影响": "graph available" }, evidence_refs: ["evidence:http"], tenant_id: "spoofed-tenant", group_id: "spoofed-group" }, keyA);
  assert.equal(write.status, 200, JSON.stringify(write.data));
  const graph = await call("/v1/graph/query", { tenant_id: "spoofed-tenant", project_id: "alpha", principal: { tenant_id: "spoofed-tenant", group_id: "spoofed-group" } }, keyA);
  assert.equal(graph.status, 200, JSON.stringify(graph.data));
  assert.deepEqual(graph.data.graph.memories, [write.data.id]);
  const joint = await call("/v1/search/joint", { tenant_id: "spoofed-tenant", query: "HTTP project decision", exact: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: write.data.id }, principal: { tenant_id: "spoofed-tenant", group_id: "other" } }, keyA);
  assert.equal(joint.status, 200, JSON.stringify(joint.data));
  assert.equal(joint.data.results.some((row) => row.matched_by.includes("graph")), true);
  assert.equal(joint.data.principal.group, undefined);
  const daily = await call("/v1/search", { query: "HTTP project decision", limit: 10 }, keyA);
  assert.equal(daily.status, 200, JSON.stringify(daily.data));
  const dailyHit = daily.data.results.find((row) => row.id === write.data.id || row.path === write.data.path);
  assert.ok(dailyHit?.matched_by?.includes("graph"), JSON.stringify(daily.data));
  assert.deepEqual(dailyHit.graph_path, ["project:alpha", "belongs_to_project", write.data.id]);
  assert.deepEqual(dailyHit.evidence_ids, ["evidence:http"]);
  const dailyDisabled = await call("/v1/search", { query: "HTTP project decision", limit: 10, graphExpand: false }, keyA);
  assert.equal(dailyDisabled.status, 200, JSON.stringify(dailyDisabled.data));
  assert.equal(dailyDisabled.data.results.some((row) => row.matched_by?.includes("graph")), false);
  const otherDaily = await call("/v1/search", { query: "HTTP project decision", limit: 10 }, keyB);
  assert.equal(otherDaily.status, 200, JSON.stringify(otherDaily.data));
  assert.equal(otherDaily.data.results.some((row) => row.id === write.data.id || row.path === write.data.path), false);
  const mcpResponse = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${keyA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 701, method: "tools/call", params: { name: "memory_search", arguments: { query: "HTTP project decision", limit: 10 } } }) });
  assert.equal(mcpResponse.status, 200);
  const mcpBody = await mcpResponse.json();
  assert.equal(mcpBody.error, undefined, JSON.stringify(mcpBody));
  assert.equal(mcpBody.result.isError, false, JSON.stringify(mcpBody));
  const mcpText = mcpBody.result.content.map((part) => part.text ?? "").join("\\n");
  assert.match(mcpText, /graph/);
  assert.match(mcpText, /graph_path/);
  assert.match(mcpText, /evidence_ids/);
  const otherGroup = await call("/v1/graph/query", { project_id: "alpha", tenant_id: "body-tenant", group_id: "group-a" }, keyB);
  assert.equal(otherGroup.status, 200, JSON.stringify(otherGroup.data));
  assert.deepEqual(otherGroup.data.graph.memories, []);

  const visibleIds = (payload, route) => (route === "graph"
    ? payload.graph.memories
    : payload.results.map((row) => row.graph_path?.at(-1) ?? row.id ?? row.path).filter(Boolean))
    .map((value) => value === write.data.path ? write.data.id : value);
  for (const [label, token, expected] of [["owner", keyA, true], ["other-group", keyB, false]]) {
    const dailyMatrix = await call("/v1/search", { query: "HTTP project decision", limit: 10 }, token);
    const jointMatrix = await call("/v1/search/joint", { query: "HTTP project decision", limit: 10, exact: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: write.data.id } }, token);
    const graphMatrix = await call("/v1/graph/query", { project_id: "alpha" }, token);
    for (const [route, response] of [["daily", dailyMatrix], ["joint", jointMatrix], ["graph", graphMatrix]]) {
      assert.equal(response.status, 200, `${label} ${route}: ${JSON.stringify(response.data)}`);
    }
    const sets = [
      new Set(visibleIds(dailyMatrix.data, "daily")),
      new Set(visibleIds(jointMatrix.data, "joint")),
      new Set(visibleIds(graphMatrix.data, "graph")),
    ];
    for (const ids of sets) assert.equal(ids.has(write.data.id), expected, `${label} visibility mismatch: ${JSON.stringify([...ids])} daily=${JSON.stringify(dailyMatrix.data)} joint=${JSON.stringify(jointMatrix.data)} graph=${JSON.stringify(graphMatrix.data)}`);
    assert.deepEqual([...sets[0]].sort(), [...sets[1]].sort(), `${label}: daily/joint visible sets differ`);
    assert.deepEqual([...sets[0]].sort(), [...sets[2]].sort(), `${label}: daily/graph visible sets differ`);
  }
});
