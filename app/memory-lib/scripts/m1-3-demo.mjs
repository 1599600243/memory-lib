import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createGraphStore, jointSearch, rebuildGraph } from "../src/graph-retrieval.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-demo-"));
try {
  const dataRoot = path.join(root, "memory");
  const writer = createMemoryWriter({ dataRoot });
  await writer.write({ layer: "document", id: "demo-evidence", body: "Tenant A evidence for the project account.", evidence_refs: ["evidence:demo"], principal: { group_id: "group-a", user_id: "user-a", role_id: "role-a" }, visibility: "platform" });
  const graph = createGraphStore({ dataRoot });
  await graph.ingest({ event_id: "demo-event-1", type: "project.linked", tenant_id: "tenant-a", evidence_id: "evidence:demo", payload: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "account:qq-tenant-a", confidence: 1 } });
  const rebuilt = await rebuildGraph({ dataRoot });
  const search = await jointSearch({ dataRoot, tenantId: "tenant-a", query: "account", exact: { src_id: "project:alpha", predicate: "belongs_to_project", dst_id: "account:qq-tenant-a" }, fetchImpl: async () => { throw new Error("demo does not require a model"); } });
  console.log(JSON.stringify({ graph: rebuilt.graph, project: graph.projectGraph({ tenantId: "tenant-a", projectId: "project:alpha" }), search }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
