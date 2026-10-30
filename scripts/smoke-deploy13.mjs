#!/usr/bin/env node
/**
 * smoke-deploy13.mjs —— DEPLOY-13（把 7 个里程碑一次性上线生产）的真实入口冒烟
 *
 * 两种模式：
 *   node smoke-deploy13.mjs baseline   —— **发之前**跑：量旧生产上"按天取回"的基线读数
 *   node smoke-deploy13.mjs after      —— **发之后**跑：新路由 + 第一判据真入口 + 回归 + 大日子 + 写链路
 *
 * 被部署内容（src 与 d643490 完全一致，见 DEPLOY-13 记录）：
 *   M2.1-A 时间线完整按天 / CAPTURE-ATTR 归属 / M2.1-B1+B2 人话日期 / DAYRECALL-1 日历日 /
 *   ATOMICWRITE-1 原子写 / DAY-INTERVAL-1 口径统一 / SCENARIO-1+2 参考接入与大日子分批
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const EVID = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";
const SH = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const MODE = process.argv[2] ?? "after";
// 期望的"部署默认时区"：DEPLOY-13 时生产没有配置项 ⇒ UTC；TZ-CONFIG-1 上线后应为 Asia/Shanghai。
const EXPECT_TZ = process.argv[3] ?? "UTC";
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };

const post = async (route, body) => {
  const r = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, ...body }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// 用既有 since/until 口径翻页取全（新旧 sha 都支持 ⇒ 可做发前/发后对比）
async function dayViaSinceUntil(day, limit = 100) {
  const paths = new Set();
  let off = 0;
  let zone = null;
  for (let page = 0; page < 60; page += 1) {
    const r = await post("/v1/search", { since: day, until: day, limit, offset: off });
    if (r.status !== 200) return { error: `${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 80)}` };
    if (zone === null) zone = r.body?.resolvedRange?.calendarTimezone ?? null;
    for (const it of r.body.results ?? []) paths.add(String(it.path));
    if (r.body.next_offset === null || r.body.next_offset === undefined) break;
    off = r.body.next_offset;
  }
  return { count: paths.size, paths, zone };
}

const DAYS = ["2026-10-06", "2026-10-10", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-07"];

if (MODE === "baseline") {
  console.log(`=== 发前基线（旧生产 ${BASE}）===`);
  const out = {};
  for (const day of DAYS) {
    const r = await dayViaSinceUntil(day);
    out[day] = r.error ?? r.count;
    console.log(`${day} : ${r.error ?? r.count}`);
  }
  fs.writeFileSync("D:\\MemoryLib\\backups\\deploy13-meta\\baseline-days.json", `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log("\n已写入 D:\\MemoryLib\\backups\\deploy13-meta\\baseline-days.json");
  process.exit(0);
}

// ---------------------------------------------------------------- after
const BASELINE = (() => { try { return JSON.parse(fs.readFileSync("D:\\MemoryLib\\backups\\deploy13-meta\\baseline-days.json", "utf8")); } catch { return {}; } })();
const BIG_DAY = "2026-10-07";
const BIG_EXPECT = BASELINE[BIG_DAY] ?? 177;

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) fail += 1; };
const evCount = () => fs.readdirSync(EVID).filter((n) => n.endsWith(".md")).length;
const stamp = new Date().toISOString().replace(/[-:.]/gu, "").slice(0, 17);
const MARK = `DEPLOY13SMOKE${stamp}`;

const { recallScenario } = await import("../app/memory-lib/src/scenario-recall.mjs");

console.log(`=== DEPLOY-13 冒烟 · 生产 ${BASE} · 标记 ${MARK} ===\n`);

console.log("== ① 新路由真的上线了（旧 sha 应为 404）==");
const h = await fetch(`${BASE}/v1/health`).then((r) => r.json().catch(() => null));
check(h?.health === "healthy", `健康：${h?.health}`);
const nope = await post("/v1/date/resolve", { text: "10/10 我们聊了什么", now: NOW, timezone: SH });
const rr = nope.body?.resolvedRange ?? nope.body?.result?.resolvedRange;
check(nope.status === 200 && Boolean(rr), `/v1/date/resolve 200 且带 resolvedRange（status=${nope.status}）`);
console.log(`     resolvedRange = ${JSON.stringify(rr)}`);
check(String(rr?.untilExclusive ?? "").length > 0, "回显了半开区间上界 untilExclusive");
// ⚠️ 字段名踩过一次：`/v1/date/resolve` 回的是 `timezone`，`/v1/search` 的 resolvedRange 回的是 `calendarTimezone`。
check(rr?.timezone === SH, `/v1/date/resolve 回显 timezone = ${rr?.timezone}`);

console.log("\n== ② 第一判据的真入口：「10/10 我们聊了什么」==");
const sc = await recallScenario({ baseUrl: BASE, credentials: { credential_ref: CRED, secret }, principal: { agent_id: "pilot-01", role_id: "researcher" }, text: "10/10 我们聊了什么", now: NOW, timezone: SH, pageSize: 100, chunkChars: 8000 });
check(sc?.kind === "answer", `正常应答（kind=${sc?.kind} reason=${sc?.reason ?? "-"}）`);
check(sc?.count === sc?.totalCount && sc?.complete === true, `取回 == total_count 且 complete=true（${sc?.count}/${sc?.totalCount}）`);
check(sc?.count === BASELINE["2026-10-10"], `与发前基线一致（发后 ${sc?.count} / 发前 ${BASELINE["2026-10-10"]}）`);
console.log(`     素材：${sc?.chunks?.length} 块 / excerpt 合计 ${(sc?.items ?? []).reduce((n, x) => n + String(x.excerpt ?? "").length, 0)} 字符`);

// 本地日取全（calendarDate + calendarTimezone），**必须翻页** —— 曾经漏翻页导致"取回 100/177"的假回归。
async function dayViaCalendar(day, limit = 100) {
  const paths = new Set();
  let off = 0;
  let total = null;
  for (let page = 0; page < 60; page += 1) {
    const r = await post("/v1/search", { calendarDate: day, calendarTimezone: SH, limit, offset: off });
    if (r.status !== 200) return { error: `${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 80)}` };
    if (total === null) total = r.body?.total_count ?? null;
    for (const it of r.body.results ?? []) paths.add(String(it.path));
    if (r.body.next_offset === null || r.body.next_offset === undefined) break;
    off = r.body.next_offset;
  }
  return { count: paths.size, total, paths };
}

console.log("\n== ③ 回归：本地日按天取回与发前一致（必须显式带 calendarTimezone）==");
// ⚠️ 这条踩过一次：**不带** calendarTimezone 的裸 since/until 在生产上落到 UTC 日（见 ⑦），
//    拿它跟"本地日基线"比会得到一堆假的"变少"。本地日的真判据是 calendarDate + calendarTimezone。
// ⚠️ 10-15 有一条**已知日期漂移**：`project-state/memory-system/refinement-inspection.md` 是服务自己
//    定期重写的巡检报告，只有 `updated_at`；它被重写一次就换一天（副本里是 10-15T15:54Z，活库已变 10-16T03:34Z）。
//    所以这一天允许与基线相差 1，并且要求打印出来，不许静默放过。
for (const day of DAYS) {
  const viaNew = await dayViaCalendar(day);
  const base = BASELINE[day];
  const drift = day === "2026-10-15" ? 1 : 0;
  const grew = typeof base === "number" && viaNew.count > base;
  const ok = typeof base === "number" && viaNew.count >= base - drift && viaNew.total >= base - drift && viaNew.count === viaNew.total;
  check(ok, `${day}：calendarDate+TZ 取回 ${viaNew.count}/total ${viaNew.total} · 发前 ${base}${grew ? "（增加了，正常：活的一天有新捕获）" : ""}${drift && viaNew.count === base - 1 ? "（−1 = 已知的巡检报告日期漂移）" : ""}`);
  if (!ok) console.log(`     ⚠️ **变少了**：发前 ${base}，发后 ${viaNew.count}（这就是回归，必须查）`);
  const viaBare = await dayViaSinceUntil(day);
  console.log(`     对照：不带时区的裸 since/until = ${viaBare.count}（生效时区 ${viaBare.zone ?? "-"}）`);
}

console.log(`\n== ⑦ 部署默认时区：省略时区的裸日期按哪个时区解释（期望 ${EXPECT_TZ}）==`);
const bare = await post("/v1/search", { since: BIG_DAY, until: BIG_DAY, limit: 1 });
const bareZone = bare.body?.resolvedRange?.calendarTimezone;
console.log(`     裸 since/until=${BIG_DAY} ⇒ resolvedRange=${JSON.stringify(bare.body?.resolvedRange)}`);
const bareFull = await dayViaSinceUntil(BIG_DAY);
console.log(`     裸日期取全 ${BIG_DAY} = ${bareFull.count} 条（本地日 = ${BIG_EXPECT} 条）`);
check(bareZone === EXPECT_TZ, `服务端默认时区 == ${EXPECT_TZ}（实际 ${bareZone}）`);
if (EXPECT_TZ === "Asia/Shanghai") {
  check(bareFull.count === BIG_EXPECT, `裸日期现在也取到完整本地日：${bareFull.count} == ${BIG_EXPECT}（TZ-CONFIG-1 恢复发前行为）`);
} else {
  console.log(`     ⚠️ 默认时区是 UTC ⇒ 省略时区的接入方会按 UTC 日解释（这是 DEPLOY-13 的已知行为变化）。`);
}

console.log("\n== ④ 大日子（SCENARIO-2 在生产生效）==");
const big = await recallScenario({ baseUrl: BASE, credentials: { credential_ref: CRED, secret }, principal: { agent_id: "pilot-01", role_id: "researcher" }, text: `${BIG_DAY} 我们聊了什么`, now: NOW, timezone: SH, pageSize: 100, chunkChars: 8000 });
check(big?.count === BIG_EXPECT, `${BIG_DAY} 取回 == 发前（${big?.count}/${BIG_EXPECT}）`);
check(big?.complete === true, "complete=true");
const flat = (big?.chunks ?? []).flatMap((c) => (c.items ?? c.entries ?? []).map((x) => String(x.path)));
check(flat.length === big?.count, `块并集 == 当天取回集合（${flat.length}/${big?.count}）`);
check(new Set(flat).size === flat.length, "块之间没有重复条目");
console.log(`     切成 ${big?.chunks?.length} 块，每块字符数 ${(big?.chunks ?? []).map((c) => c.chars).join(",")}`);

console.log("\n== ⑤ 输入校验在生产上是 4xx（不是 500）==");
const badDate = await post("/v1/search", { calendarDate: "2026-02-30", calendarTimezone: SH, limit: 5 });
check(badDate.status === 400, `calendarDate=2026-02-30 ⇒ ${badDate.status} ${badDate.body?.error?.code ?? ""}`);
const badTz = await post("/v1/search", { calendarDate: "2026-10-10", calendarTimezone: "Not/AZone", limit: 5 });
check(badTz.status === 400, `非法 timezone ⇒ ${badTz.status} ${badTz.body?.error?.code ?? ""}`);
const badResolve = await post("/v1/date/resolve", { text: "随便聊聊", now: NOW, timezone: SH });
check(badResolve.status === 422 || badResolve.status === 400, `无日期表达 ⇒ ${badResolve.status}（拒绝而不是猜）`);

console.log("\n== ⑥ 写链路仍在（ATOMICWRITE 在生产）==");
const before = evCount();
const cap = await post("/v1/conversations/capture", { principal: { agent_id: "pilot-01", role_id: "capture-ingest" }, source: "deploy13-smoke", conversation_id: `deploy13-${stamp}`, event_id: MARK, messages: [{ role: "user", content: `DEPLOY-13 smoke marker ${MARK}` }] });
check(cap.status === 200, `真捕获 ⇒ ${cap.status}`);
check(evCount() === before + 1, `证据区 +1（${before} → ${evCount()}）`);
let searchable = false;
for (let i = 0; i < 6 && !searchable; i += 1) {
  const s = await post("/v1/search", { query: MARK, limit: 5 });
  searchable = JSON.stringify(s.body ?? "").includes(MARK);
  if (!searchable) await new Promise((r) => setTimeout(r, 5000));
}
check(searchable, "刚落的那条立刻可检索（写入即记忆）");
console.log(`     ⚠️ 本次冒烟留下 1 条真实记忆（source=deploy13-smoke，标记 ${MARK}），**未自动删**，待随冒烟产物退役一并清理`);

console.log("");
if (fail) { console.log(`❌ FAIL —— ${fail} 项不通过`); process.exit(1); }
console.log("✅ PASS —— DEPLOY-13 真实入口冒烟全部通过");
