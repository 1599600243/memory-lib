#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT2 —— 把两个产物合成**一张**判定表（本单交付物）。
// 输入：reports/VISIBILITY-AUDIT-2-REJECT2-{suspects,reachability}.json
// 输出：markdown 到 stdout。**不手打任何数字。**
import fs from "node:fs/promises";

const DIR = "D:\\MemoryLib\\reports";
const suspects = JSON.parse(await fs.readFile(`${DIR}\\VISIBILITY-AUDIT-2-REJECT2-suspects.json`, "utf8"));
const reach = JSON.parse(await fs.readFile(`${DIR}\\VISIBILITY-AUDIT-2-REJECT2-reachability.json`, "utf8"));

const byId = new Map(reach.rows.map((r) => [r.id, r]));
const lines = [];
lines.push("| 嫌疑点 | 位置 | 无身份时 | 含别人的东西 | 判定 | 可及（MCP 读工具） | 处理器注入 principal |");
lines.push("|---|---|---|---|---|---|---|");
for (const s of suspects.嫌疑点) {
  const r = byId.get(s.id) ?? {};
  const c = s["无身份"] ?? {};
  const returned = c.抛错 ? `抛错：${c.抛错}` : c.条数;
  lines.push(`| ${s.id} ${s.desc} | \`${s.site}\` | ${returned} 条 | ${c.含VICTIM标记} | ${s.结论} | ${r.reachableFromMcpReadTool ? "**是**" : "否"} | ${r.handlerInjectsPrincipal === null ? "—" : r.handlerInjectsPrincipal ? "是" : "**否**"} |`);
}
lines.push("");
lines.push(`夹具文件数：${JSON.stringify(suspects.夹具文件数)}`);
console.log(lines.join("\n"));
