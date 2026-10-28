import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCapacityReport } from "../src/capacity-report.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d7-capacity-"));
test.after(() => fs.rm(root, { recursive: true, force: true }));

test("capacity report counts active refined and raw files and excludes inactive/legacy", async () => {
  const files = [
    ["curated/shared/a.md", "status: active"],
    ["project-state/demo/b.md", "status: active"],
    ["episodes/day/e.md", "status: active"],
    ["evidence/conversations/raw.md", "status: active"],
    ["curated/shared/old.md", "status: deprecated"],
    ["curated/shared/_legacy-2026/archived.md", "status: active"],
  ];
  for (const [relative, fm] of files) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\n${fm}\n---\n\nfixture\n`);
  }
  const report = await buildCapacityReport(root);
  assert.equal(report.refined, 2);
  assert.equal(report.raw, 2);
  assert.equal(report.refinedToRawRatio, 1);
});

test("capacity report represents an empty raw denominator without infinity", async () => {
  const report = await buildCapacityReport(path.join(root, "empty"));
  assert.equal(report.raw, 0);
  assert.equal(report.refinedToRawRatio, null);
});
