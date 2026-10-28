import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createGraphStore } from "../src/graph-retrieval.mjs";

const sizes = [10000, 100000, 1000000];
const requested = Number(process.argv[2]);
const selected = sizes.includes(requested) ? [requested] : sizes;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m13-bench-"));
try {
  const dataRoot = path.join(root, "memory");
  const writer = createMemoryWriter({ dataRoot });
  const rows = [];
  for (const size of selected) {
    const start = performance.now();
    const graph = createGraphStore({ dataRoot });
    const events = [];
    for (let i = 0; i < size; i += 1) {
      const id = `bench-${size}-${i}`;
      if (i < 10) await writer.write({ layer: "document", id, body: `benchmark evidence ${id}`, evidence_refs: [`evidence:bench-${size}-${i}`], principal: { group_id: "bench", user_id: "bench", role_id: "bench" }, visibility: "platform" });
      events.push({ event_id: `event-${size}-${i}`, type: "project.linked", tenant_id: "bench", evidence_id: `evidence:bench-${size}-${i % 10}`, payload: { src_id: `project:${i % 100}`, predicate: "belongs_to_project", dst_id: `memory:${id}` } });
    }
    await graph.ingestMany(events).catch(() => {});
    rows.push({ requested: size, elapsed_ms: Math.round(performance.now() - start), graph: graph.stats() });
  }
  console.log(JSON.stringify({ note: "deterministic graph-only benchmark; not a production performance claim", rows }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
