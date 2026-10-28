import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createColdLayer } from "../src/cold-layer.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";

test("cold layer moves an old zero-recall memory and keeps it recoverable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d15-2-cold-"));
  const source = path.join(root, "curated", "shared", "old.md");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, `---\nid: old\nlayer: semantic\nkind: fact\nstatus: active\nupdated_at: 2020-01-01T00:00:00.000Z\nevidence_refs: ["evidence:old"]\nsource_episodes: ["ep-old"]\n---\nOld durable fact.\n`);
  const events = [];
  const cold = createColdLayer({ dataRoot: root, countFor: async () => 0, audit: { record: async (event) => events.push(event) }, now: () => Date.parse("2026-10-01T00:00:00.000Z") });
  const result = await cold.cold({ olderThanDays: 90, maxRecallCount: 0 });
  assert.equal(result.cold, 1);
  assert.equal(result.items[0].id, "old");
  assert.equal(result.items[0].recallCount, 0);
  assert.equal((await cold.inventory()).cold, 1);
  assert.equal(await fs.stat(source).then(() => true).catch(() => false), false);
  const moved = result.items[0].target;
  const parsed = parseFrontmatterTyped(await fs.readFile(moved, "utf8"));
  assert.equal(parsed.frontmatter.status, "cold");
  assert.equal(parsed.frontmatter.cold_reason, "old-and-zero-recall");
  assert.equal(parsed.frontmatter.cold_since, "2026-10-01T00:00:00.000Z");
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "cold");
  const restored = await cold.retrieve("old");
  assert.equal(restored.frontmatter.id, "old");
  const refreshed = await cold.refresh("old", { reason: "new-evidence", body: "Updated durable fact.", evidence_refs: ["evidence:new"], source_episodes: ["ep-new"] });
  assert.equal(refreshed.frontmatter.status, "active");
  assert.deepEqual(new Set(refreshed.frontmatter.evidence_refs), new Set(["evidence:old", "evidence:new"]));
  assert.equal(events[1].action, "refresh");
});

test("cold layer leaves frequently borrowed old memories active", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d15-2-hot-"));
  const source = path.join(root, "project-state", "demo", "old.md");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, `---\nid: hot-old\nlayer: semantic\nkind: fact\nstatus: active\nupdated_at: 2020-01-01T00:00:00.000Z\n---\nFrequently used fact.\n`);
  const cold = createColdLayer({ dataRoot: root, countFor: async () => 12, now: () => Date.parse("2026-10-01T00:00:00.000Z") });
  const result = await cold.cold({ olderThanDays: 90, maxRecallCount: 2 });
  assert.equal(result.cold, 0);
  assert.equal(result.refresh_candidates.length, 1);
  assert.equal(result.refresh_candidates[0].id, "hot-old");
});
