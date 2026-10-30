// memory-lib Slice 1 — production read-only verification.
// Targets I:\OpenClaw\memory-data\memory (read-only) + workspace root I:\OpenClaw\memory-data.
// Run: node scripts/production-readonly-check.mjs
//
// Verifies: health, shared-scope search (results confined to curated/shared),
// get by id, and ZERO writes (byte-identical snapshot before/after).
// NOTE: if the OpenClaw Gateway is concurrently writing during the window,
// the diff may show its writes — re-run on a quiet window to confirm.
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { snapshotTree, diffSnapshots } from "./zero-write-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = "I:\\OpenClaw\\memory-data\\memory";
const WORKSPACE_ROOT = "I:\\OpenClaw\\memory-data";
const SHARED_SCOPE = [{ layer: "memory", visibility: "shared" }];

const lib = createMemoryLib({ dataRoot: DATA_ROOT, workspaceRoot: WORKSPACE_ROOT, scopes: SHARED_SCOPE });

console.log("== Slice 1 production read-only verification ==");
console.log("dataRoot:", DATA_ROOT);
console.log("scope   :", JSON.stringify(SHARED_SCOPE));
console.log("resolved roots:", JSON.stringify(lib.roots, null, 2));

// 1) zero-write baseline
const before = await snapshotTree(WORKSPACE_ROOT);
console.log("\n-- snapshot baseline:", before.length, "files");

// 2) health
const h = await lib.health();
console.log("\n-- health:", h.health);
console.log("   missing checks:", JSON.stringify(h.checks.filter((c) => c.status === "missing")));

let scopeLeaks = 0;

// 3) shared-scope search (a few queries)
for (const q of ["记忆库", "memory", "审批"]) {
  const results = await lib.search({ query: q, limit: 8 });
  const outOfScope = results.filter((r) => !r.path.toLowerCase().includes(`${path.sep}curated${path.sep}shared${path.sep}`));
  scopeLeaks += outOfScope.length;
  console.log(`\n-- search "${q}": ${results.length} hits, out-of-scope: ${outOfScope.length}`);
  for (const r of results.slice(0, 4)) {
    console.log("   ", path.relative(DATA_ROOT, r.path).replace(/\\/g, "/"), `(L${r.line}, ${r.sourceType})`);
  }
}

// 4) get by a real shared id (discover one from curated/shared)
let sampleId = null;
{
  const files = await walkCuratedShared();
  if (files.length) {
    sampleId = files[0].id;
    const got = await lib.get(sampleId);
    console.log(`\n-- get "${sampleId}": ${got ? "OK, path=" + path.relative(DATA_ROOT, got.path) : "NULL"}`);
  } else {
    console.log("\n-- get: no curated/shared items found (unexpected)");
  }
}

// 5) deny checks: agent memory and recovery are outside shared scope.
// "store-ops" may legitimately appear IN shared content; the leak test is that
// every result path stays inside the authorized root (curated/shared).
{
  const agentHit = await lib.search({ query: "store-ops" });
  const leaked = agentHit.filter((r) => !r.path.toLowerCase().includes(`${path.sep}curated${path.sep}shared${path.sep}`));
  scopeLeaks += leaked.length;
  console.log(`\n-- deny-check: search "store-ops" -> ${agentHit.length} hits, leaked(out-of-scope): ${leaked.length} (expect 0)`);
  for (const r of agentHit) console.log("   in-scope:", path.relative(DATA_ROOT, r.path).replace(/\\/g, "/"));
  const getDenied = await lib.get("mem_any_agent_item");
  console.log(`-- deny-check: get unknown/agent id -> ${getDenied === null ? "null (denied, no leak)" : "LEAKED"}`);
}

// 6) zero-write diff
const after = await snapshotTree(WORKSPACE_ROOT);
const changes = diffSnapshots(before, after);
const contentChanges = changes.filter((change) =>
  change.change !== "modified" ||
  change.before?.size !== change.after?.size ||
  change.before?.sha256 !== change.after?.sha256
);
const metadataOnly = changes.filter((change) => !contentChanges.includes(change));
console.log("\n-- zero-write content diff:", contentChanges.length === 0 ? "CLEAN (byte-identical)" : JSON.stringify(contentChanges, null, 2));
if (metadataOnly.length) console.log("-- metadata-only changes:", JSON.stringify(metadataOnly, null, 2));

const result = contentChanges.length !== 0
  ? "SLICE1_PRODUCTION_DIRTY (content changed; may be concurrent Gateway writes)"
  : scopeLeaks !== 0
    ? `SLICE1_SCOPE_LEAK (${scopeLeaks} out-of-scope result(s))`
    : "SLICE1_PRODUCTION_OK";
console.log("\n== RESULT:", result, "==");
process.exit(contentChanges.length !== 0 ? 2 : scopeLeaks !== 0 ? 3 : 0);

async function walkCuratedShared() {
  const out = [];
  const stack = [path.join(DATA_ROOT, "curated", "shared")];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
        const text = await fs.readFile(full, "utf8").catch(() => "");
        const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (m) {
          const fm = {};
          for (const line of m[1].split(/\r?\n/)) {
            const idx = line.indexOf(":");
            if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
          if (fm.id) out.push({ id: fm.id, file: full });
        }
      }
    }
  }
  return out.slice(0, 10);
}
