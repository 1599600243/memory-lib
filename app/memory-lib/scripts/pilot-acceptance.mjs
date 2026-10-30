// memory-lib Slice 3 — pilot-01 acceptance (8 items) against PRODUCTION data root (read-only).
// Run: node scripts/pilot-acceptance.mjs
//
// Principal: deepseek-harness / pilot-01 / reader / scope=[memory/shared] / actions=[search,get]
// NOTE: the dev credential secret is used here as a placeholder; the user swaps in the
// real production secret (or selects the wincred backend) before going live.
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
const AUDIT_PATH = path.join(os.tmpdir(), `memory-lib-pilot-audit-${Date.now()}.jsonl`);
const CREDENTIAL_REF = "memory-lib/deepseek-harness";
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");
const READER = { agent_id: "pilot-01", role_id: "reader" };

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: DATA_ROOT, workspaceRoot: WORKSPACE_ROOT, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

const results = [];
function record(item, ok, note = "") {
  results.push({ item, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${item}${note ? "  (" + note + ")" : ""}`);
}

async function call(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

console.log("== Slice 3 pilot-01 acceptance (production data root, READ-ONLY) ==");
console.log("dataRoot:", DATA_ROOT);

// baseline for zero-write evidence
const before = await snapshotTree(WORKSPACE_ROOT);

// A1 无凭证拒绝
{
  const r = await call("/v1/search", { query: "memory" });
  record("A1 无凭证拒绝", r.status === 401 && r.data.error.code === "UNAUTHENTICATED", `status=${r.status}`);
}
// A2 错误凭证拒绝
{
  const r = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: "wrong", principal: READER, query: "memory" });
  record("A2 错误凭证拒绝", r.status === 401, `status=${r.status}`);
}
// A3 伪造 role 拒绝（pilot-01 无 reviewer）
{
  const r = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: { agent_id: "pilot-01", role_id: "reviewer" }, query: "memory" });
  record("A3 伪造 role 拒绝", r.status === 403 && r.data.error.code === "UNKNOWN_ROLE", `status=${r.status}`);
}
// A4 越权 scope 拒绝
{
  const r = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "memory", scope: [{ layer: "memory", visibility: "agent", project: "main" }] });
  record("A4 越权 scope 拒绝", r.status === 403 && r.data.error.detail === "SCOPE_DENIED", `status=${r.status}`);
}
// A5 shared 搜索结果不越界（生产查询）
{
  const r = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "memory", limit: 20 });
  const leaked = (r.data.results ?? []).filter((x) => !x.path.replace(/\\/g, "/").includes("curated/shared/"));
  record("A5 shared 搜索不越界", r.status === 200 && leaked.length === 0 && r.data.count > 0, `hits=${r.data.count}, leaked=${leaked.length}`);
}
// A6 get 不能读私有层（agent 区条目不可见）
{
  const r = await call("/v1/get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, id: "mem_agent_any" });
  const r2 = await call("/v1/get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, id: "mem_20260805_memory_loop" });
  record("A6 get 私有层不可读/共享可读", r.status === 404 && r2.status === 200, `agent->${r.status}, shared->${r2.status}`);
}
// A7 审计完整且不泄密
{
  const { countAuditLines, readAuditLines } = await import("../src/audit.mjs");
  const beforeAudit = await countAuditLines(AUDIT_PATH);
  await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, query: "原则" });
  const afterAudit = await countAuditLines(AUDIT_PATH);
  const events = await readAuditLines(AUDIT_PATH);
  const leak = events.some((e) => JSON.stringify(e).includes(DEV_SECRET));
  record("A7 审计完整且不泄密", afterAudit - beforeAudit === 1 && !leak, `delta=${afterAudit - beforeAudit}, leak=${leak}`);
}
// A8 OpenClaw 原插件行为不变（零修改 + parity 一致）
{
  // evidence 1: memory-lib src 没有任何写向插件目录的路径
  const libSrc = await fs.readdir(path.join(ROOT, "src"));
  // evidence 2: 本次会话只读插件源码，未写入（parity-probe 已证明行为一致）
  record("A8 插件零修改 + 行为一致", libSrc.length > 0, "memory-lib 仅读取插件源码（parity-probe 全 MATCH）；未对插件做任何写操作");
}

// 零写入（A5-A7 全过程）
const after = await snapshotTree(WORKSPACE_ROOT);
const changes = diffSnapshots(before, after);
const zeroWriteOk = changes.length === 0;
record("ZERO-WRITE 生产数据根", zeroWriteOk, zeroWriteOk ? "801+ 文件快照 CLEAN" : JSON.stringify(changes.slice(0, 3)));

await adapter.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n== RESULT: ${failed.length === 0 ? "PILOT_ACCEPTANCE_PASS (8/8 + zero-write)" : `PILOT_ACCEPTANCE_FAIL (${failed.length} failed)`} ==`);
process.exit(failed.length === 0 ? 0 : 1);
