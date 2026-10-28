#!/usr/bin/env node
// VISIBILITY-AUDIT-2 / 项 1+4 —— 逐工具差分扫描 + 空作用域实测。
//
// 对每个 MCP 工具，把**同一份客户端参数**分别送给两条通道：
//   A) 进程内 `/mcp`（coreFromLib：宿主注入了 principal / 部署时区）
//   B) MCP-over-HTTP client（createCoreClient → REST：宿主在**服务端**注入身份）
// 判据：结果是否一致？不一致说明两条通道对同一请求给出不同答案。
//
// 同时（项 4）实测 scopes=[] 在真实入口上还能看到什么。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createCoreClient, createMcpHandler, coreFromLib } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = process.cwd();
const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const workspaceRoot = COPY;

const out = { copy: COPY };

// ───────── 项 4：scopes=[] 在真实入口上还能看到什么 ─────────
{
  const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "reader", group_id: "home-circle", user_id: "user-owner" };
  for (const [label, scopes] of [["scopes=[]", []], ["scopes=null", null]]) {
    const lib = createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId: principal.agent_id, principal, vectorLane: { probe: false } });
    const page = await lib.timeline({ since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", limit: 100 });
    out[`项4 ${label}`] = {
      roots: lib.roots.map((r) => path.relative(dataRoot, typeof r === "string" ? r : r.path).replaceAll("\\", "/") || "(dataRoot 顶层)"),
      total_count: page.total_count,
    };
  }
}

// ───────── 项 1：逐工具差分 ─────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis2-diff-"));
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
  role.group_id ??= "home-circle";
  role.user_id ??= "user-owner";
}
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  dataRoot,
  workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  indexScheduleEnabled: false,
  vectorLane: { probe: false },
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
  calendarTimezone: "Asia/Shanghai",
});

