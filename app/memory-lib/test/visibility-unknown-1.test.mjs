import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createRecall } from "../src/recall.mjs";
import { createGraphStore, jointSearch } from "../src/graph-retrieval.mjs";

const ADMIN = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "unknown", user_id: "real-user", agent_id: "admin-01", role_id: "librarian-admin" };
const DENIED = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "unknown", user_id: "unknown" };
const DAY = "2026-10-19";
const FIXTURE_ID = "VISUNKNOWN-V2-PRIVATE-ADMIN";
const COPY_IDS = [
  "curated-shared-7c5a0de2-d40a-44a7-b430-31c3e6b732b4",
  "curated-shared-fed6d5d9-dfef-4aa3-98b9-9d6ea5b6be0d",
  "deploy15-probe-private",
];
const SOURCE = "D:/MemoryLib/data/memory/curated/shared";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visibility-unknown-v2-"));
  const dataRoot = path.join(root, "memory");
  const dir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  for (const id of COPY_IDS) {
    const text = await fs.readFile(path.join(SOURCE, `${id}.md`), "utf8");
    await fs.writeFile(path.join(dir, `${id}.md`), text, "utf8");
  }
  const marker = `---\nid: ${FIXTURE_ID}\nlayer: long-term\ncontainer: long-term\nvisibility: private\ntype: memory\nstatus: active\ntenant_id: default\nframework_id: deepseek-harness\ngroup_id: unknown\nuser_id: unknown\nagent_id: admin-01\nrole_id: librarian-admin\noccurred_at: \"${DAY}T03:00:00.000Z\"\nvalid_from: \"${DAY}T03:00:00.000Z\"\ncalendarDate: ${DAY}\n---\n${FIXTURE_ID} should only match real admin agent/role, not unknown user.\n`;
  await fs.writeFile(path.join(dir, `${FIXTURE_ID}.md`), marker, "utf8");
  return { root, dataRoot, dir };
}

function makeLib(w, principal) {
  return createMemoryLib({ dataRoot: w.dataRoot, workspaceRoot: w.root, principal, vectorLane: { probe: false }, calendarTimezone: "Asia/Shanghai" });
}

