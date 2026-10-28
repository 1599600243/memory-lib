import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { DEFAULT_INSPECTION_REPORT_RELATIVE_PATH } from "../src/refinement-observability.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m2-http-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(workspaceRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registryPath = auth.registryPath;
const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
const framework = registry.frameworks[0];
const pilot = framework.agents.find((item) => item.agent_id === "pilot-01");
const reader = pilot.roles.find((item) => item.role_id === "reader");
reader.actions = [...new Set([...(reader.actions ?? []), "propose", "admin"])]
const researcher = pilot.roles.find((item) => item.role_id === "researcher");
researcher.group_id = "g1";
researcher.user_id = "u1";
researcher.actions = [...new Set([...(researcher.actions ?? []), "admin"])];
const steward = pilot.roles.find((item) => item.role_id === "steward");
steward.group_id = "g2";
steward.user_id = "u2";
steward.actions = [...new Set([...(steward.actions ?? []), "admin"])];
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
const secret = await fs.readFile(path.join(auth.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8");
const server = createLocalhostServer({
  registryPath,
  secretStore: auth.secretStore,
  dataRoot,
  workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, refinementThreshold: 1, vectorLane: { probe: false } }),
});
const address = await server.listen();
const base = `http://127.0.0.1:${address.port}`;
const headers = (role) => ({ "content-type": "application/json" });
async function call(role, route, payload = {}) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: headers(role), body: JSON.stringify({ credential_ref: auth.credentialRef, secret: secret.trim(), principal: { agent_id: "pilot-01", role_id: role }, ...payload }) });
  return { status: response.status, body: await response.json() };
}

