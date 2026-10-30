import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createIndexStore } from "../src/index-store.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public and admin health agree while an established index is catching up", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-health-consistency-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const shared = path.join(dataRoot, "curated", "shared");
  const requiredDirectories = [
    shared,
    path.join(dataRoot, "project-state"),
    path.join(dataRoot, "tools-memory"),
    path.join(dataRoot, "plans"),
    path.join(dataRoot, "profile"),
    path.join(dataRoot, "evidence", "documents"),
    path.join(dataRoot, "evidence", "conversations"),
    path.join(workspaceRoot, "recovery", "policies"),
    path.join(workspaceRoot, "recovery", "plans"),
  ];
  await Promise.all(requiredDirectories.map((directory) => fs.mkdir(directory, { recursive: true })));
  await Promise.all(Array.from({ length: 3 }, (_, index) => fs.writeFile(path.join(shared, `${index}.md`), `---\nid: ${index}\n---\n\nfixture ${index}`, "utf8")));

  const store = createIndexStore({
    dataRoot,
    ollama: { model: "nomic-embed-text", dimension: 768 },
    fetchImpl: async (_url, request) => {
      JSON.parse(request.body);
      return { ok: true, status: 200, json: async () => ({ embedding: Array(768).fill(0) }) };
    },
  });
  const indexed = await store.index({ limit: 1 });
  assert.equal(indexed.failed, 0, "fixture must isolate low coverage from index failure");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.actions = [...new Set([...(researcher.actions ?? []), "admin"])];
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory: ({ scopes, principal }) => createMemoryLib({
      dataRoot,
      workspaceRoot,
      scopes,
      principal,
      vectorLane: { requireIndex: false, fetch: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "bge-m3:latest" }] }) }) },
    }),
  });

  try {
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const publicResponse = await fetch(`${base}/v1/health`);
    const publicHealth = await publicResponse.json();
    const adminResponse = await fetch(`${base}/v1/admin/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } }),
    });
    const adminHealth = await adminResponse.json();

    assert.equal(publicResponse.status, 200);
    assert.equal(adminResponse.status, 200);
    assert.equal(publicHealth.health, "degraded", "established index below 98% coverage must be degraded");
    assert.equal(adminHealth.health, publicHealth.health, "public and admin health conclusions must agree");
    assert.deepEqual(Object.keys(adminHealth.index).sort(), Object.keys(publicHealth.index).sort(), "public and admin index field sets must agree");
    assert.deepEqual(adminHealth.index, publicHealth.index, "public and admin index values must agree");
    console.log("[FIX4-HEALTH-CONSISTENCY]", JSON.stringify({ public: { health: publicHealth.health, index: publicHealth.index }, admin: { health: adminHealth.health, index: adminHealth.index }, equal: true }));
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
