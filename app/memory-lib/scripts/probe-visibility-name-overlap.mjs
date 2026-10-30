#!/usr/bin/env node
// VISIBILITY-AUDIT-1 补读：真实副本上，role_id 与 agent_id（目录名）是否重合？
// 若某个 role_id 恰好等于某个 agent 目录名，那么 API-key 身份那条
// `memory/agent` 作用域（project = role_id）给出的根就是那个目录 —— 覆盖范围会被放大。
import fs from "node:fs/promises";
import path from "node:path";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const workspaceRoot = COPY;
const agentsRoot = path.join(workspaceRoot, "memory", "curated", "agents");
const registry = JSON.parse(await fs.readFile(path.join(COPY, "runtime", "identity.json"), "utf8"));

const dirs = (await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);

const roles = [];
for (const framework of registry.frameworks ?? []) {
  for (const agent of framework.agents ?? []) {
    for (const role of agent.roles ?? []) roles.push({ framework: framework.framework_id, agent_id: agent.agent_id, role_id: role.role_id });
  }
}

const dirSet = new Set(dirs);
const roleIds = [...new Set(roles.map((r) => r.role_id))];
const agentIds = [...new Set(roles.map((r) => r.agent_id))];

console.log(JSON.stringify({
  copy: COPY,
  curatedAgentsDirs: dirs.sort(),
  deployedAgentIds: agentIds.sort(),
  deployedRoleIds: roleIds.sort(),
  "目录名 ∩ agent_id": dirs.filter((d) => agentIds.includes(d)).sort(),
  "目录名 ∩ role_id（这条最危险：API-key 的 memory/agent 根会覆盖它）": dirs.filter((d) => roleIds.includes(d)).sort(),
  "role_id 列表里有哪些不在目录名里": roleIds.filter((r) => !dirSet.has(r)).sort(),
}, null, 2));