test("VISIBILITY-UNKNOWN V2/V5: copied audited private records retain admin access across retrieval seams", async (t) => {
  const w = await setup();
  t.after(() => fs.rm(w.root, { recursive: true, force: true }));
  const adminLib = makeLib(w, ADMIN);
  const deniedLib = makeLib(w, DENIED);
  const recallAdmin = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root, lib: adminLib });
  const recallDenied = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root, lib: deniedLib });
  const expectedIds = [...COPY_IDS, FIXTURE_ID].sort();
  const query = "用户对本项目的唯一判据";
  const adminSearch = await adminLib.search({ query, limit: 100, searchMode: "memories", graphExpand: false });
  assert.equal(adminSearch.some((row) => path.basename(row.path, ".md") === COPY_IDS[0]), true, "admin sees the first exact private file through search");
  console.log("V2 real-file /v1/search admin count:", adminSearch.filter((row) => COPY_IDS.includes(path.basename(row.path, ".md"))).length);
  const deniedSearch = await deniedLib.search({ query, limit: 100, searchMode: "memories", graphExpand: false });
  assert.equal(deniedSearch.some((row) => expectedIds.includes(path.basename(row.path, ".md"))), false, "unknown-only identity sees none of these private records");
  console.log("V2 real-file /v1/search unknown-only count:", deniedSearch.filter((row) => expectedIds.includes(path.basename(row.path, ".md"))).length);

  const adminDay = await adminLib.timeline({ calendarDate: DAY, calendarTimezone: "Asia/Shanghai", limit: 100 });
  assert.deepEqual(adminDay.results.map((row) => row.id).sort(), [FIXTURE_ID, COPY_IDS[0]].sort(), "calendarDate query returns the real dated admin record and fixture");
  console.log("V2 real-file calendarDate admin count:", adminDay.results.filter((row) => COPY_IDS.includes(row.id)).length);
  const deniedDay = await deniedLib.timeline({ calendarDate: DAY, calendarTimezone: "Asia/Shanghai", limit: 100 });
  assert.deepEqual(deniedDay.results.map((row) => row.id), [], "unknown-only identity sees no private record on the requested day");
  console.log("V2 real-file calendarDate unknown-only count:", deniedDay.results.filter((row) => expectedIds.includes(row.id)).length);

  const briefQuery = "同一件事不再被问第二遍";
  const adminBrief = await recallAdmin.recallBrief({ principal: ADMIN, format: "markdown", query: briefQuery, memories: 8 });
  assert.ok(adminBrief.included.some((item) => COPY_IDS.includes(item.id)), "admin brief includes an audited real private record");
  console.log("V2 real-file recall brief admin IDs:", adminBrief.included.filter((item) => COPY_IDS.includes(item.id)).map((item) => item.id).join(",") || "none");
  const deniedBrief = await recallDenied.recallBrief({ principal: DENIED, format: "markdown", query: briefQuery, memories: 8 });
  assert.equal(deniedBrief.included.some((item) => expectedIds.includes(item.id)), false, "unknown-only identity cannot retrieve audited records through brief");
  console.log("V2 real-file recall brief unknown-only IDs:", deniedBrief.included.filter((item) => expectedIds.includes(item.id)).map((item) => item.id).join(",") || "none");

  const graphStore = createGraphStore({ dataRoot: w.dataRoot });
  const graphRecords = [];
  for (const id of COPY_IDS) {
    const target = `memory:${id}`;
    const evidenceId = `evidence:${id}`;
    const evidenceText = `---\nid: ${evidenceId}\ntype: evidence\n---\nGraph source evidence for ${id}.\n`;
    await fs.writeFile(path.join(w.dir, `source-${id}.md`), evidenceText, "utf8");
    await graphStore.ingest({ event_id: `evt-${id}`, type: "project.linked", tenant_id: "default", evidence_id: evidenceId, payload: { src_id: "project:visibility-unknown", predicate: "belongs_to_project", dst_id: target, visibility: "private", container: "long-term", group_id: "unknown", user_id: "unknown", agent_id: "admin-01", role_id: "librarian-admin", project: "visibility-unknown" } });
    graphRecords.push({ id, target });
  }
  const adminGraph = graphStore.projectGraph({ tenantId: "default", projectId: "visibility-unknown", principal: ADMIN });
  assert.equal(adminGraph.edges.length, 3, "graph query retains all three audited admin records");
  console.log("V2 real-file graph admin edges:", adminGraph.edges.length);
  const deniedGraph = graphStore.projectGraph({ tenantId: "default", projectId: "visibility-unknown", principal: DENIED });
  assert.equal(deniedGraph.edges.length, 0, "graph query denies unknown-only identity on all three audited records");
  console.log("V2 real-file graph unknown-only edges:", deniedGraph.edges.length);
  const exact = { src_id: "project:visibility-unknown", predicate: "belongs_to_project", dst_id: graphRecords[0].target };
  const adminJoint = await jointSearch({ dataRoot: w.dataRoot, tenantId: "default", principal: ADMIN, query: "VISUNKNOWN", exact, fetchImpl: async () => { throw new Error("model must not be called"); } });
  assert.equal(adminJoint[0]?.id, graphRecords[0].target, "jointSearch preserves graph result for the admin principal");
  console.log("V2 jointSearch admin result:", adminJoint[0]?.id ?? "none");
  const deniedJoint = await jointSearch({ dataRoot: w.dataRoot, tenantId: "default", principal: DENIED, query: "VISUNKNOWN", exact, fetchImpl: async () => { throw new Error("model must not be called"); } });
  assert.deepEqual(deniedJoint, [], "jointSearch denies unknown-only principal across graph and file lanes");
  console.log("V2 jointSearch unknown-only count:", deniedJoint.length);
});
