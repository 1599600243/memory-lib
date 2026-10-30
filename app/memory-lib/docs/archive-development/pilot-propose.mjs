// memory-lib stage 4 — production pilot: submit ONE clearly-labeled candidate to the
// PRODUCTION inbox via the localhost adapter, researcher role, scope project:pilot.
// This is the first real "DS propose -> human review" cycle. Read-only elsewhere.
// Run: node scripts/pilot-propose.mjs
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { snapshotTree, diffSnapshots } from "./zero-write-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const DATA_ROOT = "I:\\OpenClaw\\memory-data\\memory";
const WORKSPACE_ROOT = "I:\\OpenClaw\\memory-data";
const REGISTRY_PATH = path.join(ROOT, "runtime", "identity.json");
const SECRET_STORE = { type: "file", dir: path.join(ROOT, "runtime", "secrets") };
const AUDIT_PATH = path.join(os.tmpdir(), `memory-lib-pilot-propose-audit-${Date.now()}.jsonl`);
const CREDENTIAL_REF = "memory-lib/deepseek-harness";
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");
const RESEARCHER = { agent_id: "pilot-01", role_id: "researcher" };
const PROJECT_PILOT = { layer: "memory", visibility: "project", project: "pilot" };

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: DATA_ROOT, workspaceRoot: WORKSPACE_ROOT, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

console.log("== Stage 4 production pilot: DS propose -> human review ==");
console.log("dataRoot:", DATA_ROOT);

const curatedBefore = await snapshotTree(path.join(DATA_ROOT, "curated"));
const inboxBefore = await fs.readdir(path.join(DATA_ROOT, "inbox"));

const res = await fetch(`${BASE}/v1/propose`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    credential_ref: CREDENTIAL_REF,
    secret: DEV_SECRET,
    principal: RESEARCHER,
    content: "PILOT-01 试运行候选：记忆库独立核心 Slice 1-3 已验收通过——只读 memory-lib（health/search/get，与活体插件行为一致、零写入）+ 127.0.0.1 localhost 适配器（credential_ref 凭证、reader/researcher 角色、shared/project:pilot scope、审计）已在生产数据根只读验证。本条候选用于验证「DS propose → 人工 review → promote」治理闭环，待人工审核。",
    scope: PROJECT_PILOT,
    source: "deepseek-harness:pilot-01",
    confidence: "medium",
    tags: ["pilot", "memory-core", "slice1-3"],
    importance: "ordinary",
    task_id: "task-pilot-01-stage4",
    evidence_refs: [
      "D:/AI/deepseek-harness/agentgongz/memory-lib/docs/slice1-acceptance.md",
      "D:/AI/deepseek-harness/agentgongz/memory-lib/docs/slice2-acceptance.md",
      "D:/AI/deepseek-harness/agentgongz/memory-lib/docs/slice3-acceptance.md",
    ],
  }),
});
const data = await res.json();
console.log("response:", res.status, JSON.stringify(data));

let ok = res.status === 200;
if (ok) {
  // verify the file landed on disk with full provenance
  const inboxAfter = await fs.readdir(path.join(DATA_ROOT, "inbox"));
  const added = inboxAfter.filter((f) => !inboxBefore.includes(f));
  const match = added.find((f) => f.includes(data.id));
  ok = !!match;
  console.log("inbox file:", match ? path.join(DATA_ROOT, "inbox", match) : "NOT FOUND");
  if (match) {
    const text = await fs.readFile(path.join(DATA_ROOT, "inbox", match), "utf8");
    for (const field of ["id: " + data.id, "scope: project:pilot", "status: proposed", "reviewState: pending", "framework_id: deepseek-harness", "agent_id: pilot-01", "role_id: researcher", "task_id: task-pilot-01-stage4", "proposedBy: deepseek-harness/pilot-01"]) {
      if (!text.includes(field)) { ok = false; console.log("MISSING FIELD:", field); }
    }
    console.log("frontmatter provenance check:", ok ? "OK" : "FAILED");
  }
}

// curated untouched
const curatedAfter = await snapshotTree(path.join(DATA_ROOT, "curated"));
const curatedChanges = diffSnapshots(curatedBefore, curatedAfter);
console.log("curated zero-write:", curatedChanges.length === 0 ? "CLEAN" : JSON.stringify(curatedChanges));

await adapter.close();
console.log(ok ? "== PILOT_PROPOSE_OK ==" : "== PILOT_PROPOSE_FAILED ==");
process.exit(ok ? 0 : 1);
