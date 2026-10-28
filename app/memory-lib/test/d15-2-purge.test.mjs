import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createColdLayer } from "../src/cold-layer.mjs";

async function fixture(status = "cold") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-purge-"));
  const dir = status === "cold" ? path.join(root, "curated", "_cold-2026-09-01") : path.join(root, "curated");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "purge-me.md");
  await fs.writeFile(file, `---\nid: purge-me\nstatus: ${status}\ncold_original_path: ${path.join(root, "curated", "purge-me.md")}\n---\n\n# item\n`, "utf8");
  return { root, file };
}

test("purge rejects active entries and preserves the file", async () => {
  const { root, file } = await fixture("active");
  const cold = createColdLayer({ dataRoot: root, backupAvailable: async () => true });
  const result = await cold.purge({ ids: ["purge-me"], reason: "test", dry_run: true, principal: { agent_id: "a", role_id: "admin" } });
  assert.equal(result.status, "rejected");
  assert.equal(result.items[0].reason, "NOT_COLD");
  assert.ok(await fs.stat(file));
});

test("purge dry-run returns explicit impact and does not delete", async () => {
  const { root, file } = await fixture();
  const cold = createColdLayer({ dataRoot: root, backupAvailable: async () => true });
  const result = await cold.purge({ ids: ["purge-me"], reason: "test", dry_run: true, principal: { agent_id: "a", role_id: "librarian" } });
  assert.equal(result.status, "dry-run");
  assert.equal(result.count, 1);
  assert.equal(result.items[0].id, "purge-me");
  assert.ok(await fs.stat(file));
});

test("purge deletes only after dry-run manifest and backup availability", async () => {
  const { root, file } = await fixture();
  const audit = [];
  const cold = createColdLayer({ dataRoot: root, backupAvailable: async () => true, audit: { record: async (event) => audit.push(event) } });
  const preview = await cold.purge({ ids: ["purge-me"], reason: "user requested", dry_run: true, principal: { agent_id: "a", role_id: "admin" } });
  assert.equal(preview.status, "dry-run");
  const result = await cold.purge({ ids: ["purge-me"], reason: "user requested", dry_run: false, principal: { agent_id: "a", role_id: "admin" } });
  assert.equal(result.status, "completed");
  await assert.rejects(fs.stat(file));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "purge");
  assert.equal(audit[0].resourceId, "purge-me");
});

test("purge refuses formal deletion when backup is unavailable", async () => {
  const { root, file } = await fixture();
  const cold = createColdLayer({ dataRoot: root, backupAvailable: async () => false });
  await cold.purge({ ids: ["purge-me"], reason: "test", dry_run: true, principal: { agent_id: "a", role_id: "admin" } });
  const result = await cold.purge({ ids: ["purge-me"], reason: "test", dry_run: false, principal: { agent_id: "a", role_id: "admin" } });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "BACKUP_UNAVAILABLE");
  assert.ok(await fs.stat(file));
});
