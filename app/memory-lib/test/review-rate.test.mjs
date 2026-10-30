import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeAutoReviewAudit, summarizeReviewStates } from "../scripts/report-review-rate.mjs";
import { compareDryRunAudit } from "../scripts/auto-review-dry-run-compare.mjs";

test("review-rate report uses an explicit review denominator and excludes pending/quarantined", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-review-rate-"));
  await fs.mkdir(path.join(root, "inbox"), { recursive: true });
  const doc = (state, name) => `---\nreviewState: ${state}\nupdatedAt: 2026-09-19T00:00:00.000Z\n---\n# Candidate Memory\n\n${name}\n`;
  await fs.writeFile(path.join(root, "inbox", "a.md"), doc("rejected", "a"));
  await fs.writeFile(path.join(root, "inbox", "b.md"), doc("reviewed", "b"));
  await fs.writeFile(path.join(root, "inbox", "c.md"), doc("pending", "c"));
  await fs.writeFile(path.join(root, "inbox", "d.md"), doc("quarantined", "d"));
  const report = await summarizeReviewStates(root, {});
  assert.deepEqual(report.counts, { rejected: 1, reviewed: 1, pending: 1, quarantined: 1, other: 0 });
  assert.equal(report.reviewToReject.numerator, 1);
  assert.equal(report.reviewToReject.denominator, 2);
  assert.equal(report.reviewToReject.rate, 0.5);
  await fs.rm(root, { recursive: true, force: true });
});

test("dry-run and actual audit decisions compare without candidate content", () => {
  const result = compareDryRunAudit([
    { channel: "auto-review", resourceId: "candidate-1", decision: "reject", rule: "noise-reject", dryRun: true },
    { channel: "auto-review", resourceId: "candidate-1", decision: "reject", rule: "noise-reject", dryRun: false },
    { channel: "auto-review", resourceId: "candidate-2", decision: "leave", rule: null, dryRun: true },
    { channel: "auto-review", resourceId: "candidate-2", decision: "reject", rule: "other", dryRun: false },
  ]);
  assert.equal(result.pairs.length, 3);
  assert.deepEqual(result.mismatches, [], "shared (decision, rule) counts agree");
  assert.equal(result.missing.length, 2, "divergent verdicts are reported as missing keys");
  assert.equal(JSON.stringify(result).includes("candidate content"), false);
});

test("auto-review audit report counts only explicit channel decisions", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-review-audit-")), "audit.jsonl");
  await fs.writeFile(file, [
    JSON.stringify({ channel: "auto-review", decision: "reject", ts: "2026-09-19T00:00:00.000Z" }),
    JSON.stringify({ channel: "auto-review", decision: "leave", ts: "2026-09-19T00:01:00.000Z" }),
    JSON.stringify({ channel: "localhost", action: "/v1/memory/review", allow: true, ts: "2026-09-19T00:02:00.000Z" }),
  ].join("\n"));
  const report = await summarizeAutoReviewAudit(file, {});
  assert.deepEqual(report.counts, { approve: 0, promote: 0, reject: 1, leave: 1, other: 0 });
  assert.equal(report.decisionRejectRate.denominator, 2);
  assert.equal(report.decisionRejectRate.rate, 0.5);
});
