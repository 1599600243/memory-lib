import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMemoryVersions } from "../src/memory-version.mjs";

test("version decision combines similarity, credential completeness, and time", () => {
  const result = compareMemoryVersions({ body: "The release requires a complete verification report.", evidence_refs: ["e1"], updated_at: "2026-01-01" }, { body: "The release requires a complete verification report!", evidence_refs: ["e1", "e2"], updated_at: "2025-01-01" });
  assert.equal(result.same_fact, true);
  assert.equal(result.evidence_comparison, "b-more-complete");
  assert.equal(result.winner, "b");
  assert.equal(result.reason, "similarity-plus-evidence-and-time");
});
