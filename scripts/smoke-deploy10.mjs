#!/usr/bin/env node
/**
 * smoke-deploy10.mjs —— DEPLOY-10（上线 M2.1-A）的真实入口冒烟
 * **只读**：只发检索/健康请求，不写任何数据、不改任何配置。
 *
 * 判据（全是"用户看得见"的行为，不是内部状态）：
 *   ① 空 query + 按天 ⇒ 200，且**翻页能取全**（取回条数 == total_count）
 *   ② 两天互不污染：10-09 与 10-10 的取回集合**没有交集**，且各自取全
 *   ③ 空 query 且无时间范围 ⇒ **仍然明确报错**（不许退化成"枚举一切"）
 *   ④ 带关键词的旧检索**没被破坏**
 *   ⑤ MCP 与 REST 用同一组参数 ⇒ total_count 一致、**整日路径集合与顺序一致**
 *   ⑥ 健康档：healthy、pending/failed 有界
 *
 * 用法：node smoke-deploy10.mjs [目标日，默认 2026-10-10]
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const day = process.argv[2] ?? "2026-10-10";
const dayBefore = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) fail += 1; };

async function search(body) {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, ...body }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const mcpSearch = async (args) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mcp-credential-ref": CRED, "x-mcp-secret": secret, "x-mcp-agent": "pilot-01", "x-mcp-role": "researcher" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: args } }),
  });
  const body = await r.json().catch(() => null);
  try { return JSON.parse(body?.result?.content?.[0]?.text ?? "null"); } catch { return null; }
};
async function fullDay(d, pageSize = 25) {
  const first = await search({ since: d, until: d, limit: pageSize, offset: 0 });
  if (first.status !== 200) return { status: first.status, all: [], total: null, pages: 0, raw: first.body };
  const all = [...(first.body.results ?? [])];
  let off = first.body.next_offset ?? null; let pages = 1;
  while (off !== null && pages < 40) { const p = await search({ since: d, until: d, limit: pageSize, offset: off }); all.push(...(p.body?.results ?? [])); off = p.body?.next_offset ?? null; pages += 1; }
  return { status: 200, all, total: first.body.total_count, pages, raw: first.body };
}
const key = (rs) => (rs ?? []).map((x) => String(x.path)).sort();
const order = (rs) => (rs ?? []).map((x) => String(x.path));
const isConv = (x) => String(x.path ?? "").replace(/\\/gu, "/").includes("evidence/conversations");

console.log(`=== DEPLOY-10 冒烟 · 生产 ${BASE} · 目标日 ${day} ===\n`);

console.log("== ① 空 query + 按天：能取全吗 ==");
const a = await fullDay(day);
check(a.status === 200, `HTTP 200（实际 ${a.status}）`);
check(a.all.length === a.total, `翻页取回条数(${a.all.length}) == total_count(${a.total})，共 ${a.pages} 页`);
check(a.all.every((x) => x.path && x.updatedAt && x.excerpt), "每条都带 路径 + 时间 + 可读摘要");
const conv = a.all.filter(isConv);
console.log(`     该日共 ${a.all.length} 条，其中对话原文 ${conv.length} 条`);
const baseName = (p) => String(p).split(/[\\/]/u).pop();
const flat = (s) => String(s ?? "").replace(/\s+/gu, " ").slice(0, 48);
for (const x of a.all.slice(0, 6)) console.log(`       · ${baseName(x.path)}  ${String(x.updatedAt).slice(0, 19)}  ${flat(x.excerpt)}`);

console.log(`\n== ② ${dayBefore} 与 ${day} 互不污染 ==`);
const b = await fullDay(dayBefore);
check(b.status === 200, `${dayBefore} HTTP 200（实际 ${b.status}）`);
check(b.all.length === b.total, `${dayBefore} 也取全（${b.all.length}/${b.total}）`);
const inter = key(a.all).filter((p) => key(b.all).includes(p));
check(inter.length === 0, `两天取回集合无交集（交集 ${inter.length} 条）`);

console.log("\n== ③ 空 query 且无时间范围：仍须明确报错 ==");
const noRange = await search({ limit: 10 });
check(noRange.status === 400, `HTTP 400（实际 ${noRange.status}）→ ${JSON.stringify(noRange.body?.message ?? noRange.body).slice(0, 80)}`);

console.log("\n== ④ 旧的关键词检索没被破坏 ==");
const kw = await search({ query: "记忆库", limit: 5 });
check(kw.status === 200 && Array.isArray(kw.body?.results), `HTTP 200 且返回数组（${kw.body?.results?.length} 条）`);

console.log("\n== ⑤ MCP 与 REST 等价（同一组参数）==");
const mcpArgs = { since: day, until: day, limit: 25, offset: 0 };
const m1 = await mcpSearch(mcpArgs);
if (m1) {
  check(m1.total_count === a.total, `total_count 一致（MCP ${m1.total_count} / REST ${a.total}）`);
  const mAll = [...(m1.results ?? [])];
  let mo = m1.next_offset ?? null, mp = 1;
  while (mo !== null && mp < 40) { const p = await mcpSearch({ ...mcpArgs, offset: mo }); mAll.push(...(p?.results ?? [])); mo = p?.next_offset ?? null; mp += 1; }
  check(mAll.length === a.total, `MCP 翻页也取全（${mAll.length}/${a.total}）`);
  check(JSON.stringify(key(mAll)) === JSON.stringify(key(a.all)), "整日路径集合一致");
  check(JSON.stringify(order(mAll)) === JSON.stringify(order(a.all)), "排列顺序一致");
} else {
  check(false, "MCP 未返回可解析结果");
}

console.log("\n== ⑥ 健康档 ==");
const h = await fetch(`${BASE}/v1/health`).then((r) => r.json()).catch(() => null);
check(h?.health === "healthy", `health=${h?.health}`);
check(Number(h?.index?.failed ?? 1) === 0, `failed=${h?.index?.failed}`);
check(Number(h?.index?.pending_changes ?? 999) <= 3, `pending_changes=${h?.index?.pending_changes}（捕获后会瞬时为 1，属已知）`);
console.log(`     indexed=${h?.index?.indexed_files}  last_indexed_at=${h?.index?.last_indexed_at}`);

console.log(fail === 0 ? "\n✅ 冒烟全部通过" : `\n❌ 冒烟有 ${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
