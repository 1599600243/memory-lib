import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditLog, readAuditLines } from "../src/audit.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d22-aggregate-"));
after(async () => fs.rm(root, { recursive: true, force: true }));

const denied = (action = "capture", agent = "pilot-01") => ({ action, denyReason: "UNAUTHENTICATED", agent, role: "capture-ingest", credentialFingerprint: null, allow: false });

test("continuous identical denials aggregate with repeat conservation", async () => {
  const file = path.join(root, "same.jsonl");
  const audit = createAuditLog(file, { now: (() => { let t = 0; return () => t; })() });
  for (let i = 0; i < 1000; i += 1) await audit.record(denied());
  await audit.flush();
  const rows = await readAuditLines(file, { limit: 10 });
  assert.ok(rows.length < 1000);
  assert.equal(rows.filter((row) => row.aggregated).reduce((sum, row) => sum + row.repeat, 0), 999);
  assert.equal(rows.filter((row) => row.allow === false).reduce((sum, row) => sum + (row.repeat ?? 1), 0), 1000);
  assert.equal(rows.filter((row) => row.window_head === true).length, 1);
  assert.equal(rows[0].allow, false);
});

test("allow true remains per-event and denial keys never mix", async () => {
  const file = path.join(root, "keys.jsonl");
  let now = 0;
  const audit = createAuditLog(file, { now: () => now });
  await audit.record(denied("capture", "pilot-01"));
  await audit.record(denied("capture", "pilot-02"));
  await audit.record({ action: "health", allow: true });
  await audit.record({ action: "search", allow: true });
  await audit.flush();
  const rows = await readAuditLines(file, { limit: 20 });
  assert.equal(rows.filter((row) => row.allow === true).length, 2);
  const aggregates = rows.filter((row) => row.aggregated);
  assert.equal(aggregates.length, 0);
  assert.equal(rows.filter((row) => row.allow === false).length, 2);
});

test("three identical denials conserve exactly three events", async () => {
  const file = path.join(root, "three.jsonl");
  const audit = createAuditLog(file, { now: () => 0 });
  for (let i = 0; i < 3; i += 1) await audit.record(denied());
  await audit.flush();
  const rows = await readAuditLines(file, { limit: 10 });
  assert.equal(rows.filter((row) => row.allow === false).reduce((sum, row) => sum + (row.repeat ?? 1), 0), 3);
  assert.deepEqual(rows.filter((row) => row.aggregated).map((row) => row.repeat), [2]);
});

test("mixed aggregation windows conserve five events and three windows", async () => {
  const file = path.join(root, "mixed-windows.jsonl");
  let now = 0;
  const audit = createAuditLog(file, { now: () => now, aggregationWindowMs: 60_000 });
  await audit.record(denied());
  now = 1;
  await audit.record(denied());
  now = 60_000;
  await audit.record(denied());
  now = 60_001;
  await audit.record(denied());
  now = 120_000;
  await audit.record(denied());
  await audit.flush();
  const rows = await readAuditLines(file, { limit: 20 });
  assert.equal(rows.filter((row) => row.allow === false).reduce((sum, row) => sum + (row.repeat ?? 1), 0), 5);
  assert.equal(rows.filter((row) => row.window_head === true).length, 3);
  assert.equal(rows.filter((row) => row.aggregated).length, 2);
});

test("same key after the time window starts a new aggregation window", async () => {
  const file = path.join(root, "windows.jsonl");
  let now = 0;
  const audit = createAuditLog(file, { now: () => now, aggregationWindowMs: 60_000 });
  await audit.record(denied());
  now = 59_999;
  await audit.record(denied());
  now = 60_000;
  await audit.record(denied());
  await audit.flush();
  const rows = await readAuditLines(file, { limit: 20 });
  assert.equal(rows.filter((row) => row.aggregated).length, 1);
  assert.deepEqual(rows.filter((row) => row.aggregated).map((row) => row.repeat), [1]);
  assert.equal(rows.filter((row) => row.allow === false).length, 3);
});
