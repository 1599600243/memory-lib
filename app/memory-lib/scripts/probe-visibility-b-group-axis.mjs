#!/usr/bin/env node
// VISIBILITY-AUDIT-1 / 线 B —— container-policy 的逐轴 group 边界 + 最小越界夹具。
//
// 三件事：
//   ① 轴矩阵：role / user / agent / project / shared / platform / private 各自**是否**把 group_id 纳入判定。
//   ② 最小夹具：两个 group 各有一个**同名** role/agent/user，能不能互相看见（直接判据 + 真实检索两条路都量）。
//   ③ 区分"代码上能到"与"实际部署能到"：前者用 resolveRootsForScopes + principalAllowsContainer，
//      后者用**真实数据副本**上的生产装配跑一遍（看是否存在同名 role 的跨组条目）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathContainer, principalAllowsContainer, normalizeContainerScope } from "../src/container-policy.mjs";
import { resolveRootsForScopes, createMemoryLib } from "../src/memory-lib.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const out = {};

// ───────── ① 轴矩阵：同一份 metadata，换 visibility/container，看 group 是否参与 ─────────
// 手法：固定 metadata 的 group_id = "group-a"，用两个 principal（同组 / 异组）各判一次。
// 若两者结果相同 ⇒ 该轴**不看 group**；若异组被拒 ⇒ 该轴**看 group**。
const metadataFor = (visibility, extra = {}) => ({
  container: extra.container ?? "long-term",
  visibility,
  project: extra.project ?? "pilot",
  group_id: "group-a",
  user_id: "user-a",
  agent_id: "agent-a",
  role_id: "role-a",
});
const sameGroup = { framework_id: "f", group_id: "group-a", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
const otherGroup = { framework_id: "f", group_id: "group-b", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
const otherGroupOtherIds = { framework_id: "f", group_id: "group-b", user_id: "user-b", agent_id: "agent-b", role_id: "role-b" };

const axes = [
  ["platform", metadataFor("platform")],
  ["shared", metadataFor("shared")],
  ["project", metadataFor("project")],
  ["role", metadataFor("role", { container: "role" })],
  ["user", metadataFor("user")],
  ["agent", metadataFor("agent")],
  ["private", metadataFor("private")],
  ["long-term container (agent/user/role 三选一)", metadataFor("private", { container: "long-term" })],
];
out["① 轴矩阵（同组 vs 异组）"] = axes.map(([label, metadata]) => {
  const scope = normalizeContainerScope(metadata);
  const withSameGroup = principalAllowsContainer(sameGroup, metadata);
  const withOtherGroup = principalAllowsContainer(otherGroup, metadata);
  const withOtherGroupOtherIds = principalAllowsContainer(otherGroupOtherIds, metadata);
  return {
    axis: label,
    normalizedVisibility: scope?.visibility ?? null,
    normalizedContainer: scope?.container ?? null,
    同组: withSameGroup,
    仅换组: withOtherGroup,
    换组且换同名身份: withOtherGroupOtherIds,
    group参与判定: withSameGroup !== withOtherGroup,
  };
});

// ───────── ② 最小夹具：两个 group 各有一个同名 role / agent / user ─────────
// 写两条角色记忆：group-a 与 group-b，**两者 agent_id 与 role_id 完全相同**。
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis-axis-b-"));
const dataRoot = path.join(tmp, "memory");
function note({ id, agent, role, marker }) {
  return ["---", `id: "${id}"`, 'layer: "role"', `agent_id: "${agent}"`, `role_id: "${role}"`, 'kind: "lesson"', 'confidence: "high"', 'status: "active"', "superseded_by: null", 'occurred_at: "2026-09-24T02:00:00.000Z"', 'updated_at: "2026-09-24T02:00:00.000Z"', "tags: []", "evidence_refs: []", 'tenant_id: "default"', 'container: "role"', 'visibility: "role"', "---", "", "## 经验", "", marker, ""].join("\n");
}
// 两条**字段完全相同**的角色记忆，唯一差别是它们**所在的目录**（= 实际部署里 group 的唯一痕迹）。
for (const [dir, marker] of [["shared-agent", "NOTE-THAT-LIVES-IN-DIR-shared-agent"], ["other-agent", "NOTE-THAT-LIVES-IN-DIR-other-agent"]]) {
  await fs.mkdir(path.join(dataRoot, "curated", "agents", dir), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "curated", "agents", dir, `${dir}.md`), note({ id: `note-${dir}`, agent: "same-agent-name", role: "same-role-name", marker }), "utf8");
}

const query = "NOTE-THAT-LIVES-IN-DIR";
async function visibleTo(principal) {
  const lib = createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes: [{ layer: "memory", visibility: "shared" }], principal, agentId: principal.agent_id, vectorLane: { probe: false } });
  // 用"不限时间"的枚举把两条都捞出来（不看 excerpt 内容，避免摘要截断导致假阴性）。
  const page = await lib.timeline({ since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", limit: 50 });
  return page.results.map((r) => path.relative(dataRoot, r.path)).sort();
}
out["② 同名 role/agent 的两组角色记忆（真实检索）"] = {
  "principal(pilot-01/researcher, group=home-circle)":
    await visibleTo({ framework_id: "f", group_id: "home-circle", user_id: "user-owner", agent_id: "pilot-01", role_id: "researcher" }),
  "principal(pilot-03/researcher, group=work-group)":
    await visibleTo({ framework_id: "f", group_id: "work-group", user_id: "user-other", agent_id: "pilot-03", role_id: "researcher" }),
};

// ───────── ③ 实际部署：真实副本上是否存在"同名 role 跨组"的条目 ─────────
const agentsRoot = path.join(COPY, "memory", "curated", "agents");
const roleDirs = (await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
out["③ 真实副本 curated/agents 下的目录"] = roleDirs.sort();

console.log(JSON.stringify(out, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
