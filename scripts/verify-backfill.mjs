#!/usr/bin/env node
/**
 * verify-backfill.mjs —— 回填后的**独立核对**（只读）
 *
 * 判据（不是"跑一遍脚本"）：
 *   ① 回填前答不出来的那些天，现在**能答出来**：按天枚举取回的条数 == 该日文件系统上应有的条数
 *      （其中"应有"= 有归属的对话原文 + 该日的其它可见文档）
 *   ② 回填前就正常的那天（10-10）**没有变化**（回归）
 *   ③ 分页取全（取回条数 == total_count），MCP 与 REST 一致
 *   ④ 每一天都不串天（相邻两天集合无交集）
 *   ⑤ 探针那 19 条（规则 B）**仍然不可见** —— 不许把测试垃圾放进"那天聊了什么"
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };
const DAYS = ["2026-09-15", "2026-09-17", "2026-10-04", "2026-10-06", "2026-10-07", "2026-10-10"];
const ROOT = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) fail += 1; };

const search = async (b) => {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, ...b }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const mcp = async (args) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-mcp-credential-ref": CRED, "x-mcp-secret": secret, "x-mcp-agent": "pilot-01", "x-mcp-role": "researcher" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: args } }) });
  const b = await r.json().catch(() => null);
  try { return JSON.parse(b?.result?.content?.[0]?.text ?? "null"); } catch { return null; }
};
async function fullDay(day) {
  const first = await search({ since: day, until: day, limit: 50, offset: 0 });
  if (first.status !== 200) return { status: first.status, all: [], total: null };
  const all = [...(first.body.results ?? [])];
  let off = first.body.next_offset ?? null, pages = 1;
  while (off !== null && pages < 60) { const p = await search({ since: day, until: day, limit: 50, offset: off }); all.push(...(p.body?.results ?? [])); off = p.body?.next_offset ?? null; pages += 1; }
  return { status: 200, all, total: first.body.total_count, pages };
}
const key = (rs) => (rs ?? []).map((x) => String(x.path)).sort();

// 文件系统：该本地日"有归属的对话原文"条数 + 探针条数
const conv = [];
for (const name of fs.readdirSync(ROOT)) {
  if (!name.endsWith(".md")) continue;
  const t = fs.readFileSync(path.join(ROOT, name), "utf8");
  if (!/type:\s*conversation/u.test(t)) continue;
  const at = /capturedAt:\s*(\S+)/u.exec(t)?.[1];
  if (!at) continue;
  conv.push({ name, ms: Date.parse(at), attributed: /^groupId:/mu.test(t) });
}
const dayCount = (day) => {
  const s = Date.parse(`${day}T00:00:00+08:00`), e = s + 86400000;
  const inDay = conv.filter((c) => c.ms >= s && c.ms < e);
  return { attributed: inDay.filter((c) => c.attributed).length, unattributed: inDay.filter((c) => !c.attributed).length };
};

console.log("=== 回填后逐日核对（生产 · 只读）===\n");
const sets = {};
for (const day of DAYS) {
  const fsStat = dayCount(day);
  const api = await fullDay(day);
  sets[day] = api.all;
  const convReturned = api.all.filter((x) => /evidence[\\/]conversations/u.test(String(x.path))).length;
  const complete = api.all.length === api.total;
  console.log(`== ${day} ==  文件系统有归属原文 ${fsStat.attributed} 条（无归属 ${fsStat.unattributed} 条）`);
  check(api.status === 200, `HTTP 200（实际 ${api.status}）`);
  check(complete, `翻页取全：${api.all.length}/${api.total}（${api.pages} 页）`);
  check(convReturned === fsStat.attributed, `取回原文 ${convReturned} 条 == 文件系统有归属 ${fsStat.attributed} 条（无归属 ${fsStat.unattributed} 条不该被算进来）`);
}

console.log("\n== 回归：10-10 与 10-09 仍然互不污染 ==");
const d910 = await fullDay("2026-10-09");
const inter = key(sets["2026-10-10"]).filter((p) => key(d910.all).includes(p));
check(inter.length === 0, `10-10(${sets["2026-10-10"].length} 条) 与 10-09(${d910.all.length} 条) 交集 ${inter.length}`);
check(sets["2026-10-10"].length === 9, `10-10 仍是 9 条（回填前就是 9，回归无变化）——实际 ${sets["2026-10-10"].length}`);

console.log("\n== 探针那 19 条仍然不可见（不许把测试垃圾放进'那天聊了什么'）==");
const probeIds = conv.filter((c) => !c.attributed).map((c) => c.name.replace(/\.md$/u, ""));
const probeVisible = new Set();
for (const day of ["2026-09-17", "2026-09-20", "2026-09-21", "2026-10-13"]) {
  const r = await fullDay(day);
  for (const x of r.all) for (const pid of probeIds) if (String(x.path).includes(pid)) probeVisible.add(pid);
}
check(probeVisible.size === 0, `19 条探针里被取回的有 ${probeVisible.size} 条${probeVisible.size ? "：" + [...probeVisible].slice(0, 3).join(", ") : ""}`);

console.log("\n== MCP 与 REST 一致（抽查 10-06）==");
const m = await mcp({ since: "2026-10-06", until: "2026-10-06", limit: 50, offset: 0 });
if (m) {
  check(m.total_count === sets["2026-10-06"].length, `total_count 一致（MCP ${m.total_count} / REST ${sets["2026-10-06"].length}）`);
} else check(false, "MCP 未返回可解析结果");

console.log(fail === 0 ? "\n✅ 回填核对全部通过" : `\n❌ 有 ${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