// 每个工具一组"最小合法参数"。只放**客户端能控制**的字段；
// 身份字段（agent_id/role_id/principal）刻意**不**放，看两条通道各自的默认行为。
const ARGS = {
  memory_search: { query: "", since: "2026-09-24", until: "2026-09-24", limit: 20 },
  memory_graph_query: { project_id: "pilot" },
  memory_list: { limit: 20 },
  memory_get: { id: "nope" },
  memory_health: {},
  memory_resolve_date: { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z" },
  memory_refinement_pending: { limit: 10 },
  learning_plan_get: { topic: "nope" },
  learning_progress_get: { topic: "nope" },
  learning_review_get: {},
  learning_profile_get: {},
  pet_drafts_list: {},
  pet_persona_list: {},
  memory_tool_list: {},
  memory_plan_list: {},
  memory_recall_brief: {},
  memory_role_list: {},
  admin_registry: {},
  admin_audit: { limit: 5 },
  evidence_list: {},
  recovery_status: {},
  memory_transcript_import_status: {},
};
const onlyRoleList = ["memory_role_list"];   // 已知那条，单独标出来

try {
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "reader", group_id: "home-circle", user_id: "user-owner" };
  const scopes = [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "episodic" }];

  // A) 进程内：复刻 localhost-server:640 与 :684 的装配
  const lib = createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId: principal.agent_id, principal, vectorLane: { probe: false }, calendarTimezone: "Asia/Shanghai" });
  const mcpRuntime = { draftsPut: () => ({}), draftsList: () => ({ drafts: [] }), draftsClear: () => ({}), personaGet: () => ({}), personaList: () => ({ personas: [] }), personaPut: () => ({}) };
  const { createRoleMemory } = await import("../src/role-memory.mjs");
  const { createToolsMemory } = await import("../src/tools-memory.mjs");
  const { createPlansMemory } = await import("../src/plans-memory.mjs");
  const { createTranscriptImporter } = await import("../src/transcript-importer.mjs");
  const { createRecall } = await import("../src/recall.mjs");
  const { createProfileMemory } = await import("../src/profile-memory.mjs");
  const { createEvidenceRecoveryApi } = await import("../src/evidence-recovery.mjs");
  const { createPetRuntimeStore } = await import("../src/pet-runtime-store.mjs");
  const { createProjectMemory } = await import("../src/project-memory.mjs");
  const { createMemoryWriter } = await import("../src/write-memory.mjs");
  const { createLearningApi } = await import("../src/learning.mjs");
  const { createGraphStore } = await import("../src/graph-retrieval.mjs");
  const { loadRegistry } = await import("../src/identity-registry.mjs");
  const { registryView, setCredentialStatus, queryAudit } = await import("../src/admin.mjs");

  const { createConversationMemory } = await import("../src/conversation-memory.mjs");
  const graphStore = createGraphStore({ dataRoot });
  const conversationMemory = createConversationMemory({ dataRoot, calendarTimezone: "Asia/Shanghai" });
  const transcriptImporter = createTranscriptImporter({ importRoot: path.join(dataRoot, "transcript-import"), conversationMemory });
  // 与 localhost-server:264 同一个 adminServices 形状。
  const adminServices = {
    registry: async () => registryView(await loadRegistry(auth.registryPath)),
    audit: (limit, allow) => queryAudit(path.join(tmp, "audit.jsonl"), { limit, allow }),
    revoke: async (frameworkId) => setCredentialStatus(auth.registryPath, frameworkId, "revoked"),
    activate: async (frameworkId) => setCredentialStatus(auth.registryPath, frameworkId, "active"),
  };
  const services = {
    lib,
    learning: createLearningApi(path.join(workspaceRoot, "learning")),
    pet: undefined,
    admin: adminServices,
    conversationMemory,
    transcriptImporter,
    memoryIngest: { run: async () => ({}) },
    petRuntime: createPetRuntimeStore({ dataRoot, workspaceRoot }),
    petRemember: null,
    tools: createToolsMemory({ dataRoot }),
    plans: createPlansMemory({ dataRoot }),
    project: createProjectMemory({ dataRoot, graphStore }),
    recall: createRecall({ dataRoot, workspaceRoot }),
    profile: createProfileMemory({ dataRoot }),
    roleMemory: createRoleMemory({ dataRoot }),   // 差分的主角就是它
    writer: createMemoryWriter({ dataRoot, graphStore }),
    evidenceRecovery: createEvidenceRecoveryApi({ dataRoot, workspaceRoot }),
  };
  const core = coreFromLib(services, principal, { actions: ["search", "get"], calendarTimezone: "Asia/Shanghai" });
  const inProcHandler = createMcpHandler(core);

  // B) client：stdio 适配器那条链路
  const client = createCoreClient(base, { credRef: auth.credentialRef, secret: auth.authValue, agent: principal.agent_id, role: principal.role_id });
  const clientHandler = createMcpHandler(client);

  const call = async (handler, name, args) => {
    const message = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const text = message?.result?.content?.[0]?.text;
    if (typeof text !== "string") return { raw: JSON.stringify(message).slice(0, 200) };
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
  };
  const summarize = (data) => {
    if (data?.error) return `error:${data.error.code ?? data.error.message ?? "?"}`;
    const counts = {};
    for (const key of ["count", "total_count", "totalCount"]) if (typeof data?.[key] === "number") counts[key] = data[key];
    if (Array.isArray(data?.items)) counts.items = data.items.length;
    if (Array.isArray(data?.results)) counts.results = data.results.length;
    if (Array.isArray(data?.chunks)) counts.chunks = data.chunks.length;
    if (typeof data?.status === "string") counts.status = data.status;
    return JSON.stringify(counts) || `keys:${Object.keys(data ?? {}).slice(0, 6).join(",")}`;
  };

  const rows = [];
  for (const [name, args] of Object.entries(ARGS)) {
    let inProcData; let clientData;
    try { inProcData = await call(inProcHandler, name, args); } catch (e) { inProcData = { __throw: e.message }; }
    try { clientData = await call(clientHandler, name, args); } catch (e) { clientData = { __throw: e.message }; }
    const inProc = summarize(inProcData);
    const viaClient = summarize(clientData);
    rows.push({
      tool: name,
      inProcess: inProc,
      viaClient,
      same: JSON.stringify(inProcData) === JSON.stringify(clientData),
      sampleSameShape: inProc === viaClient,
      known: onlyRoleList.includes(name),
      // 形状差异可见：只在"摘要相同但原文不同"时把原文截断贴上
      inProcessRaw: JSON.stringify(inProcData)?.slice(0, 160),
      clientRaw: JSON.stringify(clientData)?.slice(0, 160),
    });
  }
  out["项1 逐工具差分（同一份客户端参数，两条通道）"] = rows;
  out["项1 结果不一致（原文级）"] = rows.filter((r) => !r.same);
  out["项1 摘要不一致（条数级）"] = rows.filter((r) => !r.sampleSameShape);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
