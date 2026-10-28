#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT2 —— 可及性（reachability）机械清单。
// 只回答一件事：每个嫌疑点**能不能从一个真实的 MCP 读工具走到**？
// 来源：mcp/mcp-server.mjs 的 coreFromLib 处理器 + localhost-server 的 REST 路由。
// 目的：让上表的"可及性"一列也**自动生成**，不手打。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcp = await fs.readFile(path.join(root, "mcp", "mcp-server.mjs"), "utf8");
const server = await fs.readFile(path.join(root, "src", "localhost-server.mjs"), "utf8");

// 嫌疑点 → 它对应的 MCP 工具 / REST 路由（用 grep 事实说话）
const MAP = [
  { id: "S1", site: "src/plans-memory.mjs:146-148", fn: "plans.listPlans", mcpHandler: "planList", mcpTool: "memory_plan_list", restRoute: "/v1/plans/list" },
  { id: "S2", site: "src/profile-memory.mjs:50", fn: "profiles.listProfiles", mcpHandler: null, mcpTool: null, restRoute: "/v1/profile/list" },
  { id: "S3", site: "src/role-memory.mjs:88", fn: "roleMemory.listRoleNotes", mcpHandler: "roleList", mcpTool: "memory_role_list", restRoute: "/v1/roles/list" },
  { id: "S4", site: "src/tools-memory.mjs:118", fn: "tools.listTools", mcpHandler: "toolList", mcpTool: "memory_tool_list", restRoute: "/v1/tools/list" },
  { id: "S5", site: "src/project-memory.mjs:128,152", fn: "project.listProjects", mcpHandler: null, mcpTool: null, restRoute: null },
  { id: "S6", site: "src/pet-runtime-store.mjs:53", fn: "petRuntime.listDrafts", mcpHandler: "petDraftsList", mcpTool: "pet_drafts_list", restRoute: null },
  { id: "S7", site: "src/pet-runtime-store.mjs:91", fn: "petRuntime.listPersonas", mcpHandler: "petPersonaList", mcpTool: "pet_persona_list", restRoute: null },
];

const rows = MAP.map((m) => {
  const handlerSnippet = m.mcpHandler ? (mcp.split("\n").find((l) => l.includes(`${m.mcpHandler}:`)) ?? "").trim().slice(0, 120) : null;
  const routePresent = m.restRoute ? server.includes(`url === "${m.restRoute}"`) : false;
  // 关键：这个 handler 有没有把 principal 注进去？
  const injectsPrincipal = handlerSnippet ? /principal/.test(handlerSnippet) : null;
  return {
    id: m.id,
    site: m.site,
    repoFn: m.fn,
    mcpTool: m.mcpTool,
    mcpHandlerLine: m.mcpHandler ? handlerSnippet : "（无 MCP 处理器）",
    handlerInjectsPrincipal: injectsPrincipal,
    restRoute: m.restRoute,
    restRouteExists: routePresent,
    reachableFromMcpReadTool: Boolean(m.mcpTool),
  };
});

const md = ["| 嫌疑点 | 仓储方法 | MCP 工具 | 处理器是否注入 principal | REST 路由 | 可及（MCP 读工具） |", "|---|---|---|---|---|---|"];
for (const r of rows) {
  md.push(`| ${r.id} | \`${r.repoFn}\` | ${r.mcpTool ?? "（无）"} | ${r.handlerInjectsPrincipal === null ? "-" : r.handlerInjectsPrincipal ? "是 ✅" : "**否 ❌**"} | ${r.restRoute ?? "（无）"}${r.restRoute ? (r.restRouteExists ? " ✔存在" : " ✖不存在") : ""} | ${r.reachableFromMcpReadTool ? "**是**" : "否"} |`);
}

console.log(JSON.stringify({ rows, markdown: md.join("\n") }, null, 2));
