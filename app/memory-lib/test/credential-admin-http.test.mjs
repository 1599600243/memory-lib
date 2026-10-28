// F8 regression: HTTP credential lifecycle must follow the server's authoritative store.
// A request may omit the legacy `wincred` flag; the configured secret store still
// decides whether the newly generated secret must be written to WinCred.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { sanitizeRef } from "../src/credential-resolver.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-f8-http-"));
const DATA_ROOT = path.join(TMP, "memory");
const WORKSPACE_ROOT = path.join(TMP, "workspace");
const REGISTRY_PATH = path.join(TMP, "identity.json");
const WINCRED_SECRETS = path.join(TMP, "wincred-secrets");
const FILE_SECRETS = path.join(TMP, "file-secrets");
const AUTH_REF = "memory-lib/f8-http-admin";
const AUTH_SECRET = "F8HttpAdminAuthSecret000111222333444555666777";
const ADMIN = { agent_id: "admin-01", role_id: "librarian-admin" };

await fs.mkdir(DATA_ROOT, { recursive: true });
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.mkdir(WINCRED_SECRETS, { recursive: true });
await fs.mkdir(FILE_SECRETS, { recursive: true });
await fs.writeFile(REGISTRY_PATH, JSON.stringify({
  version: 1,
  frameworks: [{
    framework_id: "f8-http-admin",
    credential_ref: AUTH_REF,
    credential: { status: "active", revoked_at: null },
    agents: [{
      agent_id: ADMIN.agent_id,
      roles: [{
        role_id: ADMIN.role_id,
        scopes: [{ layer: "memory", visibility: "shared" }],
        actions: ["admin", "search", "get"],
      }],
    }],
  }],
}), "utf8");
await fs.writeFile(path.join(FILE_SECRETS, "memory-lib_f8-http-admin.secret"), AUTH_SECRET, "utf8");

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: DATA_ROOT, workspaceRoot: WORKSPACE_ROOT, scopes });
const servers = [];

after(async () => {
  for (const adapter of servers.splice(0)) await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

async function startServer({ secretStore, secretsDir, auditName, wincredWriter }) {
  const adapter = createLocalhostServer({
    libFactory,
    registryPath: REGISTRY_PATH,
    secretStore,
    auditPath: path.join(TMP, auditName),
    secretsDir,
    host: "127.0.0.1",
    port: 0,
    wincredWriter,
  });
  const address = await adapter.listen();
  servers.push(adapter);
  return `http://127.0.0.1:${address.port}`;
}

async function adminCall(base, route, extra = {}) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential_ref: AUTH_REF,
      secret: AUTH_SECRET,
      principal: ADMIN,
      ...extra,
    }),
  });
  return { status: response.status, data: await response.json() };
}

test("HTTP framework create and rotate write only WinCred when its file directory is disabled", async () => {
  const disabledSecrets = `${WINCRED_SECRETS}.disabled`;
  await fs.rename(WINCRED_SECRETS, disabledSecrets);
  const writes = [];
  const credentials = new Map([[sanitizeRef(AUTH_REF), AUTH_SECRET]]);
  const base = await startServer({
    secretStore: {
      type: "wincred",
      targetFor: sanitizeRef,
      readWincred: async (target) => credentials.has(target) ? { status: "ok", secret: credentials.get(target) } : { status: "not-found" },
    },
    secretsDir: WINCRED_SECRETS,
    auditName: "wincred-audit.jsonl",
    wincredWriter: async (credentialRef, secret) => {
      writes.push({ credentialRef, secret });
      credentials.set(sanitizeRef(credentialRef), secret);
      return { ok: true, target: sanitizeRef(credentialRef) };
    },
  });

  const created = await adminCall(base, "/v1/admin/framework/create", {
    framework_id: "f8-http-created",
    framework_credential_ref: "memory-lib/f8-http-created",
    agent_id: "agent-created",
    role_id: "reader",
    scopes: [{ layer: "memory", visibility: "shared" }],
    actions: ["search"],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.wincred, true, "default WinCred authority must not depend on a client flag");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].credentialRef, "memory-lib/f8-http-created");
  assert.equal(writes[0].secret, created.data.secret);
  assert.equal(Object.hasOwn(created.data, "secret_file"), false);
  await assert.rejects(() => fs.access(WINCRED_SECRETS), /ENOENT/, "WinCred authority must not recreate the disabled file-store directory");
  const search = async (secret) => fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: created.data.credential_ref, secret, principal: { agent_id: "agent-created", role_id: "reader" }, query: "memory" }) });
  assert.equal((await search(created.data.secret)).status, 200);
  assert.equal((await search("wrong-secret")).status, 401);
  const registry = await adminCall(base, "/v1/admin/registry");
  const createdFramework = registry.data.frameworks.find((item) => item.framework_id === "f8-http-created");
  assert.deepEqual(createdFramework.agents, [{ agent_id: "agent-created", roles: [{ role_id: "reader", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search"] }] }]);

  const rotated = await adminCall(base, "/v1/admin/credential/rotate", {
    target_credential_ref: "memory-lib/f8-http-created",
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
  assert.equal(rotated.data.wincred, true, "rotation must update the authoritative WinCred store");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].credentialRef, "memory-lib/f8-http-created");
  assert.equal(writes[1].secret, rotated.data.secret);
  assert.notEqual(rotated.data.secret, created.data.secret);
  assert.equal((await search(created.data.secret)).status, 401);
  assert.equal((await search(rotated.data.secret)).status, 200);
  assert.equal(Object.hasOwn(rotated.data, "secret_file"), false);
  await assert.rejects(() => fs.access(WINCRED_SECRETS), /ENOENT/, "rotation must leave the disabled file-store directory absent");
  console.log(JSON.stringify({ create: { status: created.status, wincred: created.data.wincred, hasSecretFile: Object.hasOwn(created.data, "secret_file") }, rotate: { status: rotated.status, wincred: rotated.data.wincred, hasSecretFile: Object.hasOwn(rotated.data, "secret_file") }, fileStoreDirectoryRecreated: false }, null, 2));
});

test("HTTP framework create in explicit file mode does not silently write WinCred", async () => {
  const writes = [];
  const base = await startServer({
    secretStore: { type: "file", dir: FILE_SECRETS },
    secretsDir: FILE_SECRETS,
    auditName: "file-audit.jsonl",
    wincredWriter: () => {
      writes.push(true);
      return { ok: true, target: "unexpected" };
    },
  });

  const created = await adminCall(base, "/v1/admin/framework/create", {
    framework_id: "f8-http-file-created",
    framework_credential_ref: "memory-lib/f8-http-file-created",
    agent_id: "agent-file",
    role_id: "reader",
    scopes: [{ layer: "memory", visibility: "shared" }],
    actions: ["search"],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.wincred, null);
  assert.equal(await fs.readFile(created.data.secret_file, "utf8"), created.data.secret);
  assert.deepEqual(writes, [], "file authority must not invoke the WinCred writer when the flag is omitted");
});
