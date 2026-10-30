import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditLog, readAuditLines } from "../src/audit.mjs";

test("M1.2 five key lifecycle audit paths redact secret and Authorization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-m1-2-audit-"));
  const auditPath = path.join(root, "audit.jsonl");
  const audit = createAuditLog(auditPath, { aggregationWindowMs: 0 });
  const secret = "FOLLOWUP_SECRET_SHOULD_NEVER_APPEAR";
  const authorization = `Bearer ${secret}`;
  const body = "FOLLOWUP_PRIVATE_BODY_SHOULD_NEVER_APPEAR";
  for (const action of ["key_create", "authenticate", "write", "search", "revoke"]) {
    await audit.record({ action, allow: true, credentialFingerprint: "key:hash-only", secret, Authorization: authorization, headers: { Authorization: authorization }, body, content: body, query: body });
  }
  const raw = await fs.readFile(auditPath, "utf8");
  const events = await readAuditLines(auditPath);
  assert.deepEqual(events.map((event) => event.action), ["key_create", "authenticate", "write", "search", "revoke"]);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes(authorization), false);
  assert.equal(raw.includes("Authorization"), false);
  assert.equal(raw.includes(body), false);
  assert.match(raw, /key:hash-only/u);
  console.log(JSON.stringify({ actions: events.map((event) => event.action), secret_present: raw.includes(secret), authorization_present: raw.includes("Authorization"), body_present: raw.includes(body) }));
  await fs.rm(root, { recursive: true, force: true });
});
