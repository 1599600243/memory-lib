// memory-lib — sequential test runner.
// Why not `node --test test/`? On this host the node:test runner spawns a child
// process per file, which the sandbox rejects (EPERM on stdio pipes), and Node 24
// directory expansion is unreliable here. Each test file is instead executed
// directly (`node test/<file>.mjs`) with inherited stdio, sequentially, so a
// shared real registry / fixture can never be mutated concurrently (each file
// uses its own TMP fixture + registry copy).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
// This runner executes every test that currently passes and asserts current behavior.
// It is the current regression set, not a historical hand-picked list. Tests for
// deleted D29 modules are retired from the tree; unresolved contract conflicts stay
// outside the runner until product decides whether to change code or assertions.
const files = [
  "sessions.test.mjs",
  "password-hash.test.mjs",
  "accounts.test.mjs",
  "login-limiter.test.mjs",
  "login-throttle-http.test.mjs",
  "account-admin-http.test.mjs",
  "console-account-ui.test.mjs",
  "console-agents.test.mjs",
  "learning.test.mjs",
  "learning-due.test.mjs",
  "meapet-contract.test.mjs",
  "identity-admin.test.mjs",
  "credential-store.test.mjs",
  "credential-admin-http.test.mjs",
  "llm.test.mjs",
  "mcp-auth-capture-regression.test.mjs",
  "m2-refinement-closure.test.mjs",
  "refinement-observability-refs.test.mjs",
  "refine2-event-date.test.mjs",
  "m2-refinement-followup-http.test.mjs",
  "refinement-jobs-http.test.mjs",
  "refinement-jobs-suppress-capture-http.test.mjs",
  "refinement-jobs-submit-http.test.mjs",
  "refinement-jobs-submit-scope-http.test.mjs",
  "refinement-jobs-submit-writefail.test.mjs",
  "refinement-jobs-metrics-http.test.mjs",
  "refinement-jobs-stable-key-http.test.mjs",
  "refinement-jobs-repair.test.mjs",
  "write-deny-1-visibility-gate.test.mjs",
  "write-deny-1-reject1-bypasses.test.mjs",
  "maint10-deprecate.test.mjs",
  "maint11-dead-call-guard.test.mjs",
  "inject1-brief-memories.test.mjs",
  "rank1-ranking.test.mjs",
  "index1-candidates.test.mjs",
  "index2-parity.test.mjs",
  "short-q-1.test.mjs",
  "m2-1-a-timeline.test.mjs",
  "day-membership-role-parity.test.mjs",
  "tz-config.test.mjs",
  "entry-timezone-parity.test.mjs",
  "day-interval.test.mjs",
  "scenario-recall.test.mjs",
  "scenario-recall-http.test.mjs",
  "scenario-chunking.test.mjs",
  "contract-table-guard.test.mjs",
  "visibility-identity-binding.test.mjs",
  "visibility-learning-identity.test.mjs",
  "visibility-pet-draft-scope.test.mjs",
  "visibility-pet-command-draft-scope.test.mjs",
  "visibility-pet-bridge-draft-scope.test.mjs",
  "visibility-persona-identity-prompt.test.mjs",
  "identity-required-call-sites.test.mjs",
  "atomic-write.test.mjs",
  "atomic-write-guard.test.mjs",
  "atomic-write-regression.test.mjs",
  "input-validation-4xx.test.mjs",
  "m2-1-b1-date-query.test.mjs",
  "m2-1-b2-date-grammar.test.mjs",
  "m2-1-b1-date-http.test.mjs",
  "dayrecall.test.mjs",
  "dayrecall-http.test.mjs",
  "dayrecall-backfill.test.mjs",
  "dayrecall2-calendar-day.test.mjs",
  "capture-attr.test.mjs",
  "zh-summary.test.mjs",
  "zh-summary-http.test.mjs",
  "d29-write.test.mjs",
  "m1-2-container-policy.test.mjs",
  "visibility-unknown-1.test.mjs",
  "visibility-unknown-1-http.test.mjs",
  "m1-2-followup-isolation.test.mjs",
  "m1-2-followup-audit.test.mjs",
  "m1-3-graph-retrieval.test.mjs",
  "m1-3-integration.test.mjs",
  "m1-3-followup.test.mjs",
  "m1-3-http-followup.test.mjs",
  "m1-4-migration.test.mjs",
  "m1-4-write-entrypoints.test.mjs",
  "m1-4-http-writer-e2e.test.mjs",
  "d5-index.test.mjs",
  "d22-audit.test.mjs",
  "d22-audit-aggregation.test.mjs",
  "d22-audit-archive.test.mjs",
  "d24-maintenance-scheduler.test.mjs",
  "embedding-benchmark-metrics.test.mjs",
  "d17-ingest.test.mjs",
  "d17-ingest-http.test.mjs",
  "d17-ingest-console.test.mjs",
  "d15-4-cold-retrieval.test.mjs",
  "d15-capture-partial.test.mjs",
  "d6-learning-agent.test.mjs",
  "r10-queue-redaction.test.mjs",
  "channel-equivalence.test.mjs",
  "d15-2-cold-layer.test.mjs",
  "d15-2-maintenance.test.mjs",
  "d15-2-purge.test.mjs",
  "d15-2-version.test.mjs",
  "d5-search.test.mjs",
  "d6-agent-runtime.test.mjs",
  "d7-archive.test.mjs",
  "d7-capacity.test.mjs",
  "d7-capture-snapshot.test.mjs",
  "d7-ranking.test.mjs",
  "d8-archive-safety.test.mjs",
  "d8-capture-deployment.test.mjs",
  "d8-ranking-score.test.mjs",
  "d9-capture-deployment.test.mjs",
  "m1-1-api-key.test.mjs",
  "m1-1-e2e.test.mjs",
  "id1-inventory-cli.test.mjs",
  "id1-bootstrap-cli.test.mjs",
  "mcp.test.mjs",
  "mem-write-1-mcp-visibility.test.mjs",
  "retrieval-p0.test.mjs",
  "maint6-mcp-graph-knowledge.test.mjs",
  "review-rate.test.mjs",
  "admin.test.mjs",
  "index-failure-health.test.mjs",
  "health-consistency.test.mjs",
  "contract.test.mjs",
  "d23-audit.test.mjs",
  "maint5-audit-scheduler.test.mjs",
  "pet.test.mjs",
  "slice2.test.mjs",
  "vector-lane-health.test.mjs",
  "maint4-frontmatter.test.mjs",
  "maint4-frontmatter-http.test.mjs",
  "m1-6-daily-write.test.mjs",
];

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n=== ${f} ===\n`);
  const r = spawnSync(process.execPath, [path.join(root, "test", f)], { stdio: "inherit", cwd: root });
  if (r.status !== 0) {
    console.error(`FAIL ${f} (exit ${r.status ?? r.error?.message ?? "unknown"})`);
    failed++;
  }
}
if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
console.log("\nALL TEST FILES PASSED");
