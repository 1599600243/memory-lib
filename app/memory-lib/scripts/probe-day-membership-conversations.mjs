#!/usr/bin/env node
// SCENARIO-2-FOLLOWUP 探针 8：用**读数**回答「evidence/conversations 的整天检索有没有受影响」。
// 不是"应该没事"，而是同一份真实数据、同一个整天窗口，分别量：
//   - 每个真实 scope 解析出的根里，conversations 根在不在；
//   - conversations 类条目在 reader / researcher 两个身份下的条数是否一致。
// 结论判据：证据层准入由 group_id + user_id 决定（container-policy 的 evidence 分支），
// 与 role_id 无关 ⇒ 两个身份应当量到**同一个数**。
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib, resolveRootsForScopes } from "../src/memory-lib.mjs";
import { resolveRequestScopes } from "../src/identity-registry.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const WINDOW = { since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai", limit: 200 };

const registry = JSON.parse(await fs.readFile(path.join(COPY, "runtime", "identity.json"), "utf8"));
const framework = registry.frameworks.find((item) => item.framework_id === "deepseek-harness");
const agentEntry = framework.agents.find((a) => a.agent_id === "pilot-01");
const isConversation = (p) => String(p).replaceAll("\\", "/").includes("/evidence/conversations");

const out = { note: "同日、同数据、不同身份下的 conversation 证据条数" };
for (const roleId of ["reader", "researcher"]) {
  const role = agentEntry.roles.find((r) => r.role_id === roleId);
  const scopeRes = resolveRequestScopes(role, undefined);
  const scopeRoots = scopeRes.ok ? resolveRootsForScopes(scopeRes.scopes, dataRoot, COPY) : [];
  out[roleId] = {
    scopes: scopeRes.ok ? scopeRes.scopes.map((s) => `${s.layer}/${s.visibility}${s.project ? `:${s.project}` : ""}`) : scopeRes.reason,
    grantsConversationsRoot: scopeRoots.some((r) => isConversation(typeof r === "string" ? r : r.path)),
  };
  if (!scopeRes.ok) continue;
  const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: roleId, group_id: role.group_id ?? "unknown", user_id: role.user_id ?? "unknown" };
  const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, scopes: scopeRes.scopes, agentId: "pilot-01", roleId, vectorLane: { probe: false } });
  // 必须**翻页取全**：timeline 单页默认上限 100，而这一天 >100 条，
  // 只读第一页会让两个身份都得到 conversations_count=100（被页大小截断的假读数）。
  const seen = [];
  let cursor = null;
  let total = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await lib.timeline({ ...WINDOW, cursor });
    total = page.total_count;
    seen.push(...page.results);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  out[roleId].total_count = total;
  out[roleId].retrieved = seen.length;
  out[roleId].conversations_count = seen.filter((i) => isConversation(i.path)).length;
  out[roleId].complete = seen.length === total;
}
console.log(JSON.stringify(out, null, 2));
