// 2026-11-02：图检索多跳扩展 + 检索元信息（prefiltered）回归。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGraphStore, jointSearch } from "../src/graph-retrieval.mjs";
import { createIndexStore } from "../src/index-store.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";

const fakeEmbed = async () => ({ ok: false, status: 503, json: async () => ({}) });
const OWNER = { tenant_id: "default", framework_id: "f", agent_id: "qq-bot", role_id: "chat-reader", group_id: "qq", user_id: "u-owner" };

async function graphFixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "graph-multihop-"));
  const store = createGraphStore({ dataRoot });
  const link = (eventId, src, dst) => store.ingest({
    event_id: eventId,
    type: "memory.created",
    tenant_id: "default",
    evidence_id: "ev-1",
    payload: { src_id: src, predicate: "related_to", dst_id: dst, visibility: "platform" },
  }, { replay: true });
  await link("e1", "m-a", "m-b");
  await link("e2", "m-b", "m-c");
  await link("e3", "m-c", "m-d");
  return { dataRoot };
}

test("jointSearch expands one hop by default and up to depth hops when asked", async () => {
  const { dataRoot } = await graphFixture();
  const base = {
    dataRoot, tenantId: "default", query: "zzz-no-such-token-zzz", limit: 20,
    exact: { src_id: "m-a", predicate: "related_to", dst_id: "m-b" }, fetchImpl: fakeEmbed,
  };
  // depth = 从命中结果再往外走几跳：命中 m-b 本身不算跳。
  const one = await jointSearch({ ...base, depth: 1 });
  const oneIds = one.map((item) => item.id);
  assert.ok(oneIds.includes("m-b"), JSON.stringify(oneIds));
  assert.ok(oneIds.includes("m-c"), JSON.stringify(oneIds));
  assert.ok(!oneIds.includes("m-d"), `depth=1 should not reach m-d: ${JSON.stringify(oneIds)}`);

  const two = await jointSearch({ ...base, depth: 2 });
  const twoIds = two.map((item) => item.id);
  assert.ok(twoIds.includes("m-d"), JSON.stringify(twoIds));
  const hop2 = two.find((item) => item.id === "m-d");
  assert.ok(hop2.matched_by.some((lane) => lane.startsWith("graph:hop2")), JSON.stringify(hop2.matched_by));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("searchWithMeta reports prefiltered and lane counts", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "search-meta-"));
  const dir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "owner.md"), [
    "---", 'id: "owner-1"', 'layer: "long-term"', 'container: "long-term"', 'visibility: "user"',
    'status: "active"', 'user_id: "u-owner"', 'group_id: "qq"', 'tenant_id: "default"', "---", "", "主人爱吃米饭。", "",
  ].join("\n"), "utf8");
  const store = createIndexStore({ dataRoot, ollama: { dimension: 1 }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ embedding: [1] }) }) });
  const indexed = await store.index();
  assert.equal(indexed.failed, 0);

  const lib = createMemoryLib({
    dataRoot, workspaceRoot: dataRoot, principal: OWNER,
    scopes: [{ layer: "memory", visibility: "user" }],
    vectorLane: { probe: false },
  });
  const out = await lib.searchWithMeta({ query: "米饭", limit: 5 });
  assert.ok(Array.isArray(out.results) && out.results.length >= 1, JSON.stringify(out.results));
  assert.equal(out.meta?.prefiltered, true, JSON.stringify(out.meta));
  assert.equal(out.meta?.used_owned_index, true, JSON.stringify(out.meta));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("project writes create belongs_to_project edges immediately (no full rebuild)", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-edge-"));
  const evidenceDir = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "conversation-111111111111111111111111.md"), [
    "---", "id: conversation-111111111111111111111111", "type: conversation",
    'groupId: "qq"', 'userId: "u-owner"', 'tenantId: "default"', "---", "", "证据正文", "",
  ].join("\n"), "utf8");
  const writer = createMemoryWriter({ dataRoot });
  const written = await writer.write({
    layer: "project-decision",
    project: "p-edge",
    id: "decision-p-edge",
    visibility: "project",
    body: "决定内容",
    evidence_refs: ["conversation-111111111111111111111111"],
    principal: { tenant_id: "default", framework_id: "f", agent_id: "admin-01", role_id: "librarian-admin", group_id: "home-circle", user_id: "user-owner" },
  });
  assert.ok(written.ok, JSON.stringify(written));
  const store = createGraphStore({ dataRoot });
  const edges = store.edgeRows({ tenantId: "default", srcId: "project:p-edge", predicate: "belongs_to_project" });
  assert.deepEqual(edges.map((edge) => edge.dst_id), ["decision-p-edge"], JSON.stringify(edges));
  await fs.rm(dataRoot, { recursive: true, force: true });
});
