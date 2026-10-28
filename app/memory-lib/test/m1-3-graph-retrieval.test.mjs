import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createGraphStore, graphDbPath, jointSearch, rebuildGraph } from "../src/graph-retrieval.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-"));
  const dataRoot = path.join(root, "memory");
  await fs.mkdir(path.join(dataRoot, "evidence", "documents"), { recursive: true });
  const writer = createMemoryWriter({ dataRoot });
  await writer.write({ layer: "document", id: "ev-account-a", body: "Evidence for tenant-a account", evidence_refs: ["evidence:account-a"], principal: { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" }, visibility: "platform" });
  await writer.write({ layer: "document", id: "ev-account-b", body: "Evidence for tenant-b account", evidence_refs: ["evidence:account-b"], principal: { tenant_id: "tenant-b", group_id: "group-b", user_id: "user-b", role_id: "role-b" }, visibility: "platform" });
  return { root, dataRoot, writer, store: createGraphStore({ dataRoot }) };
}

test("M1.3 rejects untrusted predicates and missing evidence, and upserts duplicate events", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const event = { event_id: "evt-a-1", type: "project.linked", tenant_id: "tenant-a", evidence_id: "evidence:account-a", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:one" } };
  await assert.rejects(() => f.store.ingest({ ...event, evidence_id: "missing" }), /evidence not found/);
  await assert.rejects(() => f.store.ingest({ ...event, payload: { ...event.payload, predicate: "invented_relation" } }), /predicate is not allowed/);
  await f.store.ingest(event);
  assert.deepEqual(await f.store.ingest(event), { ok: true, duplicate: true, event_id: "evt-a-1", edges: 0 });
  assert.equal(f.store.edgeRows({ tenantId: "tenant-a" }).length, 1);
  assert.equal(f.store.edgeRows({ tenantId: "tenant-b" }).length, 0);
});

test("M1.3 project graph is tenant filtered and preserves evidence paths", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.ingest({ event_id: "evt-a-2", type: "project.linked", tenant_id: "tenant-a", evidence_id: "evidence:account-a", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:one" } });
  const graph = f.store.projectGraph({ tenantId: "tenant-a", projectId: "project:alpha" });
  assert.deepEqual(graph.memories, ["memory:one"]);
  assert.deepEqual(graph.edges[0].evidence_ids, ["evidence:account-a"]);
  assert.equal(f.store.projectGraph({ tenantId: "tenant-b", projectId: "project:alpha" }).edges.length, 0);
});

test("M1.3 rebuild replays graph events without deleting the FTS/vector database", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.ingest({ event_id: "evt-a-3", type: "project.linked", tenant_id: "tenant-a", evidence_id: "evidence:account-a", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:one" } });
  const before = f.store.stats();
  await fs.mkdir(path.dirname(graphDbPath(f.dataRoot)), { recursive: true });
  const fakeIndex = graphDbPath(f.dataRoot);
  const rebuilt = await rebuildGraph({ dataRoot: f.dataRoot });
  assert.equal(rebuilt.graph.edges, before.edges);
  assert.equal(f.store.stats().edges, 1);
  assert.equal(fakeIndex, graphDbPath(f.dataRoot));
});

test("M1.3 structured builder path does not call a model and joint result is explainable", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.ingest({ event_id: "evt-a-4", type: "project.linked", tenant_id: "tenant-a", evidence_id: "evidence:account-a", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:one" } });
  const result = await jointSearch({ dataRoot: f.dataRoot, tenantId: "tenant-a", query: "account", exact: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:one" }, fetchImpl: async () => { throw new Error("model must not be required"); } });
  assert.equal(result[0].id, "memory:one");
  assert.deepEqual(result[0].matched_by, ["graph"]);
  assert.deepEqual(result[0].graph_path, ["project:alpha", "belongs_to_project", "memory:one"]);
  assert.deepEqual(result[0].evidence_ids, ["evidence:account-a"]);
});
