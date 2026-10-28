import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { summarizeAuditHealth, createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d23-audit-"));
const auth = await createTestAuth(repoRoot, root);
const dataRoot = path.join(root, "memory");
const auditPath = path.join(root, "runtime", "audit", "access.jsonl");
const adapter = createLocalhostServer({
  libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: root, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  auditPath,
  host: "127.0.0.1",
  port: 0,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
after(async () => { await adapter.close(); await fs.rm(root, { recursive: true, force: true }); });

const row = (fields) => JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", allow: false, denyReason: "UNAUTHENTICATED", agent: "pilot-01", role: "capture-ingest", ...fields });

async function writeAudit(name, rows) {
  const file = path.join(root, name);
  await fs.writeFile(file, `${rows.join("\n")}\n`, "utf8");
  return file;
}

test("summarizeAuditHealth counts real unauthenticated events, not rows", async () => {
  const file = await writeAudit("health.jsonl", [
    row({ window_head: true }),
    row({ aggregated: true, repeat: 4, window_start: "2026-10-01T00:00:00.000Z", window_end: "2026-10-01T00:00:01.000Z" }),
    row({ agent: "pilot-02", window_head: true }),
    row({ agent: "pilot-02", aggregated: true, repeat: 2, window_end: "2026-10-01T00:00:02.000Z" }),
    row({ window_head: true, window_end: "2026-09-30T23:58:00.000Z" }),
  ]);
  const summary = await summarizeAuditHealth(file, { threshold: 7, now: () => Date.parse("2026-10-01T00:00:30.000Z") });
  assert.equal(summary.unauthenticated_window, 8);
  assert.equal(summary.denied_window, 8);
  assert.equal(summary.aggregated_window, 6);
  assert.equal(summary.degraded, true);
  assert.match(summary.reason, /7/);
  assert.equal((await summarizeAuditHealth(file, { threshold: 8, now: () => Date.parse("2026-10-01T00:00:30.000Z") })).degraded, false);
});

test("summarizeAuditHealth excludes events beyond the 60-second window", async () => {
  const file = await writeAudit("boundary.jsonl", [
    row({ window_head: true, window_end: "2026-10-01T00:00:00.000Z" }),
    row({ aggregated: true, repeat: 5, window_end: "2026-09-30T23:58:59.999Z" }),
  ]);
  const summary = await summarizeAuditHealth(file, { threshold: 1, now: () => Date.parse("2026-10-01T00:01:00.000Z") });
  assert.equal(summary.unauthenticated_window, 1);
  assert.equal(summary.degraded, false);
});

test("POST /v1/admin/audit/rotate preserves dry-run and gzip archive contract", async () => {
  const archive = path.join(path.dirname(auditPath), "archive");
  await fs.mkdir(archive, { recursive: true });
  const lines = Array.from({ length: 7 }, (_, i) => row({ id: i }));
  const source = path.join(archive, "access-2024-01.jsonl");
  await fs.writeFile(source, `${lines.join("\n")}\n`, "utf8");
  const before = await fs.readFile(source);
  const call = async (body) => {
    const response = await fetch(`${base}/v1/admin/audit/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } }) });
    return { status: response.status, data: await response.json() };
  };
  const queryAudit = async (body = {}) => {
    const response = await fetch(`${base}/v1/admin/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } }) });
    return { status: response.status, data: await response.json() };
  };
  const dry = await call({ dry_run: true, retain_months: 1 });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.deepEqual(dry.data.compressed, ["access-2024-01.jsonl"]);
  assert.deepEqual(await fs.readFile(source), before);
  await assert.rejects(fs.access(`${source}.gz`));

  const executed = await call({ dry_run: false, retain_months: 1 });
  assert.equal(executed.status, 200, JSON.stringify(executed.data));
  assert.deepEqual(executed.data.compressed, ["access-2024-01.jsonl"]);
  const gz = await fs.readFile(`${source}.gz`);
  const restored = zlib.gunzipSync(gz).toString("utf8");
  assert.equal(restored.split("\n").filter(Boolean).length, lines.length);
  assert.equal(restored.split("\n")[0], lines[0]);
  assert.equal(restored.trimEnd().split("\n").at(-1), lines.at(-1));
  await fs.access(source);
  const audit = await queryAudit({ limit: 100 });
  const rotationEvent = audit.data.events.find((event) => event.allow === true && event.resourceId === "audit-rotation:1");
  assert.ok(rotationEvent, JSON.stringify(audit.data.events));
});
