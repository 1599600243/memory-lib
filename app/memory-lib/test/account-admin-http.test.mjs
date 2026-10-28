import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { sanitizeRef } from "../src/credential-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-account-admin-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(tmp, "workspace"), { recursive: true });
const auth = await createTestAuth(root, tmp);
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const auditPath = path.join(tmp, "audit.jsonl");
const adapter = createLocalhostServer({
  libFactory: ({ scopes }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, vectorLane: { probe: false } }),
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  auditPath,
  host: "127.0.0.1",
  port: 0,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
const username = "New.Admin@Example";
const password = "R3-initial-password-value";

after(async () => {
  await adapter.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function post(route, body, token = "") {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

function adminBody(extra) {
  return {
    credential_ref: auth.credentialRef,
    secret: auth.authValue,
    principal: { agent_id: "admin-01", role_id: "librarian-admin" },
    ...extra,
  };
}

test("wincred mode provisions, logs in, resets password and suspends an account", async () => {
  const credentials = new Map([[sanitizeRef(auth.credentialRef), auth.authValue]]);
  const targets = [];
  const wincredSecretStore = {
    type: "wincred",
    targetFor: sanitizeRef,
    async readWincred(target) {
      return credentials.has(target) ? { status: "ok", secret: credentials.get(target) } : { status: "not-found" };
    },
  };
  const wincredAdapter = createLocalhostServer({
    libFactory: ({ scopes }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, vectorLane: { probe: false } }),
    registryPath: auth.registryPath,
    secretStore: wincredSecretStore,
    wincredWriter: async (target, secret) => {
      targets.push(target);
      credentials.set(target, secret);
      return { ok: true, target };
    },
    auditPath: path.join(tmp, "wincred-audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
  });
  const wincredAddress = await wincredAdapter.listen();
  const wincredBase = `http://127.0.0.1:${wincredAddress.port}`;
  const wincredPost = async (route, body, token = "") => {
    const response = await fetch(`${wincredBase}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const admin = (extra) => ({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, ...extra });
  try {
    const wincredUsername = "wincred.admin@example";
    const initial = "R18-initial-password-value";
    const replacement = "R18-replacement-password-value";
    const created = await wincredPost("/v1/admin/account/create", admin({ username: wincredUsername, password: initial, framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher" }));
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.ok(targets.includes(sanitizeRef(`accounts/${wincredUsername}`)));
    const login = await wincredPost("/v1/auth/login", { username: wincredUsername, password: initial });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    const reset = await wincredPost("/v1/admin/account/password/reset", admin({ username: wincredUsername, password: replacement }));
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    const oldSession = await fetch(`${wincredBase}/v1/auth/whoami`, { headers: { authorization: `Bearer ${login.data.access_token}` } });
    assert.equal(oldSession.status, 401);
    assert.equal((await wincredPost("/v1/auth/login", { username: wincredUsername, password: initial })).status, 401);
    assert.equal((await wincredPost("/v1/auth/login", { username: wincredUsername, password: replacement })).status, 200);
    assert.equal((await wincredPost("/v1/admin/account/suspend", admin({ username: wincredUsername }))).status, 200);
    assert.equal((await wincredPost("/v1/auth/login", { username: wincredUsername, password: replacement })).status, 401);
  } finally {
    await wincredAdapter.close();
  }
});

test("account create and password change accept 8 characters and reject 7", async () => {
  const shortCreate = await post("/v1/admin/account/create", adminBody({ username: "seven@example", password: "1234567", framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher" }));
  assert.equal(shortCreate.status, 400, JSON.stringify(shortCreate.data));
  const created = await post("/v1/admin/account/create", adminBody({ username: "eight@example", password: "12345678", framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher" }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const login = await post("/v1/auth/login", { username: "eight@example", password: "12345678" });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const shortChange = await post("/v1/auth/password", { username: "eight@example", current_password: "12345678", new_password: "7654321" }, login.data.access_token);
  assert.equal(shortChange.status, 400, JSON.stringify(shortChange.data));
  const changed = await post("/v1/auth/password", { username: "eight@example", current_password: "12345678", new_password: "87654321" }, login.data.access_token);
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await post("/v1/auth/login", { username: "eight@example", password: "87654321" })).status, 200);
});

test("admin can provision an account, authenticate it, and suspend it immediately", async () => {
  const created = await post("/v1/admin/account/create", adminBody({
    username,
    password,
    framework_id: "deepseek-harness",
    agent_id: "pilot-01",
    role_id: "researcher",
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.deepEqual(created.data.account, {
    username: "new.admin@example",
    framework_id: "deepseek-harness",
    credential_ref: auth.credentialRef,
    agent_id: "pilot-01",
    role_id: "researcher",
    status: "active",
  });
  const createdRaw = JSON.stringify(created.data);
  assert.ok(!createdRaw.includes(password) && !createdRaw.includes("hash_b64") && !createdRaw.includes("salt_b64"));

  const registryRaw = await fs.readFile(auth.registryPath, "utf8");
  assert.ok(registryRaw.includes("new.admin@example"));
  assert.ok(!registryRaw.includes(password) && !registryRaw.includes("hash_b64") && !registryRaw.includes("salt_b64"));

  const login = await post("/v1/auth/login", { username: "new.admin@example", password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const whoamiResponse = await fetch(`${base}/v1/auth/whoami`, { headers: { authorization: `Bearer ${login.data.access_token}` } });
  const whoami = await whoamiResponse.json();
  assert.equal(whoamiResponse.status, 200);
  assert.deepEqual(whoami.principal, { framework: "deepseek-harness", agent: "pilot-01", role: "researcher" });
  assert.ok(whoami.scopes.length > 0);

  const suspended = await post("/v1/admin/account/suspend", adminBody({ username: "new.admin@example" }));
  assert.equal(suspended.status, 200, JSON.stringify(suspended.data));
  const rejected = await fetch(`${base}/v1/auth/whoami`, { headers: { authorization: `Bearer ${login.data.access_token}` } });
  assert.equal(rejected.status, 401);

  const activated = await post("/v1/admin/account/activate", adminBody({ username: "new.admin@example" }));
  assert.equal(activated.status, 200);
  const activeLogin = await post("/v1/auth/login", { username: "new.admin@example", password });
  assert.equal(activeLogin.status, 200);
  const nextPassword = "R3-reset-password-value";
  const reset = await post("/v1/admin/account/password/reset", adminBody({ username: "new.admin@example", password: nextPassword }));
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.ok(reset.data.revoked_sessions >= 1);
  const oldSession = await fetch(`${base}/v1/auth/whoami`, { headers: { authorization: `Bearer ${activeLogin.data.access_token}` } });
  assert.equal(oldSession.status, 401);
  assert.equal((await post("/v1/auth/login", { username: "new.admin@example", password })).status, 401);
  assert.equal((await post("/v1/auth/login", { username: "new.admin@example", password: nextPassword })).status, 200);

  const nonAdmin = await post("/v1/admin/account/create", {
    credential_ref: auth.credentialRef,
    secret: auth.authValue,
    principal: { agent_id: "pilot-01", role_id: "researcher" },
    username: "forbidden@example",
    password: "R3-forbidden-password",
    framework_id: "deepseek-harness",
    agent_id: "pilot-01",
    role_id: "researcher",
  });
  assert.equal(nonAdmin.status, 403);

  const auditRaw = await fs.readFile(auditPath, "utf8");
  assert.ok(!auditRaw.includes(password) && !auditRaw.includes(nextPassword) && !auditRaw.includes("hash_b64") && !auditRaw.includes("salt_b64"));
});
