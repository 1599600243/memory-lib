// SCENARIO-2-FOLLOWUP 探针 3：判别 105/106 的差额出在「调用形状」还是「角色准入」。
//
// ⚠️ 本探针的**结论后来被探针 6 修正**，保留它是为了留下过程证据：
//   它用 role=researcher 跑，看到 ④（scopes + agentId）= 106、③（无 agentId）= 105，
//   于是当时把差额归因于"漏传 agentId 的调用形状伪影"。**这个归因是错的。**
//   探针 6 用 role=reader（= 压测脚本的默认角色）复跑，发现 reader **在任何形状下都是 105**，
//   包括传了 agentId 的 ④。⇒ 真正的判据是 **role_id**（container-policy 第 64 行），
//   不是 agentId。agentId 那条 self-root 兜底只在 researcher 身份下额外帮到忙。
// 因此：105 vs 106 = 换身份（reader vs researcher），不是换调用形状。
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { resolveRequestScopes } from "../src/identity-registry.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const target = path.join(dataRoot, "curated", "agents", "pilot-01", "role-7c963da877417294.md");
const WINDOW = { since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai", limit: 200 };

const registry = JSON.parse(await fs.readFile(path.join(COPY, "runtime", "identity.json"), "utf8"));
const framework = registry.frameworks.find((item) => item.framework_id === "deepseek-harness");
const role = framework.agents.find((agent) => agent.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
const scopeRes = resolveRequestScopes(role, undefined);
if (!scopeRes.ok) throw new Error(`scope resolution failed: ${scopeRes.reason}`);
const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher", group_id: role.group_id ?? "unknown", user_id: role.user_id ?? "unknown" };

const out = { target: path.relative(dataRoot, target), note: "四种调用形状对照：scopes × agentId" };
for (const [label, options] of [
  ["① scopes=null,  无 agentId（=探针2 ⑧a）", { scopes: null }],
  ["② scopes=null,  带 agentId", { scopes: null, agentId: "pilot-01" }],
  ["③ scopes=角色组, 无 agentId（=探针2 ⑧b）", { scopes: scopeRes.scopes }],
  ["④ scopes=角色组, 带 agentId（=HTTP 真实形状）", { scopes: scopeRes.scopes, agentId: "pilot-01" }],
]) {
  const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, vectorLane: { probe: false }, ...options });
  const page = await lib.timeline(WINDOW);
  out[label] = { total_count: page.total_count, containsTarget: page.results.some((item) => item.path === target) };
}
console.log(JSON.stringify(out, null, 2));
