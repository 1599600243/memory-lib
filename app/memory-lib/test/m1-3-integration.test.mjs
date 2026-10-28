import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-int-"));
  const dataRoot = path.join(root, "memory");
  const writer = createMemoryWriter({ dataRoot });
  await writer.write({ layer: "document", id: "int-evidence", body: "tenant-specific account evidence", evidence_refs: ["evidence:int"], principal: { group_id: "group-a", user_id: "user-a", role_id: "role-a" }, visibility: "platform" });
  return { root, dataRoot, writer };
}

test("M1.3 createMemoryLib exposes graph rebuild and tenant-filtered joint search", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const lib = createMemoryLib({ dataRoot: f.dataRoot, workspaceRoot: f.root, scopes: null, vectorLane: { probe: false } });
  await lib.ingestGraphEvent({ event_id: "int-event", type: "project.linked", tenant_id: "tenant-a", evidence_id: "evidence:int", payload: { src_id: "project:int", predicate: "belongs_to_project", dst_id: "account:tenant-a" } });
  const graph = await lib.graph({ tenantId: "tenant-a", projectId: "project:int" });
  assert.deepEqual(graph.memories, ["account:tenant-a"]);
  assert.equal((await lib.graph({ tenantId: "tenant-b", projectId: "project:int" })).edges.length, 0);
  const rebuilt = await lib.rebuildGraph();
  assert.equal(rebuilt.graph.edges, 1);
  const joint = await lib.jointSearch({ tenantId: "tenant-a", query: "account", exact: { src_id: "project:int", predicate: "belongs_to_project", dst_id: "account:tenant-a" }, fetchImpl: async () => { throw new Error("no model"); } });
  assert.deepEqual(joint[0].matched_by, ["graph"]);
});

test("daily search expands visible project relations by default and exposes graph provenance", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.dataRoot, "project-state", "int", "decision.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---
id: decision-int
layer: project
container: project
tenant_id: tenant-a
visibility: project
group_id: group-a
project: int
status: active
---

Daily graph search marker
`, "utf8");
  await fs.mkdir(path.join(f.dataRoot, "evidence"), { recursive: true });
  await fs.writeFile(path.join(f.dataRoot, "evidence", "graph-evidence.md"), "graph evidence", "utf8");
  const { createGraphStore } = await import("../src/graph-retrieval.mjs");
  await createGraphStore({ dataRoot: f.dataRoot }).ingest({ event_id: "daily-search-edge", type: "project.linked", tenant_id: "tenant-a", evidence_id: "graph-evidence", payload: { src_id: "project:int", predicate: "belongs_to_project", dst_id: "decision-int", visibility: "project", group_id: "group-a", project: "int", container: "project" } });
  const principal = { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
  const lib = createMemoryLib({ dataRoot: f.dataRoot, workspaceRoot: f.root, scopes: null, principal, vectorLane: { probe: false }, fileFirstScanCap: 100 });
  assert.deepEqual((await lib.graph({ tenantId: "tenant-a", projectId: "int", principal })).memories, ["decision-int"]);
  const hits = await lib.search({ query: "Daily graph search marker", limit: 5 });
  const hit = hits.find((item) => item.path === file);
  assert.ok(hit, `daily search should return the project memory: ${JSON.stringify(hits)}`);
  assert.ok(hit.matched_by?.includes("graph"), JSON.stringify(hits));
  assert.deepEqual(hit.graph_path, ["project:int", "belongs_to_project", "decision-int"]);
  assert.deepEqual(hit.evidence_ids, ["graph-evidence"]);
  const disabled = await lib.search({ query: "Daily graph search marker", limit: 5, graphExpand: false });
  assert.ok(!disabled.some((item) => item.path === file && item.matched_by?.includes("graph")));
});

test("M1.3 existing search remains unchanged when graph expansion is disabled", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.writer.write({ layer: "curated-shared", id: "existing-search", body: "stable M1.2 search text", evidence_refs: ["evidence:int"], principal: { group_id: "group-a", user_id: "user-a", role_id: "role-a" }, visibility: "platform" });
  const lib = createMemoryLib({ dataRoot: f.dataRoot, workspaceRoot: f.root, scopes: null, vectorLane: { probe: false }, fileFirstScanCap: 100 });
  const result = await lib.search({ query: "stable M1.2 search text", graphExpand: false, limit: 5 });
  assert.ok(result.some((item) => String(item.path ?? "").endsWith(`${path.sep}existing-search.md`) || String(item.excerpt ?? "").includes("stable M1.2 search text")));
});
