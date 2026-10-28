import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

test("same-layer ranking exposes configurable recency and importance factors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d7-rank-"));
  try {
    const now = Date.now();
    const write = async (name, updated, importance) => {
      const file = path.join(root, "curated", "shared", name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `---\nid: ${name}\nlayer: semantic\nstatus: active\nimportance: ${importance}\nupdated_at: ${new Date(updated).toISOString()}\n---\n\nshared retrieval phrase\n`);
    };
    await write("recent.md", now - 86400_000, "critical");
    await write("old.md", now - 90 * 86400_000, "ordinary");
    const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null });
    const defaultHits = await lib.search({ query: "shared retrieval phrase", limit: 2, graphExpand: false });
    assert.equal(path.basename(defaultHits[0].path), "recent.md");
    const relevanceOnly = await lib.search({ query: "shared retrieval phrase", limit: 2, graphExpand: false, rankWeights: { relevance: 1, recency: 0, importance: 0 } });
    assert.equal(relevanceOnly.length, 1);
     assert.equal(relevanceOnly[0].family_count, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
