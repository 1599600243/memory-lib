// 产品岗独立复核 CONSOLE-1：C1 真实数据 / C2 被拒计数 / C3 无外链
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const mod = await import("file:///D:/MemoryLib/app/memory-lib/web/console-agents.mjs?v=" + Date.now());
const { aggregateAgents } = mod;

// ── C1：真实审计数据 ──
const r = await fetch("http://127.0.0.1:8787/v1/admin/audit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, limit: 5000 }),
});
const j = await r.json();
const events = j.events ?? [];
console.log(`C1 拉取审计事件: HTTP ${r.status}, ${events.length} 条`);
const agg = aggregateAgents(events);
const rows = agg.groups ?? agg.rows ?? [];
console.log(`C1 聚合出 ${rows.length} 个身份组，样本 ${agg.sampleSize ?? "?"} 条，时间 ${agg.from ?? "?"} → ${agg.to ?? "?"}`);
for (const g of rows.slice(0, 6)) {
  console.log(`   ${String(g.calls).padStart(5)} 次${g.denied ? ` (拒 ${g.denied})` : ""}  ${g.framework} / ${g.agent} / ${g.role}  actions=${JSON.stringify((g.actions ?? []).slice(0, 3))}`);
}
const roles = new Set(rows.map((g) => g.role));
for (const need of ["reader", "librarian-admin", "capture-ingest"]) {
  console.log(`   C1 ${need}: ${roles.has(need) ? "✅ 出现" : "❌ 缺失"}`);
}

// ── C2：构造一条 allow:false ──
const base = aggregateAgents([
  { ts: "2026-10-27T00:00:00.000Z", framework: "fw", agent: "a1", role: "reader", action: "search", allow: true },
]);
const withDeny = aggregateAgents([
  { ts: "2026-10-27T00:00:00.000Z", framework: "fw", agent: "a1", role: "reader", action: "search", allow: true },
  { ts: "2026-10-27T00:01:00.000Z", framework: "fw", agent: "a1", role: "reader", action: "write", allow: false },
]);
const g0 = (base.groups ?? base.rows)[0];
const g1 = (withDeny.groups ?? withDeny.rows)[0];
console.log(`\nC2 加一条 allow:false 前后: denied ${g0.denied} → ${g1.denied} ${g1.denied === g0.denied + 1 ? "✅" : "❌"}`);
console.log(`C2 被拒动作: ${JSON.stringify(g1.deniedActions ?? g1.actions ?? [])}`);

// ── C3：无外链 ──
for (const f of ["D:\\MemoryLib\\app\\memory-lib\\web\\console.html", "D:\\MemoryLib\\app\\memory-lib\\web\\console-agents.mjs"]) {
  const src = fs.readFileSync(f, "utf8");
  const externals = [...src.matchAll(/https?:\/\/[^\s"'<>)]+/gu)].map((m) => m[0]).filter((u) => !/127\.0\.0\.1|localhost/u.test(u));
  console.log(`\nC3 ${f.split("\\").pop()}: 外链 ${externals.length} 个 ${externals.length ? "❌ " + externals.slice(0, 3).join(", ") : "✅"}`);
}
