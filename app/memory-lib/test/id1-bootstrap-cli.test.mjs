import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "id1-bootstrap-"));
const auth = await createTestAuth(root, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
registry.frameworks[0].agents = [];
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
const apiKeys = path.join(tmp, "empty-api-keys.json");
const output = path.join(tmp, "bootstrap.json");
const dataRoot = path.join(tmp, "memory");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"), apiKeyFile: apiKeys, apiKeyPepper: "bootstrap-pepper", host: "127.0.0.1", port: 0,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const script = path.join(root, "scripts", "bootstrap-api-key.mjs");
const args = [script, "--registry", auth.registryPath, "--api-keys", apiKeys, "--framework", registry.frameworks[0].framework_id, "--credential-ref", auth.credentialRef, "--agent", "first-agent", "--role", "first-role", "--group", "first-group", "--group-name", "First Group", "--user", "first-user", "--user-name", "First User", "--role-name", "First Role", "--pepper", "bootstrap-pepper", "--output-file", output];
function run(extra = [], capture = false) {
  const command = args.slice(1);
  if (extra.length === 1) command.push(extra[0]);
  for (let index = 0; index < extra.length - 1; index += 2) { const position = command.indexOf(extra[index]); if (position >= 0) command[position + 1] = extra[index + 1]; else command.push(extra[index], extra[index + 1]); }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...command], { cwd: root, stdio: capture ? ["ignore", "ignore", "pipe"] : "ignore", windowsHide: true });
    let stderr = "";
    if (capture) child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject); child.once("exit", (code) => resolve(capture ? { code, stderr } : code));
  });
}
async function postSearch(token) { const response = await fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query: "bootstrap", limit: 1 }) }); return { status: response.status, data: await response.json() }; }
after(async () => { await adapter.close(); await fs.rm(tmp, { recursive: true, force: true }); });

test("ID1 bootstrap builds both bindings from empty files and authenticates first key", async () => {
  const beforeRegistry = await fs.readFile(auth.registryPath, "utf8");
  const dry = await run(["--dry-run"]);
  assert.equal(dry, 0);
  assert.equal(await fs.readFile(auth.registryPath, "utf8"), beforeRegistry);
  assert.equal(await fs.access(apiKeys).then(() => true).catch(() => false), false);
  assert.equal(await run(), 0);
  const first = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(first.ok, true);
  assert.equal(first.key.role_id, "first-role");
  assert.equal((await fs.readFile(output, "utf8")).split(first.key.secret).length - 1, 1);
  const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const role = identity.frameworks[0].agents.find((item) => item.agent_id === "first-agent").roles.find((item) => item.role_id === "first-role");
  assert.deepEqual(role.actions, ["search", "get", "propose"]);
  const keys = JSON.parse(await fs.readFile(apiKeys, "utf8"));
  assert.deepEqual(keys.groups.map((item) => item.id), ["first-group"]);
  assert.deepEqual(keys.users.map((item) => item.id), ["first-user"]);
  assert.deepEqual(keys.roles.map((item) => item.id), ["first-role"]);
  assert.equal(keys.api_keys[0].secret_hash.includes(first.key.secret), false);
  const authenticated = await postSearch(first.key.secret);
  assert.equal(authenticated.status, 200, JSON.stringify(authenticated.data));
  assert.equal(await run(), 0);
  const second = JSON.parse(await fs.readFile(output, "utf8"));
  assert.notEqual(second.key.secret, first.key.secret);
  assert.equal(JSON.parse(await fs.readFile(auth.registryPath, "utf8")).frameworks[0].agents.length, 1);
  assert.equal(JSON.parse(await fs.readFile(apiKeys, "utf8")).api_keys.length, 2);

  const beforeConflictRegistry = await fs.readFile(auth.registryPath, "utf8");
  const beforeConflictKeys = await fs.readFile(apiKeys, "utf8");
  const conflict = await run(["--role-name", "Conflicting Name"], true);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /existing key role conflicts/u);
  assert.equal(await fs.readFile(auth.registryPath, "utf8"), beforeConflictRegistry);
  assert.equal(await fs.readFile(apiKeys, "utf8"), beforeConflictKeys);
  assert.equal(JSON.parse(beforeConflictKeys).api_keys.length, 2);

  const brokenApiKeys = path.join(tmp, "broken-api-keys");
  await fs.mkdir(brokenApiKeys);
  const partial = await run(["--api-keys", brokenApiKeys, "--agent", "partial-agent", "--role", "partial-role", "--group", "partial-group", "--group-name", "Partial Group", "--user", "partial-user", "--user-name", "Partial User", "--role-name", "Partial Role"], true);
  assert.equal(partial.code, 2);
  assert.match(partial.stderr, /单侧已写入，请重跑（重跑是幂等的）/u);
  const partialIdentity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  assert.ok(partialIdentity.frameworks[0].agents.some((item) => item.agent_id === "partial-agent"));
});

