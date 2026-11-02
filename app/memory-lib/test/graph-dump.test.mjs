import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGraphStore, dumpGraph, rebuildGraph } from "../src/graph-retrieval.mjs";

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-dump-"));
  return dir;
}

function event({ id, type = "memory.created", src, predicate, dst, evidence, project = null }) {
  return {
    event_id: id,
    type,
    tenant_id: "default",
    evidence_id: evidence,
    created_at: "2026-01-01T00:00:00.000Z",
    payload: { src_id: src, predicate, dst_id: dst, project, visibility: project ? "project" : "shared" },
  };
}

test("dumpGraph returns nodes, edges and totals from replay events", async () => {
  const dataRoot = await tempRoot();
  const store = createGraphStore({ dataRoot });
  const events = [
    event({ id: "e1", src: "project:demo", predicate: "belongs_to_project", dst: "m1", evidence: "ev1", project: "demo" }),
    event({ id: "e2", src: "m1", predicate: "derived_from", dst: "conversation-abc", evidence: "ev1" }),
    event({ id: "e3", src: "m1", predicate: "related_to", dst: "tag:x", evidence: "ev1" }),
  ];
  for (const item of events) await store.ingest(item, { replay: true });

  const dump = dumpGraph({ dataRoot, limit: 50 });
  assert.equal(dump.totals.edges, 3);
  assert.equal(dump.totals.nodes, 4); // project:demo, m1, conversation-abc, tag:x
  assert.equal(dump.totals.truncated, false);
  const types = Object.fromEntries(dump.nodes.map((n) => [n.id, n.type]));
  assert.equal(types["project:demo"], "project");
  assert.equal(types["tag:x"], "tag");
  assert.equal(types["conversation-abc"], "evidence");
  assert.equal(types["m1"], "memory");
});

test("dumpGraph respects limit and reports truncation", async () => {
  const dataRoot = await tempRoot();
  const store = createGraphStore({ dataRoot });
  for (let i = 0; i < 5; i += 1) {
    await store.ingest(event({ id: `e${i}`, src: "m1", predicate: "derived_from", dst: `conversation-${i}`, evidence: "ev1" }), { replay: true });
  }
  const dump = dumpGraph({ dataRoot, limit: 2 });
  assert.equal(dump.edges.length, 2);
  assert.equal(dump.totals.all_edges, 5);
  assert.equal(dump.totals.truncated, true);
});

test("dumpGraph can filter by project", async () => {
  const dataRoot = await tempRoot();
  const store = createGraphStore({ dataRoot });
  await store.ingest(event({ id: "e1", src: "project:demo", predicate: "belongs_to_project", dst: "m1", evidence: "ev1", project: "demo" }), { replay: true });
  await store.ingest(event({ id: "e2", src: "project:other", predicate: "belongs_to_project", dst: "m2", evidence: "ev2", project: "other" }), { replay: true });
  const demo = dumpGraph({ dataRoot, project: "demo" });
  assert.equal(demo.edges.length, 1);
  assert.equal(demo.edges[0].dst_id, "m1");
  const other = dumpGraph({ dataRoot, project: "other" });
  assert.equal(other.edges.length, 1);
  assert.equal(other.edges[0].dst_id, "m2");
});

test("principal filtering happens before limit so visible edges are not starved", async () => {
  const dataRoot = await tempRoot();
  const store = createGraphStore({ dataRoot });
  // 2 条 user 可见性（admin 无权）排在前面，1 条 shared 在后面
  for (let i = 0; i < 2; i += 1) {
    await store.ingest({
      event_id: "u" + i, type: "memory.created", tenant_id: "default", evidence_id: "ev" + i,
      created_at: "2026-02-0" + (i + 1) + "T00:00:00.000Z",
      payload: { src_id: "u" + i, predicate: "derived_from", dst_id: "conversation-u" + i, visibility: "user", user_id: "someone-else", container: "long-term" },
    }, { replay: true });
  }
  await store.ingest({
    event_id: "s1", type: "memory.created", tenant_id: "default", evidence_id: "evs",
    created_at: "2026-01-01T00:00:00.000Z",
    payload: { src_id: "s1", predicate: "derived_from", dst_id: "conversation-s", visibility: "shared", container: "long-term" },
  }, { replay: true });
  const admin = { tenant_id: "default", user_id: "admin", group_id: "unknown", role_id: "librarian-admin", agent_id: "admin-01" };
  const dump = dumpGraph({ dataRoot, limit: 5, principal: admin });
  assert.equal(dump.edges.length, 1, JSON.stringify(dump.totals));
  assert.equal(dump.edges[0].src_id, "s1");
  assert.equal(dump.totals.all_edges, 3);
});

test("rebuildGraph turns markdown memories into graph edges", async () => {
  const dataRoot = await tempRoot();
  const curated = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(curated, { recursive: true });
  await fs.writeFile(path.join(curated, "m1.md"), [
    "---",
    'id: "m1"',
    'visibility: "shared"',
    'container: "long-term"',
    'project: "demo"',
    'tags: ["alpha", "beta"]',
    'evidence_refs: ["conversation-e1"]',
    'supersedes: ["old-1"]',
    'tenant_id: "default"',
    "---",
    "body",
    "",
  ].join("\n"), "utf8");

  const result = await rebuildGraph({ dataRoot });
  assert.equal(result.linkedFiles, 1);
  const dump = dumpGraph({ dataRoot, limit: 100 });
  const pairs = dump.edges.map((e) => `${e.src_id} ${e.predicate} ${e.dst_id}`);
  assert.ok(pairs.includes("m1 derived_from conversation-e1"), pairs.join(" | "));
  assert.ok(pairs.includes("project:demo belongs_to_project m1"));
  assert.ok(pairs.includes("m1 related_to tag:alpha"));
  assert.ok(pairs.includes("m1 related_to tag:beta"));
  assert.ok(pairs.includes("m1 related_to old-1"));
  assert.ok(dump.nodes.some((n) => n.id === "project:demo" && n.type === "project"));
});

test("nodes carry readable labels, file paths and generic-tag flags", async () => {
  const dataRoot = await tempRoot();
  const curated = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(curated, { recursive: true });
  await fs.writeFile(path.join(curated, "note.md"), [
    "---",
    'id: "note-1"',
    'visibility: "shared"',
    'container: "long-term"',
    'tags: ["alpha", "fact"]',
    'evidence_refs: ["conversation-x"]',
    'tenant_id: "default"',
    "---",
    "这是一条中文摘要标题。",
    "",
  ].join("\n"), "utf8");
  await rebuildGraph({ dataRoot });
  const dump = dumpGraph({ dataRoot, limit: 100 });
  const note = dump.nodes.find((n) => n.id === "note-1");
  assert.ok(note, "memory node present");
  assert.equal(note.label, "这是一条中文摘要标题。");
  assert.equal(note.path, "curated/shared/note.md");
  const alpha = dump.nodes.find((n) => n.id === "tag:alpha");
  assert.equal(alpha.label, "标签：alpha");
  assert.equal(alpha.generic, false);
  const fact = dump.nodes.find((n) => n.id === "tag:fact");
  assert.equal(fact.generic, true, "泛标签必须被标记，前端才能默认隐藏");
});
