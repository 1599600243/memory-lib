// 多 agent 用量视图：从审计日志聚合"谁在用记忆、用什么、什么时候、被拒多少"
// 用法: node scripts/agent-usage.mjs [--days 7] [--audit <path>] [--json]
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const DAYS = Number(arg("days", 7));
const AUDIT = arg("audit", "D:\\MemoryLib\\data\\runtime\\audit\\access.jsonl");
const AS_JSON = argv.includes("--json");

const since = Date.now() - DAYS * 86400_000;
const byAgent = new Map();
const byTool = new Map();
let total = 0, denied = 0, oldest = null, newest = null;

const rl = readline.createInterface({ input: fs.createReadStream(AUDIT, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const t = Date.parse(r.ts);
  if (!Number.isFinite(t) || t < since) continue;
  total++;
  if (oldest === null || t < oldest) oldest = t;
  if (newest === null || t > newest) newest = t;
  const key = `${r.framework ?? "-"} / ${r.agent ?? "-"} / ${r.role ?? "-"}`;
  const a = byAgent.get(key) ?? { calls: 0, denied: 0, last: 0, first: Infinity, tools: new Map(), channels: new Map() };
  a.calls++;
  a.last = Math.max(a.last, t); a.first = Math.min(a.first, t);
  const tool = r.tool ?? r.action ?? r.method ?? r.path ?? "-";
  a.tools.set(tool, (a.tools.get(tool) ?? 0) + 1);
  a.channels.set(r.channel ?? "-", (a.channels.get(r.channel ?? "-") ?? 0) + 1);
  const okFlag = r.allowed ?? r.ok ?? (r.decision === "allow" ? true : r.decision === "deny" ? false : null);
  if (okFlag === false) { a.denied++; denied++; }
  byAgent.set(key, a);
  byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
}

const rows = [...byAgent.entries()].sort((x, y) => y[1].calls - x[1].calls);
const fmt = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false });

if (AS_JSON) {
  console.log(JSON.stringify({
    windowDays: DAYS, total, denied,
    from: oldest ? new Date(oldest).toISOString() : null,
    to: newest ? new Date(newest).toISOString() : null,
    agents: rows.map(([k, v]) => ({ principal: k, calls: v.calls, denied: v.denied, last: new Date(v.last).toISOString(), topTools: [...v.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) })),
  }, null, 2));
} else {
  console.log(`最近 ${DAYS} 天：${total} 次调用，其中被拒 ${denied} 次`);
  if (oldest) console.log(`时间范围：${fmt(oldest)} → ${fmt(newest)}\n`);
  console.log("按身份（framework / agent / role）：");
  for (const [k, v] of rows.slice(0, 12)) {
    const top = [...v.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`).join(", ");
    console.log(`  ${String(v.calls).padStart(6)} 次${v.denied ? `（拒 ${v.denied}）` : ""}  ${k.padEnd(46)} 最后 ${fmt(v.last)}  ${top}`);
  }
  console.log("\n最常用的工具：");
  for (const [n, c] of [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(c).padStart(6)}  ${n}`);
  }
}
