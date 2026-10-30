import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createRoleKey } from "../src/api-key-registry.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const root = path.join(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m11-e2e-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(tmp, "workspace"), { recursive: true });
const auth = await createTestAuth(root, tmp);
const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const framework = identity.frameworks[0];
// WRITE-DENY-1：project 可见性的写入需要**该项目的项目作用域**，所以写者 role-a 要窄口径地持有
// project:m11-group-a（不是 "*"）；role-b 不持有，跨组负对照因此不退化为"双方都看不见"。
framework.agents.push({ agent_id: "role-a", roles: [{ role_id: "role-a", scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "m11-group-a" }], actions: ["search", "get", "propose"] }] });
framework.agents.push({ agent_id: "role-b", roles: [{ role_id: "role-b", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get", "propose"] }] });
await fs.writeFile(auth.registryPath, JSON.stringify(identity, null, 2) + "\n", "utf8");
const apiKeyFile = path.join(tmp, "api-keys.json");
await fs.writeFile(apiKeyFile, JSON.stringify({ version: 1, groups: [{ id: "group-a", name: "A" }, { id: "group-b", name: "B" }], users: [{ id: "user-a", name: "Alice", group_id: "group-a" }, { id: "user-b", name: "Bob", group_id: "group-b" }], roles: [{ id: "role-a", name: "role-a", user_id: "user-a", group_id: "group-a", status: "active" }, { id: "role-b", name: "role-b", user_id: "user-b", group_id: "group-b", status: "active" }], api_keys: [] }, null, 2) + "\n", "utf8");
const dataRoot = path.join(tmp, "workspace", "memory");
const workspaceRoot = path.join(tmp, "workspace");
const adapter = createLocalhostServer({ libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }), registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"), apiKeyFile, apiKeyPepper: "e2e-pepper", host: "127.0.0.1", port: 0 });
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;

after(async () => { await adapter.close(); await fs.rm(tmp, { recursive: true, force: true }); });
async function call(route, body, token = "") { const r = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; }
function admin(extra = {}) { return { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, ...extra }; }

test("M1.1 two role keys isolate one private long-term memory", async () => {
  const a = await call("/v1/admin/roles/role-a/keys", admin({ group_id: "group-a", group_name: "A", user_id: "user-a", user_name: "Alice" }));
  const b = await call("/v1/admin/roles/role-b/keys", admin({ group_id: "group-b", group_name: "B", user_id: "user-b", user_name: "Bob" }));
  assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(b.status, 200, JSON.stringify(b.data));
  const keyA = a.data.key.secret; const keyB = b.data.key.secret;
  const inventory = await call("/v1/admin/identity", admin());
  assert.equal(inventory.status, 200, JSON.stringify(inventory.data));
  const inventoryText = JSON.stringify(inventory.data);
  assert.equal(inventoryText.includes(keyA), false);
  assert.equal(inventoryText.includes("secret_hash"), false);
  assert.ok(inventory.data.identity.groups.some((item) => item.id === "group-a"));
  assert.ok(inventory.data.identity.api_keys.some((item) => item.role_id === "role-a"));
  const stored = await fs.readFile(path.join(tmp, "api-keys.json"), "utf8");
  assert.equal(stored.includes(keyA), false); assert.equal(stored.includes(keyB), false);
  const write = await call("/v1/write", { layer: "curated-shared", id: "m11-private-a", body: "M11_PRIVATE_SENTINEL_A", evidence_refs: ["evidence:m11"] }, keyA);
  assert.equal(write.status, 200, JSON.stringify(write.data)); assert.equal(write.data.layer, "agent");
  const mine = await call("/v1/search", { query: "M11_PRIVATE_SENTINEL_A", limit: 10 }, keyA);
  const other = await call("/v1/search", { query: "M11_PRIVATE_SENTINEL_A", limit: 10 }, keyB);
  assert.equal(mine.status, 200, JSON.stringify(mine.data)); assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.ok(mine.data.results.some((item) => item.path.endsWith("curated\\agents\\role-a\\m11-private-a.md") && item.excerpt.includes("M11_PRIVATE_SENTINEL_A")));
  assert.equal(other.data.results.some((item) => item.id === "m11-private-a"), false);
  const unauthenticated = await call("/v1/search", { query: "M11_PRIVATE_SENTINEL_A" });
  assert.equal(unauthenticated.status, 401);
  const forbiddenAdmin = await call("/v1/admin/identity", {}, keyB);
  assert.equal(forbiddenAdmin.status, 403);
  const projectWrite = await call("/v1/project/state", { project: "m11-group-a", group_id: "group-a", sections: { "目标": "private project", "当前进展": "isolated", "下一步": "verify", "阻塞": "当前无阻塞" }, evidence_refs: ["evidence:m11-project"] }, keyA);
  assert.equal(projectWrite.status, 200, JSON.stringify(projectWrite.data));
  const hiddenProject = await call("/v1/project/get", { project: "m11-group-a" }, keyB);
  assert.equal(hiddenProject.status, 404);
});
