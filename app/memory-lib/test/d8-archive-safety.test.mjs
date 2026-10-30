import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryArchiver } from "../src/archive-memory.mjs";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d8-archive-"));
  const dir = path.join(root, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  return { root, dir };
}

test("archive parses quoted timestamps and falls back to occurred/created/mtime", async () => {
  const { root, dir } = await makeRoot();
  try {
    await fs.writeFile(path.join(dir, "quoted.md"), "---\nid: quoted\nstatus: active\nupdated_at: '2026-01-01T00:00:00.000Z'\n---\n\nold\n");
    await fs.writeFile(path.join(dir, "occurred.md"), "---\nid: occurred\nstatus: active\noccurred_at: 2026-01-01T00:00:00.000Z\n---\n\nold\n");
    await fs.writeFile(path.join(dir, "created.md"), "---\nid: created\nstatus: active\ncreated_at: 2026-01-01T00:00:00.000Z\n---\n\nold\n");
    await fs.mkdir(path.join(root, "runtime"), { recursive: true });
    await fs.writeFile(path.join(root, "runtime", "recall-counts.json"), "{}\n");
    const result = await createMemoryArchiver({ dataRoot: root, now: () => Date.parse("2026-09-27T00:00:00.000Z"), recallCountsPath: path.join(root, "runtime", "recall-counts.json"), countFor: async () => 0 }).archive();
    assert.equal(result.archived, 3);
    assert.equal(result.eligible, 3);
    assert.equal(result.active, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("archive refuses to run before recall counts are available", async () => {
  const { root, dir } = await makeRoot();
  try {
    await fs.writeFile(path.join(dir, "old.md"), "---\nid: old\nstatus: active\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\nold\n");
    await assert.rejects(() => createMemoryArchiver({ dataRoot: root, countFor: async () => 0, recallCountsPath: path.join(root, "runtime", "missing.json") }).archive(), /recall counts/i);
    assert.equal(await fs.access(path.join(dir, "old.md")).then(() => true).catch(() => false), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
