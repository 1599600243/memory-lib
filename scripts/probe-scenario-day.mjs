#!/usr/bin/env node
/**
 * probe-scenario-day.mjs —— 场景门现状探针（**只读生产**，不改任何东西）
 *
 * 目的有两个，都不是"跑测试"：
 *   ① 独立核对开发报告里那句「未部署、未重启、未碰生产数据」是否属实
 *      —— 若生产仍按旧行为拒绝空 query 的按天枚举，则新码确实没进生产；
 *   ② 量一下**真实那一天**（默认 2026-10-10）到底有多少条原文、够不够复述，
 *      这是 M2.1-B「让召回自己发生」要用到的实数。
 *
 * 用法：node probe-scenario-day.mjs [YYYY-MM-DD] [关键词]
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:8787";
const SECRET_FILE = "D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret";
const CRED = "memory-lib/deepseek-harness";
const day = process.argv[2] ?? "2026-10-10";
const keyword = process.argv[3] ?? "聊了什么";

const secret = fs.readFileSync(SECRET_FILE, "utf8").trim();
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };

async function post(route, body) {
  try {
    const r = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, ...body }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: { error: String(e.message) } }; }
}
const brief = (v) => JSON.stringify(v ?? null).slice(0, 200);

console.log(`=== 生产 ${BASE} · 目标日 ${day} ===`);

const health = await fetch(`${BASE}/v1/health`).then((r) => r.json()).catch(() => null);
console.log(`health      : status=${health?.status} pid=${health?.pid} indexed=${health?.index?.indexed_count ?? health?.indexed_count} pending=${health?.index?.pending_count ?? health?.pending_count} failed=${health?.index?.failed_count ?? health?.failed_count}`);

console.log("\n--- ① 新能力（空 query + 按天枚举）：若生产未部署，应当**被拒** ---");
const tl = await post("/v1/search", { since: day, until: day, limit: 100, offset: 0 });
console.log(`  status=${tl.status}  total_count=${tl.body?.total_count ?? "-"}  返回=${(tl.body?.results ?? []).length} 条`);
console.log(`  响应: ${brief(tl.body?.error ?? tl.body)}`);
console.log(tl.status === 200
  ? "  ⇒ 生产**已具备**按天枚举（新码已在生产上）"
  : "  ⇒ 生产**仍按旧行为拒绝**空 query 按天枚举 ⇒ 开发报告的「未部署生产」属实");

console.log("\n--- ② 旧行为（关键词检索）是否原样保留 ---");
for (const [label, body] of [
  [`关键词「${keyword}」+ 按天 limit=50`, { query: keyword, limit: 50, since: day, until: day, graphExpand: false }],
  [`关键词「${keyword}」全库 limit=20`, { query: keyword, limit: 20, graphExpand: false }],
]) {
  const r = await post("/v1/search", body);
  const items = r.body?.results ?? [];
  console.log(`  ${label}: status=${r.status} 返回=${items.length} 条`);
}

console.log("\n--- ③ 那一天真实有多少原文（用现有能力量：把范围放宽 + 大 limit）---");
const ev = await post("/v1/search", { query: day.replace(/-/gu, "/"), limit: 100, since: day, until: day, graphExpand: false });
const ev2 = await post("/v1/search", { query: day.replace(/-/gu, ""), limit: 100, since: day, until: day, graphExpand: false });
const evs = await post("/v1/search", { query: day.slice(5).replace("-", "/"), limit: 100, since: day, until: day, graphExpand: false });
for (const [l, r] of [["10/10 形式", ev], ["20261010 形式", ev2], ["10/10 短式", evs]]) {
  const items = r.body?.results ?? [];
  const conv = items.filter((x) => String(x.path ?? "").includes("evidence/conversations"));
  console.log(`  query="${l}" status=${r.status} 返回=${items.length} 其中原文=${conv.length}`);
}
