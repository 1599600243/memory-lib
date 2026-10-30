import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { createTestAuth } from "./test-auth.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint4-http-"));
const auth = await createTestAuth(repoRoot, tmp);
const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const framework = identity.frameworks.find((item) => item.credential_ref === auth.credentialRef);
const researcher = framework.agents.find((item) => item.agent_id === "pilot-01");
researcher.roles[0].actions = ["search", "get", "propose"];
await fs.writeFile(auth.registryPath, JSON.stringify(identity, null, 2) + "\n", "utf8");
const apiKeyFile = path.join(tmp, "api-keys.json");
await fs.writeFile(apiKeyFile, JSON.stringify({ version: 1, groups: [{ id: "group-maint4", name: "group-maint4" }], users: [{ id: "user-maint4", name: "user-maint4", group_id: "group-maint4" }], roles: [{ id: "researcher", name: "researcher", user_id: "user-maint4", group_id: "group-maint4" }, { id: "librarian-admin", name: "librarian-admin", user_id: "user-maint4", group_id: "group-maint4" }], api_keys: [] }) + "\n", "utf8");
const dataRoot = path.join(tmp, "memory");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes, agentId, roleId, principal, audit }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"),
  apiKeyFile, apiKeyPepper: "maint4-http-pepper", host: "127.0.0.1", port: 0, indexRefreshIntervalMinutes: 0.001,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const credentialBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };
async function post(body, token = null) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/v1/write`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function readWritten(id) {
  const files = [];
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (file.endsWith(`${id}.md`)) files.push(file); } }
  await walk(dataRoot);
  assert.equal(files.length, 1, `expected one file for ${id}`);
  return parseFrontmatterTyped(await fs.readFile(files[0], "utf8")).frontmatter;
}

test.after(async () => {
  await adapter.close();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await fs.rm(tmp, { recursive: true, force: true }); break; }
    catch (error) { if (error.code !== "EBUSY" || attempt === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
});

// 【契约变更 WRITE-DENY-1-REJECT2（裁决2）】旧契约：body 里的身份被**忽略**，一律以服务端解析的
// principal 为准（200 + 落盘是 principal）。新契约：自报身份与服务端 principal **不匹配 ⇒ 403
// IDENTITY_MISMATCH**（显式失败优于静默忽略）。匹配时行为不变（仍是 principal）——见每条里的正对照。
test("MAINT4【契约变更】/v1/write credential auth 自报身份不匹配 ⇒ 403 IDENTITY_MISMATCH；匹配 ⇒ 200 且落 resolved principal", async () => {
  const spoofed = await post({ ...credentialBody, layer: "agent", agent: "spoof-agent", role_id: "spoof-role", id: "m4-http-credential", body: "credential", evidence_refs: ["evidence:m4-credential"] });
  assert.equal(spoofed.status, 403, JSON.stringify(spoofed.data));
  assert.equal(spoofed.data.error.detail, "IDENTITY_MISMATCH", JSON.stringify(spoofed.data.error));
  await assert.rejects(fs.stat(path.join(dataRoot, "curated/agents/researcher/m4-http-credential.md")), "a refused write must create no file");

  // 正对照：身份与服务端一致 ⇒ 仍然 200，落盘就是 principal
  const result = await post({ ...credentialBody, layer: "agent", agent: "pilot-01", role_id: "researcher", id: "m4-http-credential", body: "credential", evidence_refs: ["evidence:m4-credential"] });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const fm = await readWritten("m4-http-credential");
  assert.equal(fm.agent_id, "pilot-01");
  assert.equal(fm.role_id, "researcher");
});

test("MAINT4【契约变更】/v1/write Bearer session 自报身份不匹配 ⇒ 403；匹配 ⇒ 200 且落 resolved principal", async () => {
  const loginResponse = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "pilot@example", password: "F11-pilot-account-password" }) });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200, JSON.stringify(login));
  const spoofed = await post({ layer: "agent", agent: "spoof-agent", role_id: "spoof-role", id: "m4-http-session", body: "session", evidence_refs: ["evidence:m4-session"] }, login.access_token);
  assert.equal(spoofed.status, 403, JSON.stringify(spoofed.data));
  assert.equal(spoofed.data.error.detail, "IDENTITY_MISMATCH", JSON.stringify(spoofed.data.error));

  const result = await post({ layer: "agent", agent: "pilot-01", role_id: "researcher", id: "m4-http-session", body: "session", evidence_refs: ["evidence:m4-session"] }, login.access_token);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const fm = await readWritten("m4-http-session");
  assert.equal(fm.agent_id, "pilot-01");
  assert.equal(fm.role_id, "researcher");
});

test("MAINT4【契约变更】/v1/write API key 自报身份不匹配 ⇒ 403；匹配 ⇒ 200 且无重复键", async () => {
  const admin = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, group_id: "group-maint4", user_id: "user-maint4", user_name: "user-maint4", group_name: "group-maint4" };
  const create = await fetch(`${base}/v1/admin/roles/researcher/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(admin) });
  const created = await create.json();
  assert.equal(create.status, 200, JSON.stringify(created));
  const spoofed = await post({ layer: "agent", agent: "spoof-agent", role_id: "spoof-role", id: "m4-http-key", body: "key", evidence_refs: ["evidence:m4-key"] }, created.key.secret);
  assert.equal(spoofed.status, 403, JSON.stringify(spoofed.data));
  assert.equal(spoofed.data.error.detail, "IDENTITY_MISMATCH", JSON.stringify(spoofed.data.error));

  const result = await post({ layer: "agent", agent: "pilot-01", role_id: "researcher", id: "m4-http-key", body: "key", evidence_refs: ["evidence:m4-key"] }, created.key.secret);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const fm = await readWritten("m4-http-key");
  assert.equal(fm.agent_id, "pilot-01");
  assert.equal(fm.role_id, "researcher");
});
