import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { apiKeyRegistryView, createRoleKey } from "../src/api-key-registry.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "id1-cli-http-"));
const auth = await createTestAuth(root, tmp);
const identity = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
identity.frameworks[0].agents.push({ agent_id: "role-a", roles: [{ role_id: "role-a", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get", "propose"] }] });
await fs.writeFile(auth.registryPath, JSON.stringify(identity, null, 2) + "\n");
const apiKeyFile = path.join(tmp, "api-keys.json");
await fs.writeFile(apiKeyFile, JSON.stringify({ version: 1, groups: [{ id: "g-admin", name: "Admin" }, { id: "g-a", name: "Group A" }], users: [{ id: "u-admin", name: "Admin User", group_id: "g-admin" }, { id: "u-a", name: "User A", group_id: "g-a" }], roles: [{ id: "librarian-admin", name: "Admin Role", user_id: "u-admin", group_id: "g-admin" }, { id: "role-a", name: "Role A", user_id: "u-a", group_id: "g-a" }], api_keys: [] }, null, 2));
const dataRoot = path.join(tmp, "memory");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
  registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(tmp, "audit.jsonl"), apiKeyFile, apiKeyPepper: "id1-cli-pepper", host: "127.0.0.1", port: 0,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const adminKey = await createRoleKey({ file: apiKeyFile, groupId: "g-admin", userId: "u-admin", roleId: "librarian-admin", pepper: "id1-cli-pepper" });
const cli = path.join(root, "scripts", "issue-api-key.mjs");
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ status: code, signal }));
  });
}
async function call(route, body, token) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

after(async () => { await adapter.close(); await fs.rm(tmp, { recursive: true, force: true }); });

test("ID1 identity inventory is allowlisted and CLI dry-run/success execute real behavior", async () => {
  const firstOutput = path.join(tmp, "first-key.json");
  const dryOutput = path.join(tmp, "dry-run.json");
  const dryBefore = await fs.readFile(apiKeyFile, "utf8");
  const dry = await runCli(["--url", "http://127.0.0.1:1", "--role", "role-a", "--group", "g-a", "--user", "u-a", "--token", adminKey.secret, "--dry-run", "--output-file", dryOutput]);
  assert.equal(dry.status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(dryOutput, "utf8")), { dry_run: true, method: "POST", url: "http://127.0.0.1:1/v1/admin/roles/key", body: { role_id: "role-a", group_id: "g-a", user_id: "u-a", token: "[redacted]" } });
  assert.equal(await fs.readFile(apiKeyFile, "utf8"), dryBefore);

  const first = await runCli(["--url", base, "--role", "role-a", "--group", "g-a", "--user", "u-a", "--token", adminKey.secret, "--output-file", firstOutput]);
  assert.equal(first.status, 0);
  const firstPayload = JSON.parse(await fs.readFile(firstOutput, "utf8"));
  const firstSecret = firstPayload.key.secret;
  assert.equal(firstPayload.ok, true);
  assert.equal(firstSecret.startsWith("mlk_"), true);
  assert.equal((await call("/v1/search", { query: "ID1 absent sentinel", limit: 1 }, firstSecret)).status, 200);
  const storedAfterFirst = await fs.readFile(apiKeyFile, "utf8");
  assert.equal(storedAfterFirst.includes(firstSecret), false);
  assert.equal(storedAfterFirst.includes("secret_hash"), true);

  const secondOutput = path.join(tmp, "second-key.json");
  const second = await runCli(["--url", base, "--role", "role-a", "--group", "g-a", "--user", "u-a", "--token", adminKey.secret, "--output-file", secondOutput]);
  assert.equal(second.status, 0);
  const secondSecret = JSON.parse(await fs.readFile(secondOutput, "utf8")).key.secret;
  assert.notEqual(secondSecret, firstSecret);

  const view = await apiKeyRegistryView(apiKeyFile);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(firstSecret), false);
  assert.equal(serialized.includes(secondSecret), false);
  assert.equal(serialized.includes("secret_hash"), false);
  assert.equal(serialized.includes((await import("../src/api-key-registry.mjs")).keyDigest(firstSecret, "id1-cli-pepper")), false);
  assert.ok(view.api_keys.some((item) => item.role_id === "role-a"));
});