test("real authenticated capture and admin health keep group attribution isolated", async () => {
  const g1Capture = await call("researcher", "/v1/conversations/capture", { conversation_id: "http-g1", event_id: "http-g1", principal: { agent_id: "pilot-01", role_id: "researcher", group_id: "g1", user_id: "u1" }, messages: [{ role: "user", content: "g1 request" }] });
  const g2Capture = await call("steward", "/v1/conversations/capture", { conversation_id: "http-g2", event_id: "http-g2", messages: [{ role: "user", content: "g2 request" }] });
  assert.equal(g1Capture.status, 200);
  assert.equal(g2Capture.status, 200);
  assert.equal(g1Capture.body.refinement.pending, true);
  assert.equal(g1Capture.body.refinement.unrefined_today, 1);
  const pendingBefore = await call("researcher", "/v1/refinement/pending");
  assert.equal(pendingBefore.status, 200);
  assert.ok(pendingBefore.body.items.some((item) => item.evidence_id === g1Capture.body.evidenceId));
  assert.ok(pendingBefore.body.items.every((item) => item.summary.length <= 80));
  for (let i = 0; i < 5; i += 1) {
    const repeated = await call("researcher", "/v1/conversations/capture", { conversation_id: `http-g1-repeat-${i}`, event_id: `http-g1-repeat-${i}`, messages: [{ role: "user", content: `repeat ${i}` }, { role: "assistant", content: `UNIQUE-END-${i}` }] });
    assert.equal(repeated.status, 200);
  }
  const stubFiles = (await fs.readdir(path.join(dataRoot, "curated", "shared")).catch(() => [])).filter((name) => name.startsWith("auto-stub-"));
  assert.deepEqual(stubFiles, []);
  const g1Health = await call("researcher", "/v1/admin/health");
  const g2Health = await call("steward", "/v1/admin/health");
  assert.equal(g1Health.status, 200);
  assert.equal(g2Health.status, 200);
  assert.equal(g1Health.body.refinement.plan.scope, "scoped");
  assert.equal(g2Health.body.refinement.plan.scope, "scoped");
  assert.equal(g1Health.body.refinement.raw_conversations, 6);
  assert.equal(g2Health.body.refinement.raw_conversations, 1);
  assert.equal(g1Health.body.refinement.alert.audible, true);
  assert.equal(g2Health.body.refinement.alert.audible, true);
  const auditResponse = await call("researcher", "/v1/admin/audit", { limit: 200 });
  assert.equal(auditResponse.status, 200);
  assert.ok(auditResponse.body.events.some((event) => event.action === "refinement_alert"));
  const inspection = await fs.readFile(path.join(dataRoot, DEFAULT_INSPECTION_REPORT_RELATIVE_PATH), "utf8");
  assert.match(inspection, /告警状态：alert/u);
  console.log("[FIX1-REFINEMENT-HTTP-EVIDENCE]", JSON.stringify({ g1: { raw: g1Health.body.refinement.raw_conversations, refined: g1Health.body.refinement.refined_memories, ratio: g1Health.body.refinement.refinement_ratio, alert: g1Health.body.refinement.alert }, g2: { raw: g2Health.body.refinement.raw_conversations, refined: g2Health.body.refinement.refined_memories, ratio: g2Health.body.refinement.refinement_ratio, alert: g2Health.body.refinement.alert }, pending: pendingBefore.body.total_count, autoStubFiles: stubFiles, auditRefinementAlert: true, inspectionAlert: true }));
  const formal = await call("researcher", "/v1/write", { layer: "curated-shared", id: "http-g1-refinement", body: "g1 formal", evidence_refs: [g1Capture.body.evidenceId], visibility: "shared" });
  assert.equal(formal.status, 200);
  const pendingAfter = await call("researcher", "/v1/refinement/pending");
  assert.equal(pendingAfter.status, 200);
  assert.ok(!pendingAfter.body.items.some((item) => item.evidence_id === g1Capture.body.evidenceId));
  const writer = createMemoryWriter({ dataRoot });
  await writer.write({ layer: "curated-shared", id: "http-g2-refinement", body: "g2 formal", evidence_refs: [g2Capture.body.evidenceId], principal: { group_id: "g2", user_id: "u2", agent_id: "pilot-01", role_id: "steward" }, visibility: "shared" });
  const g1After = await call("researcher", "/v1/admin/health");
  const g2After = await call("steward", "/v1/admin/health");
  assert.ok(g1After.body.refinement.alert.consecutive_zero_refinement < g1Health.body.refinement.alert.consecutive_zero_refinement);
  assert.equal(g1After.body.refinement.alert.status, "ok");
  assert.equal(g1After.body.refinement.refined_last_24h > 0, true);
  assert.equal(g2After.body.refinement.alert.audible, false);
  assert.equal(g1Health.body.principal.group_id, "g1");
  assert.equal(g2Health.body.principal.group_id, "g2");
  const forged = await call("researcher", "/v1/conversations/capture", { conversation_id: "http-forged", event_id: "http-forged", principal: { agent_id: "pilot-01", role_id: "researcher", group_id: "g2", user_id: "u2" }, messages: [{ role: "user", content: "forged identity" }] });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error.detail, "PRINCIPAL_MISMATCH");
  const evidence = await fs.readFile(path.join(dataRoot, "evidence", "conversations", `${g1Capture.body.evidenceId}.md`), "utf8");
  assert.match(evidence, /groupId: "g1"/u);
  assert.match(evidence, /userId: "u1"/u);
  const evidenceRoot = path.join(dataRoot, "evidence", "conversations");
  const beforeUnknown = (await fs.readdir(evidenceRoot)).filter((name) => name.endsWith(".md")).sort();
  const unknownCapture = await call("reader", "/v1/conversations/capture", { conversation_id: "http-unknown", event_id: "http-unknown", messages: [{ role: "user", content: "unknown request" }] });
  assert.equal(unknownCapture.status, 400);
  assert.match(unknownCapture.body.error.message, /group_id and user_id/iu);
  const afterUnknown = (await fs.readdir(evidenceRoot)).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(afterUnknown, beforeUnknown);
  const unknownHealth = await call("reader", "/v1/admin/health");
  assert.equal(unknownHealth.status, 200);
  assert.equal(unknownHealth.body.principal.group_id, "unknown");
  assert.equal(unknownHealth.body.principal.user_id, "unknown");
  assert.equal(unknownHealth.body.refinement.plan.scope, "global");
  assert.equal(unknownHealth.body.refinement.unattributed_conversations_global, 0);
});

after(async () => { await server.close(); await fs.rm(tmp, { recursive: true, force: true }); });
