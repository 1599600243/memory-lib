import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createColdLayer } from "../src/cold-layer.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createMaintenanceScheduler } from "../src/maintenance-scheduler.mjs";
test("cold preserves existing frontmatter spellings and retrieves by unquoted id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d15-5-format-"));
  const dir = path.join(root, "curated", "shared"); await fs.mkdir(dir, { recursive: true });
  const original = "---\nid: project-openclaw-agent-memory-reconciler\ntags: reconciler, agent-memory, automation, maintenance\ncreatedAt: 2025-01-01T00:00:00.000Z\nstatus: active\nupdatedAt: 2025-01-01T00:00:00.000Z\n---\n\nCold body";
  const source = path.join(dir, "entry.md"); await fs.writeFile(source, original);
  const cold = createColdLayer({ dataRoot: root, now: () => Date.parse("2026-09-29T00:00:00.000Z") });
  const result = await cold.cold({ olderThanDays: 30, maxRecallCount: 0 });
  assert.equal(result.cold, 1);
  const target = result.items[0].target;
  const moved = await fs.readFile(target, "utf8");
  const movedHeader = moved.split("---")[1].trim().split(/\r?\n/u);
  const originalHeader = original.split("---")[1].trim().split(/\r?\n/u);
  for (const key of ["id", "tags", "createdAt", "updatedAt"]) assert.equal(movedHeader.find((line) => line.startsWith(`${key}:`)), originalHeader.find((line) => line.startsWith(`${key}:`)));
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: [{ layer: "memory", visibility: "shared" }] });
  const item = await lib.get("project-openclaw-agent-memory-reconciler", { include_cold: true });
  assert.equal(item.frontmatter.id, "project-openclaw-agent-memory-reconciler");
  assert.equal(item.frontmatter.cold_reason, "old-and-zero-recall");
});

test("cold uses camelCase timestamps and reports skip reasons", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d15-4-cold-"));
  const dir = path.join(root, "curated", "shared"); await fs.mkdir(dir, { recursive: true });
  const base = (id, date, extra = "") => `---\nid: ${id}\nstatus: active\nupdatedAt: ${date}\n${extra}---\n\nbody ${id}`;
  await fs.writeFile(path.join(dir, "camel.md"), base("camel", "2025-01-01T00:00:00.000Z"));
  await fs.writeFile(path.join(dir, "fresh.md"), base("fresh", "2026-09-28T00:00:00.000Z"));
  await fs.writeFile(path.join(dir, "recalled.md"), base("recalled", "2025-01-01T00:00:00.000Z"));
  const cold = createColdLayer({ dataRoot: root, countFor: async (file) => file.endsWith("recalled.md") ? 3 : 0, now: () => Date.parse("2026-09-29T00:00:00.000Z") });
  const result = await cold.cold({ olderThanDays: 30, maxRecallCount: 0 });
  assert.equal(result.cold, 1);
  assert.equal(result.skipped.not_expired, 1);
  assert.equal(result.skipped.high_recall, 1);
  assert.equal(result.skipped.unparsable_time, 0);
});

test("cold item is hidden by default and retrievable with include_cold", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d15-4-get-"));
  const dir = path.join(root, "curated", "shared", "_cold-2026-09-01"); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "cold.md"), "---\nid: cold-item\nstatus: cold\ncold_since: 2026-09-01T00:00:00.000Z\ncold_reason: old-and-zero-recall\ncold_original_path: /original/cold.md\n---\n\nCold body");
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: [{ layer: "memory", visibility: "shared" }] });
  assert.equal(await lib.get("cold-item"), null);
  assert.deepEqual(await lib.search({ query: "Cold body" }), []);
  const item = await lib.get("cold-item", { include_cold: true });
  assert.equal(item.frontmatter.status, "cold");
  assert.equal(item.frontmatter.cold_since, "2026-09-01T00:00:00.000Z");
  assert.equal(item.frontmatter.cold_reason, "old-and-zero-recall");
  assert.equal(item.frontmatter.cold_original_path, "/original/cold.md");
});

test("maintenance report persists cold skip and protected cluster detail", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d15-4-report-"));
  const librarian = { run: async ({ run_id }) => ({ status: "completed", run_id, report: { cold_added: 0, cold_skipped: { not_expired: 3, high_recall: 2, unparsable_time: 1, missing_id: 1 }, chained_clusters: [{ members: ["a", "b", "c"], min_similarity: 0.71, max_similarity: 0.95, threshold: 0.72, recommendation: "human-review-or-higher-threshold" }], oversized_clusters: [{ members: ["x1", "x2", "x3", "x4", "x5", "x6"], min_similarity: 0.96, max_similarity: 1, threshold: 0.95 }] }, chained_clusters: [{ members: ["a", "b", "c"] }], oversized_clusters: [{ members: ["x1", "x2", "x3", "x4", "x5", "x6"] }] }) };
  const scheduler = createMaintenanceScheduler({ librarian, dataRoot: root, now: () => Date.parse("2026-09-29T12:00:00.000Z") });
  const result = await scheduler.run("monthly", { force: true, run_id: "d15-4-report" });
  const persisted = JSON.parse(await fs.readFile(result.report_path, "utf8"));
  assert.equal(persisted.report.cold_skipped.not_expired, 3);
  assert.deepEqual(persisted.report.chained_clusters[0].members, ["a", "b", "c"]);
  assert.equal(persisted.report.oversized_clusters[0].members.length, 6);
});
