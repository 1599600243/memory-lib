import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const root = path.join(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m11-demo-"));
await fs.cp(path.join(root, "test", "fixtures", "workspace"), path.join(tmp, "workspace"), { recursive: true });
const auth = await createTestAuth(root, tmp);
const dataRoot = path.join(tmp, "workspace", "memory");
const workspaceRoot = path.join(tmp, "workspace");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"),
  apiKeyFile: path.join(tmp, "api-keys.json"), apiKeyPepper: "demo-pepper", host: "127.0.0.1", port: 0,
});
const address = await adapter.listen(); const base = `http://127.0.0.1:${address.port}`;
async function call(route, body, token = "") { const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
const admin = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } };
try {
  const a = await call("/v1/admin/roles/role-a/keys", { ...admin, group_id: "group-a", user_id: "user-a", role_name: "assistant-a" });
  const b = await call("/v1/admin/roles/role-b/keys", { ...admin, group_id: "group-b", user_id: "user-b", role_name: "assistant-b" });
  const keyA = a.data.key.secret; const keyB = b.data.key.secret;
  const write = await call("/v1/write", { layer: "curated-shared", id: "m11-demo-private-a", body: "M11_DEMO_PRIVATE_A", evidence_refs: ["evidence:m11-demo"] }, keyA);
  const mine = await call("/v1/search", { query: "M11_DEMO_PRIVATE_A" }, keyA);
  const hidden = await call("/v1/search", { query: "M11_DEMO_PRIVATE_A" }, keyB);
  await call("/v1/admin/roles/revoke", { ...admin, role_id: "role-a" });
  const revoked = await call("/v1/search", { query: "M11_DEMO_PRIVATE_A" }, keyA);
  const keyDb = JSON.parse(await fs.readFile(path.join(tmp, "api-keys.json"), "utf8"));
  console.log(JSON.stringify({ create: { a_status: a.status, b_status: b.status, secret_not_persisted: !JSON.stringify(keyDb).includes(keyA) && !JSON.stringify(keyDb).includes(keyB) }, write: { status: write.status, layer: write.data.layer, path: write.data.path }, search: { a_status: mine.status, a_hits: mine.data.count, b_status: hidden.status, b_hits: hidden.data.count }, revoke_probe: { status: revoked.status } }, null, 2));
} finally { await adapter.close(); await fs.rm(tmp, { recursive: true, force: true }); }
