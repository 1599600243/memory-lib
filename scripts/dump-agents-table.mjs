// 打印 Agents 表的真实内容（逐列），用于向用户解释每一列
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const { aggregateAgents } = await import("file:///D:/MemoryLib/app/memory-lib/web/console-agents.mjs?v=" + Date.now());

const r = await fetch("http://127.0.0.1:8787/v1/admin/audit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, limit: 1000 }),
});
const events = (await r.json()).events ?? [];
const s = aggregateAgents(events);
console.log(`样本 ${s.total} 条，覆盖 ${s.from} → ${s.to}，总拒绝 ${s.denied}\n`);
for (const row of s.rows) {
  console.log(`${row.framework} / ${row.agent} / ${row.role}`);
  console.log(`   调用次数 = ${row.calls}   被拒 = ${row.denied}   最后活跃 = ${row.last}`);
  console.log(`   Top 动作 = ${row.topActions.map((a) => `${a.action}×${a.count}`).join(", ") || "-"}`);
  console.log(`   Channel  = ${row.channels.map((c) => `${c.channel}×${c.count}`).join(", ") || "-"}`);
  if (row.deniedActions.length) console.log(`   被拒动作 = ${row.deniedActions.map((a) => `${a.action}×${a.count}`).join(", ")}`);
  console.log("");
}
