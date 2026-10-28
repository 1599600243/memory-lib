#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT / 项 2（补）—— 最后一个"没身份"的读入口：
// memory-lib 的 **scopes=null（parity 模式）**，它**完全绕过** principal 过滤。
//
// 判据：同一个库、同一份数据，只差 `scopes` 与 `principal`，逐次量"能看到几条"。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis2r-parity-"));
const dataRoot = path.join(tmp, "memory");
const workspaceRoot = tmp;

const other = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-OTHER", user_id: "user-OTHER", agent_id: "agent-OTHER", role_id: "role-OTHER" };

// 夹具：三个容器各一条"只该属于别人"的条目
async function write(rel, body) {
  const full = path.join(dataRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
}
await write("curated/shared/marker-shared.md", "---\nid: marker-shared\nlayer: long-term\nstatus: active\nupdated_at: \"2026-09-24T02:00:00.000Z\"\ngroup_id: group-OTHER\n---\n\nMARKER-SHARED-OTHER-GROUP\n");
await write("curated/agents/agent-OTHER/role-x.md", "---\nid: marker-role\nlayer: role\ncontainer: role\nvisibility: role\nstatus: active\nagent_id: agent-OTHER\nrole_id: role-OTHER\nkind: lesson\nupdated_at: \"2026-09-24T02:00:00.000Z\"\nevidence_refs: []\n---\n\n## 经验\n\nMARKER-ROLE-OTHER\n");
await write("tools-memory/marker-tool.md", "---\nid: marker-tool\nlayer: tool\nvisibility: platform\nstatus: active\nupdated_at: \"2026-09-24T02:00:00.000Z\"\nagent_id: agent-OTHER\n---\n\nMARKER-TOOL-OTHER\n");
await write("plans/marker-plan.md", "---\nid: marker-plan\nlayer: plan\nvisibility: private\nstatus: active\nupdated_at: \"2026-09-24T02:00:00.000Z\"\nagent_id: agent-OTHER\ngroup_id: group-OTHER\nuser_id: user-OTHER\n---\n\nMARKER-PLAN-OTHER\n");

const WIDE = { since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", limit: 100 };
const meScopes = [{ layer: "memory", visibility: "shared" }];
const mePrincipal = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-ME", user_id: "user-ME", agent_id: "agent-ME", role_id: "role-ME" };

const rows = [];
for (const [label, options] of [
  ["scopes=null（parity：库级无身份）", { scopes: null }],
  ["scopes=[memory/shared] + principal=me（受限）", { scopes: meScopes, principal: mePrincipal, agentId: "agent-ME" }],
  ["scopes=[]（显式空）", { scopes: [], principal: mePrincipal, agentId: "agent-ME" }],
]) {
  const lib = createMemoryLib({ dataRoot, workspaceRoot, vectorLane: { probe: false }, ...options });
  const page = await lib.timeline(WIDE);
  const blob = JSON.stringify(page.results ?? []);
  rows.push({
    场景: label,
    roots: lib.roots.map((r) => path.relative(dataRoot, typeof r === "string" ? r : r.path).replaceAll("\\", "/")),
    total_count: page.total_count,
    含别人SHARED: blob.includes("curated/shared/marker-shared.md"),
    含别人ROLE: blob.includes("agent-OTHER/role-x.md"),
    含别人TOOL: blob.includes("tools-memory/marker-tool.md"),
    含别人PLAN: blob.includes("plans/marker-plan.md"),
  });
}

// 生产装配形状（server-wiring）也过一遍，确认"生产路径"下 scopes=null 是进不去的
const factory = createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
const viaFactoryNoScopes = factory({ scopes: null });
const factoryPage = await viaFactoryNoScopes.timeline(WIDE);
rows.push({
  场景: "经 server-wiring：scopes=null（生产 libFactory 形状）",
  roots: viaFactoryNoScopes.roots.map((r) => path.relative(dataRoot, typeof r === "string" ? r : r.path).replaceAll("\\", "/")),
  total_count: factoryPage.total_count,
  含别人SHARED: JSON.stringify(factoryPage.results).includes("marker-shared"),
  含别人ROLE: JSON.stringify(factoryPage.results).includes("role-x.md"),
  含别人TOOL: JSON.stringify(factoryPage.results).includes("marker-tool"),
  含别人PLAN: JSON.stringify(factoryPage.results).includes("marker-plan"),
});

console.log(JSON.stringify({ fixture: "shared/role/tool/plan 各一条『属于别人』", rows }, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
