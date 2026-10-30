import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryArchiver } from "../src/archive-memory.mjs";

 test("archive moves old low-recall active memory and preserves bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d7-archive-"));
  try {
    const old = path.join(root, "curated", "shared", "old.md");
    const kept = path.join(root, "curated", "shared", "kept.md");
    const oldDate = "2026-06-19T00:00:00.000Z";
    const oldText = `---\nid: old\nstatus: active\nupdated_at: ${oldDate}\n---\n\nOld durable fact.\n`;
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, oldText);
    await fs.writeFile(kept, oldText.replace("old", "kept"));
    await fs.mkdir(path.join(root, "runtime"), { recursive: true });
    await fs.writeFile(path.join(root, "runtime", "recall-counts.json"), "{}\n");
    const events = [];
    const archiver = createMemoryArchiver({ dataRoot: root, now: () => Date.parse("2026-09-27T00:00:00.000Z"), countFor: async (file) => file.endsWith("kept.md") ? 5 : 0, audit: { record: async (event) => events.push(event) } });
    const result = await archiver.archive();
    assert.equal(result.archived, 1);
    assert.equal(await fs.readFile(path.join(root, "curated", "shared", "_legacy-2026-09-27", "old.md"), "utf8"), oldText);
    assert.equal(await fs.access(kept).then(() => true).catch(() => false), true);
    assert.equal(events[0].recallCount, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
