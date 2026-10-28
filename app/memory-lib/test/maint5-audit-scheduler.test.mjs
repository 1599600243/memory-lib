import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const roots = [];
const makeServer = async (options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint5-"));
  roots.push(root);
  const auth = options.auth ?? await createTestAuth(repoRoot, root);
  const auditPath = path.join(root, "runtime", "audit", "access.jsonl");
  const server = createLocalhostServer({
    libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot: path.join(root, "memory"), workspaceRoot: root, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
    registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath, host: "127.0.0.1", port: 0,
    auditRotateIntervalMinutes: options.interval,
    auditScheduleEnabled: options.enabled,
    auditArchiveDir: options.archiveDir,
    auditMaxBytes: 1,
    auditRetainMonths: 12,
    auditScheduleRunner: options.runner,
  });
  const address = await server.listen();
  return { server, root, base: `http://127.0.0.1:${address.port}`, auditPath, auth };
};
after(async () => { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); });

test("audit scheduler runs on a short interval and health exposes result", async () => {
  let runs = 0;
  const ctx = await makeServer({ interval: 0.0005, runner: async () => { runs += 1; return { dry_run: false, compressed: [`run-${runs}`], oversized: [], retained: [] }; } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await fetch(`${ctx.base}/v1/health`).then((r) => r.json());
    assert.ok(runs >= 1);
    assert.equal(health.audit_rotation.last_status, "completed");
    assert.ok(health.audit_rotation.last_run_at);
    assert.equal(health.audit_rotation.failed, 0);
  } finally { await ctx.server.close(); }
});

test("audit scheduler records failure and invalid interval uses disabled state", async () => {
  const failed = await makeServer({ interval: 0.0005, runner: async () => { throw new Error("fixture rotation failure"); } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    const health = await fetch(`${failed.base}/v1/health`).then((r) => r.json());
    assert.equal(health.audit_rotation.last_status, "failed");
    assert.ok(health.audit_rotation.failed >= 1);
    assert.match(health.audit_rotation.last_error, /fixture rotation failure/);
    const auditText = await fs.readFile(failed.auditPath, "utf8");
    assert.match(auditText, /ROTATION_FAILED/);
  } finally { await failed.server.close(); }
  for (const interval of [0, -1, "invalid"]) {
    const invalid = await makeServer({ interval, runner: async () => { throw new Error("must not run"); } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const health = await fetch(`${invalid.base}/v1/health`).then((r) => r.json());
      assert.equal(health.audit_rotation.enabled, false);
      assert.equal(health.audit_rotation.interval_minutes, Number.isFinite(Number(interval)) ? interval : "invalid");
    } finally { await invalid.server.close(); }
  }
});

test("audit rotation gate serializes timer and authenticated manual route calls", async () => {
  let active = 0; let maxActive = 0; let completed = 0; const results = [];
  const archiveDir = path.join(os.tmpdir(), `memory-lib-maint5-archive-${Date.now()}`);
  const ctx = await makeServer({ interval: 0.0005, archiveDir, runner: async () => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1; completed += 1;
    const result = { dry_run: false, compressed: [`run-${completed}`], oversized: [], retained: [] }; results.push(result); return result;
  } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 8));
    const manual = fetch(`${ctx.base}/v1/admin/audit/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: ctx.auth.credentialRef, secret: ctx.auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, dry_run: false }),
    }).then(async (response) => ({ status: response.status, data: await response.json() }));
    const manualResult = await manual;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const health = await fetch(`${ctx.base}/v1/health`).then((response) => response.json());
    const audit = await fetch(`${ctx.base}/v1/admin/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: ctx.auth.credentialRef, secret: ctx.auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, limit: 100 }),
    }).then((response) => response.json());
    assert.equal(manualResult.status, 200, JSON.stringify(manualResult.data));
    assert.equal(maxActive, 1);
    assert.ok(completed >= 2);
    assert.equal(health.audit_rotation.last_status, "completed");
    assert.equal(health.audit_rotation.failed, 0);
    const rotationEvents = audit.events.filter((event) => event.allow === true && /^audit-rotation:\d+$/u.test(event.resourceId));
    assert.ok(rotationEvents.length >= 1);
    assert.equal(new Set(results.flatMap((result) => result.compressed)).size, results.flatMap((result) => result.compressed).length);
    assert.equal((await fs.readdir(archiveDir).catch(() => [])).filter((name) => name.endsWith(".gz")).length, 0);
    console.log(JSON.stringify({ maxActive, completed, manual_status: manualResult.status, health: health.audit_rotation, audit_resource_ids: rotationEvents.map((event) => event.resourceId), compressed: results.flatMap((result) => result.compressed) }));
  } finally { await ctx.server.close(); }
});
