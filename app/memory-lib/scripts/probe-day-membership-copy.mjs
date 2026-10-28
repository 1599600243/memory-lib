// SCENARIO-2-FOLLOWUP 探针 2：在**真实数据副本**上，把这个文件**逐层**走一遍判据，
// 找出它被哪一层挡掉。只读副本；不碰生产。
// ⚠️ 测量教训（已修正）：本探针最初只跑 `{ scopes }`，**漏传 agentId**。
//    而 localhost-server 第 640/866 行总是传 `agentId: authed.agent.agent_id`，
//    memory-lib 第 180-186 行又会据此把 curated/agents/<selfAgent> 追加进 resolvedRoots。
//    ⚠️ 但后来（探针 6/7）查明：**agentId 并不是 105/106 差额的真正判据**。
//    真正判据是 container-policy 第 64 行的角色准入（`p.role_id === role`）：
//    本探针用 role=researcher，所以 ⑧d 能看到属于 researcher 的那条；
//    换成 reader（压测脚本默认角色）则**任何形状都是 105**。
//    ⇒ ⑧b 与 ⑧d 的差别在本探针里确实存在，但把它推广成"生产漏传 agentId"是**过度推断**。
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { pathContainer, principalAllowsContainer } from "../src/container-policy.mjs";
import { parseFrontmatter } from "../src/read-only-core.mjs";
import { timestampValue } from "../src/time-util.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const target = path.join(dataRoot, "curated", "agents", "pilot-01", "role-7c963da877417294.md");

const text = await fs.readFile(target, "utf8");
const fm = parseFrontmatter(text).frontmatter;
const stamp = timestampValue(fm);
// ⚠️ frontmatter 里的值是**带引号**的（`layer: "role"`）。必须按真实代码那样 unquote，
// 否则 `normalizeContainer('"role"')` → null → principalAllowsContainer 恒 false，
// 那是我第一次跑这个探针时得到的**假阴性**（测量伪影，不是缺陷）。
const uq = (value) => (value === null || value === undefined ? value : String(value).trim().replace(/^["']|["']$/gu, ""));

const out = {
  file: path.relative(dataRoot, target),
  frontmatterRaw: { layer: fm.layer, type: fm.type ?? null, occurred_at: fm.occurred_at, updated_at: fm.updated_at, status: fm.status, visibility: fm.visibility, agent_id: fm.agent_id, role_id: fm.role_id },
  frontmatterUnquoted: { layer: uq(fm.layer), type: uq(fm.type) ?? null, occurred_at: uq(fm.occurred_at), updated_at: uq(fm.updated_at), status: uq(fm.status), visibility: uq(fm.visibility), agent_id: uq(fm.agent_id), role_id: uq(fm.role_id) },
  "① timestampValue（FIELDS 顺序）": { value: new Date(stamp.value).toISOString(), field: stamp.field },
  "② pathContainer": pathContainer(dataRoot, target),
  "③ principalAllowsContainer（unquote 之后，与真实代码同口径）": principalAllowsContainer(
    { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher", group_id: "home-circle", user_id: "user-owner" },
    { ...fm, layer: uq(fm.layer), visibility: uq(fm.visibility), container: pathContainer(dataRoot, target), project: null, group_id: null, user_id: null, agent_id: uq(fm.agent_id), role_id: uq(fm.role_id) },
  ),
};

// ④ 用与 HTTP 服务器**同样的 root 解析方式**（scopes → resolvedRoots）跑一次 timeline
const { resolveRequestScopes } = await import("../src/identity-registry.mjs");
const registry = JSON.parse(await fs.readFile(path.join(COPY, "runtime", "identity.json"), "utf8"));
const framework = registry.frameworks.find((item) => item.framework_id === "deepseek-harness");
const role = framework.agents.find((agent) => agent.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
const scopeRes = resolveRequestScopes(role, undefined);
out["④ resolveRequestScopes(role)"] = scopeRes.ok ? { ok: true, scopes: scopeRes.scopes } : { ok: false, reason: scopeRes.reason };

if (scopeRes.ok) {
  const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher", group_id: role.group_id ?? "unknown", user_id: role.user_id ?? "unknown" };
  // ⑧ 关键对照：**同一份数据、同一个 principal**，只是 scopes 给不给。
  //    这能判别"排除发生在 scopes → resolvedRoots 这一步"还是更下游。
  for (const [label, options] of [
    ["⑧a scopes = null（不过滤 root）", { scopes: null }],
    ["⑧b scopes = 服务器给的那一组（漏传 agentId，反例）", { scopes: scopeRes.scopes }],
    // ⑧c/⑧d 才是与 HTTP 同形状的对照：agentId 由连接身份注入，不是调用方可选的。
    ["⑧c scopes = null + agentId（HTTP 同形状）", { scopes: null, agentId: "pilot-01" }],
    ["⑧d scopes = 服务器那一组 + agentId（HTTP 真实形状）", { scopes: scopeRes.scopes, agentId: "pilot-01" }],
  ]) {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, ...options, vectorLane: { probe: false } });
    const page = await lib.timeline({ since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai", limit: 200 });
    out[label] = { total_count: page.total_count, containsTarget: page.results.some((item) => item.path === target) };
  }
  const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, scopes: scopeRes.scopes, agentId: "pilot-01", vectorLane: { probe: false } });
  // ⚠️ 全时间窗有 1000+ 条，单页 limit 装不下 —— `containsTarget` 在这里**不能**当作"被排除"的证据
  //    （它只说明"没落在第一页"）。判定排除只认 target 所属的那一天窗口（⑧a-⑧d）。
  const all = await lib.timeline({ since: "2000-01-01", until: "2100-01-01", limit: 500 });
  out["⑦ 全时间窗（scopes + agentId；仅计数，不能证明排除）"] = { total_count: all.total_count, returned: all.results.length, containsTarget: all.results.some((item) => item.path === target) };
}

console.log(JSON.stringify(out, null, 2));
