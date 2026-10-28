// SCENARIO-2-FOLLOWUP 探针 6：为什么**真实 HTTP 实例**给 105，而直连库给 106？
// 两者都传了 agentId、都用同一份副本数据。逐字段对照，找出判据差异。
//
// 已知差异候选：
//   - localhost-server 第 866 行传 agentId 但**不传 roleId**（server.mjs 第 124 行的
//     libFactory 只解构 { scopes, agentId, principal, audit }）；
//   - HTTP 层可能先按 scope 过滤（body.scope）再枚举；
//   - 时间戳字段回落顺序可能不同。
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { resolveRequestScopes } from "../src/identity-registry.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const target = path.join(dataRoot, "curated", "agents", "pilot-01", "role-7c963da877417294.md");
const WINDOW = { since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai" };

const registry = JSON.parse(await fs.readFile(path.join(COPY, "runtime", "identity.json"), "utf8"));
const framework = registry.frameworks.find((item) => item.framework_id === "deepseek-harness");
const agentEntry = framework.agents.find((a) => a.agent_id === "pilot-01");
const reader = agentEntry.roles.find((r) => r.role_id === "reader");   // bench 默认角色
const researcher = agentEntry.roles.find((r) => r.role_id === "researcher");

const out = { target: path.relative(dataRoot, target), benchDefaultRole: "reader" };
for (const [label, role] of [["reader", reader], ["researcher", researcher]]) {
  const scopeRes = resolveRequestScopes(role, undefined);
  out[`④ resolveRequestScopes(${label})`] = scopeRes.ok ? scopeRes.scopes : scopeRes.reason;
  if (!scopeRes.ok) continue;
  const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: label, group_id: role.group_id ?? "unknown", user_id: role.user_id ?? "unknown" };
  // 逐字段叠加，找出把条目弄丢的那一项
  for (const [shape, options] of [
    ["scopes + agentId", { scopes: scopeRes.scopes, agentId: "pilot-01" }],
    ["scopes + agentId + roleId", { scopes: scopeRes.scopes, agentId: "pilot-01", roleId: label }],
    ["scopes only（无 agentId）", { scopes: scopeRes.scopes }],
  ]) {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, vectorLane: { probe: false }, ...options });
    const page = await lib.timeline({ ...WINDOW, limit: 100 });
    out[`${label} / ${shape}`] = { total_count: page.total_count, returned: page.results.length, containsTarget: page.results.some((i) => i.path === target) };
  }
}
console.log(JSON.stringify(out, null, 2));
