import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createGraphStore, jointSearch, rebuildGraph, graphDbPath } from "../src/graph-retrieval.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";

async function evidenceFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-followup-"));
  const dataRoot = path.join(root, "memory");
  const writer = createMemoryWriter({ dataRoot });
  await writer.write({ layer: "document", id: "evidence-a", body: "project evidence", evidence_refs: ["ev:a"], principal: { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" }, visibility: "platform" });
  await writer.write({ layer: "document", id: "evidence-b", body: "other project evidence", evidence_refs: ["ev:b"], principal: { tenant_id: "tenant-a", group_id: "group-b", user_id: "user-b", role_id: "role-b" }, visibility: "platform" });
  return { root, dataRoot };
}

test("M1.3 hotfix: real writer ignores retired old graph database filename", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-hotfix1-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "memory");
  const oldPath = path.join(dataRoot, "indexes", "sqlite", "memory-graph.sqlite");
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  const oldDb = new DatabaseSync(oldPath);
  oldDb.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE edges (from_id TEXT, to_id TEXT, type TEXT, weight REAL, source TEXT); CREATE TABLE file_index (path TEXT PRIMARY KEY, hash TEXT);");
  oldDb.prepare("INSERT INTO nodes(id, data) VALUES(?, ?)").run("legacy-node", "legacy");
  oldDb.close();
  const before = await fs.readFile(oldPath);
  const writer = createMemoryWriter({ dataRoot });
  const written = await writer.write({ layer: "project-decision", id: "collision-decision", project: "alpha", body: "collision-safe decision", evidence_refs: ["ev:collision"], principal: { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" } });
  assert.equal(written.ok, true);
  assert.equal(await fs.readFile(path.join(dataRoot, "project-state", "alpha", "decisions", "collision-decision.md")).then(() => true), true);
  const store = createGraphStore({ dataRoot });
  assert.equal(store.stats().edges, 1);
  assert.equal(await fs.readFile(oldPath).then((value) => crypto.createHash("sha256").update(value).digest("hex")), crypto.createHash("sha256").update(before).digest("hex"));
  assert.notEqual(store.dbPath, oldPath);
});

test("M1.3 followup: real writer project decision creates a visible project edge", async (t) => {
  const f = await evidenceFixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const store = createGraphStore({ dataRoot: f.dataRoot });
  const writer = createMemoryWriter({ dataRoot: f.dataRoot });
  const written = await writer.write({ layer: "project-decision", id: "decision-1", project: "alpha", body: "choose account", evidence_refs: ["ev:a"], principal: { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" } });
  assert.equal(written.ok, true);
  const lib = createMemoryLib({ dataRoot: f.dataRoot, principal: { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" } });
  const graph = await lib.graph({ tenantId: "tenant-a", projectId: "alpha" });
  assert.deepEqual(graph.memories, ["decision-1"]);
  assert.equal((await fs.readFile(store.eventPath, "utf8")).split("\n").filter(Boolean).length, 1);
  const before = store.stats().edges;
  await fs.rm(graphDbPath(f.dataRoot), { force: true });
  await fs.rm(store.eventPath, { force: true });
  const rebuilt = await rebuildGraph({ dataRoot: f.dataRoot });
  assert.equal(rebuilt.graph.edges, before);
});

test("M1.3 followup: graph and joint search share principal visibility", async (t) => {
  const f = await evidenceFixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const store = createGraphStore({ dataRoot: f.dataRoot });
  const writer = createMemoryWriter({ dataRoot: f.dataRoot });
  await writer.write({ layer: "project-decision", id: "decision-a", project: "alpha", body: "group a decision", evidence_refs: ["ev:a"], principal: { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" } });
  await writer.write({ layer: "project-decision", id: "decision-b", project: "alpha", body: "group b decision", evidence_refs: ["ev:b"], principal: { tenant_id: "tenant-a", group_id: "group-b", user_id: "user-b", role_id: "role-b" } });
  const principalA = { tenant_id: "tenant-a", group_id: "group-a", user_id: "user-a", role_id: "role-a" };
  const libA = createMemoryLib({ dataRoot: f.dataRoot, principal: principalA });
  const graphA = await libA.graph({ tenantId: "tenant-a", projectId: "alpha", principal: principalA });
  const jointA = await jointSearch({ dataRoot: f.dataRoot, tenantId: "tenant-a", principal: principalA, query: "decision", exact: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "decision-a" }, fetchImpl: async () => { throw new Error("model must not be called"); } });
  assert.deepEqual(graphA.memories, ["decision-a"]);
  assert.ok(jointA.every((row) => !row.matched_by.includes("graph") || graphA.edges.some((edge) => edge.dst_id === row.id)));
  assert.deepEqual((await libA.graph({ tenantId: "tenant-a", projectId: "alpha", principal: { tenant_id: "tenant-a", group_id: "group-b", user_id: "user-b", role_id: "role-b" } })).memories, ["decision-b"]);
});

test("M1.3 followup: platform relation is visible across groups", async (t) => {
  const f = await evidenceFixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const writer = createMemoryWriter({ dataRoot: f.dataRoot });
  await writer.write({ layer: "document", id: "knowledge-item", body: "shared knowledge", evidence_refs: ["ev:a"], owned_by_account: "account:QQ", principal: { tenant_id: "tenant-a", group_id: "group-a" } });
  const lib = createMemoryLib({ dataRoot: f.dataRoot, principal: { tenant_id: "tenant-a", group_id: "group-b", user_id: "user-b", role_id: "role-b" } });
  const graph = await lib.graph({ tenantId: "tenant-a", projectId: "knowledge-item", principal: { tenant_id: "tenant-a", group_id: "group-b", user_id: "user-b", role_id: "role-b" } });
  assert.deepEqual(graph.entities, ["account:QQ"]);
});

test("M1.3 followup: batch writer events rebuild and preserve FTS database", async (t) => {
  const f = await evidenceFixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const store = createGraphStore({ dataRoot: f.dataRoot });
  await store.ingestMany([
    { event_id: "batch-1", type: "project.linked", tenant_id: "tenant-a", evidence_id: "ev:a", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:one" } },
    { event_id: "batch-2", type: "project.linked", tenant_id: "tenant-a", evidence_id: "ev:a", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "memory:two" } },
  ]);
  const eventText = await fs.readFile(store.eventPath, "utf8");
  assert.equal(eventText.split("\n").filter(Boolean).length, 2);
  const ftsPath = path.join(f.dataRoot, "indexes", "sqlite", "memory-lib-index.sqlite");
  await fs.mkdir(path.dirname(ftsPath), { recursive: true });
  await fs.writeFile(ftsPath, "sentinel", "utf8");
  const before = await fs.readFile(ftsPath, "utf8");
  const beforeCount = store.stats().edges;
  await fs.rm(graphDbPath(f.dataRoot), { force: true });
  await fs.rm(store.eventPath);
  await fs.writeFile(store.eventPath, eventText, "utf8");
  const rebuilt = await rebuildGraph({ dataRoot: f.dataRoot });
  assert.equal(rebuilt.graph.edges, beforeCount);
  assert.equal(await fs.readFile(ftsPath, "utf8"), before);
});
