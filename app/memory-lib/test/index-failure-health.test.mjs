import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  { name: "sqlite path occupied by a directory", expectedError: /unable to open database file/iu },
];

for (const fixture of cases) {
  test(`authenticated admin health exposes index failure when ${fixture.name}`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-index-health-"));
    const workspaceRoot = path.join(tmp, "workspace");
    const dataRoot = path.join(workspaceRoot, "memory");
    const blockedIndexPath = path.join(dataRoot, "indexes", "sqlite", "memory-lib-index.sqlite");
    await fs.mkdir(blockedIndexPath, { recursive: true });
    const auth = await createTestAuth(ROOT, tmp);
    const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
    const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
    researcher.group_id = "g-index-health";
    researcher.user_id = "u-index-health";
    researcher.actions = [...new Set([...(researcher.actions ?? []), "admin"])];
    await fs.writeFile(auth.registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
    const secret = (await fs.readFile(path.join(auth.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).trim();
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
      libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
    });
    try {
      const address = await server.listen();
      const base = `http://127.0.0.1:${address.port}`;
      const authBody = { credential_ref: auth.credentialRef, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };
      async function post(route, payload = {}) {
        const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody, ...payload }) });
        return { status: response.status, body: await response.json() };
      }

      const capture = await post("/v1/conversations/capture", { conversation_id: "index-failure", event_id: "index-failure", messages: [{ role: "user", content: "index failure must remain observable" }] });
      assert.equal(capture.status, 200);
      assert.equal(capture.body.status, "failed");
      assert.deepEqual(capture.body.lifecycle, ["accepted", "stored", "failed"]);
      assert.match(capture.body.indexError, fixture.expectedError);

      const stored = await post("/v1/get", { id: capture.body.evidenceId });
      assert.equal(stored.status, 200);
      assert.equal(stored.body.item.frontmatter.id, capture.body.evidenceId);

      const health = await post("/v1/admin/health");
      assert.equal(health.status, 200);
      assert.equal(health.body.health, "degraded");
      assert.ok(health.body.index, "authenticated health must always include index status");
      assert.ok(health.body.index.failed > 0);
      assert.match(health.body.index.last_error, fixture.expectedError);
      const publicResponse = await fetch(`${base}/v1/health`);
      const publicHealth = await publicResponse.json();
      assert.equal(publicResponse.status, 200);
      for (const field of ["failed", "last_error", "incremental_failure", "last_status", "pending_changes"]) {
        assert.deepEqual(health.body.index[field], publicHealth.index[field], `health index field must agree: ${field}`);
      }
      assert.deepEqual(health.body.index.lifecycle, publicHealth.index.lifecycle);
      console.log("[FIX3-INDEX-HEALTH-EVIDENCE]", JSON.stringify({ capture: { status: capture.body.status, lifecycle: capture.body.lifecycle, indexError: capture.body.indexError }, storedById: stored.status, adminHealth: { health: health.body.health, index: health.body.index }, publicAdminIndexAgree: true }));
    } finally {
      await server.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
}
