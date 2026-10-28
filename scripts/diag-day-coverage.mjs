#!/usr/bin/env node
/**
 * diag-day-coverage.mjs —— 逐文件对账：某一天"文件系统上有什么" vs "按天枚举取回了什么"
 * **只读**。用途：判断按天枚举是否漏条目（漏了就是 M2.1-A 的真缺陷）。
 *
 * 用法：node diag-day-coverage.mjs 2026-10-07
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const day = process.argv[2] ?? "2026-10-07";
const TZ = process.argv[3] ?? "Asia/Shanghai";
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };

// 本地日 → UTC 区间（本机 +08:00）
const startMs = Date.parse(`${day}T00:00:00+08:00`);
const endMs = startMs + 86400000;
const inLocalDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= startMs && t < endMs; };

const ROOT = "D:\\MemoryLib\\data\\memory";
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".md")) files.push(full);
  }
};
walk(ROOT);

const fm = (file) => {
  const head = fs.readFileSync(file, "utf8").slice(0, 4000);
  // 坑（踩过两遍）：真实库里**两套命名并存** —— camelCase（capturedAt）与 snake_case（occurred_at / updated_at）。
  // 只读 camelCase 会把 snake_case 的条目误判成"没有时间戳"。这里两套都读。
  const get = (...keys) => {
    for (const k of keys) {
      const m = new RegExp(`^\\s*"?${k}"?\\s*:\\s*"?([^"\\r\\n]+)"?\\s*$`, "mu").exec(head);
      if (m && m[1].trim() && m[1].trim() !== "null") return m[1].trim();
    }
    return null;
  };
  return {
    capturedAt: get("capturedAt", "captured_at"),
    occurredAt: get("occurredAt", "occurred_at"),
    createdAt: get("createdAt", "created_at"),
    updatedAt: get("updatedAt", "updated_at"),
    status: get("status"), type: get("type"), visibility: get("visibility"), layer: get("layer"),
  };
};
// 成员判定口径（对齐产品）：capturedAt 优先；没有 capturedAt 的老条目回退 occurred_at。
const membershipStamp = (m) => m.capturedAt ?? m.occurredAt ?? null;

const fsSet = new Map(); // path -> fm（按产品成员口径：capturedAt 优先，缺失回退 occurred_at）
const fsAll = [];
for (const f of files) {
  const m = fm(f);
  fsAll.push({ f, m });
  const t = membershipStamp(m);
  if (t && inLocalDay(t)) fsSet.set(f.toLowerCase(), { file: f, m, stamp: t, by: m.capturedAt ? "capturedAt" : "occurredAt" });
}
const byField = { capturedAt: 0, occurredAt: 0 };
for (const v of fsSet.values()) byField[v.by] += 1;

// API：翻页取全
// ⚠️ 2026-10-16 改：不再用裸 since/until —— 服务端默认时区是 UTC（server.mjs 不传 calendarTimezone），
//    裸日期会按 UTC 日解释。本地日的正确查法是 calendarDate + calendarTimezone（DAY-INTERVAL-1 的契约）。
const all = [];
let off = 0;
for (let page = 0; page < 60; page += 1) {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, calendarDate: day, calendarTimezone: TZ, limit: 100, offset: off }) });
  const b = await r.json();
  if (r.status !== 200) { console.log(`API 非 200：${r.status} ${JSON.stringify(b?.error ?? b).slice(0, 200)}`); break; }
  if (page === 0) console.log(`API resolvedRange：${JSON.stringify(b.resolvedRange)}`);
  for (const it of b.results ?? []) all.push(it);
  if (b.next_offset === null || b.next_offset === undefined) break;
  off = b.next_offset;
}
const apiSet = new Set(all.map((x) => String(x.path).toLowerCase()));

console.log(`=== ${day}（本地日 ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}）===`);
console.log(`文件系统：全部 md ${fsAll.length} 个，其中落在该本地日 ${fsSet.size} 个（capturedAt ${byField.capturedAt} 个 + 无 capturedAt 而 occurred_at 在日内 ${byField.occurredAt} 个）`);
console.log(`按天枚举：取回 ${all.length} 条`);

const missing = [...fsSet.values()].filter((v) => !apiSet.has(v.file.toLowerCase()));
const extra = all.filter((x) => !fsSet.has(String(x.path).toLowerCase()));
console.log(`\n① 文件系统有、按天枚举没取回：${missing.length} 个`);
const byReason = new Map();
for (const v of missing) {
  const k = `status=${v.m.status} type=${v.m.type} capturedAt=${v.m.capturedAt ? "有" : "无"} updatedAt=${v.m.updatedAt ? "有" : "无"} occurred=${v.m.occurredAt ? "有" : "无"} layer=${v.m.layer}`;
  byReason.set(k, (byReason.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${n} 个：${k}`);
for (const v of missing.slice(0, 5)) console.log(`   例：${v.file.replace(ROOT, "")}  capturedAt=${v.m.capturedAt} updatedAt=${v.m.updatedAt} status=${v.m.status} type=${v.m.type}`);

console.log(`\n② 按天枚举取回、但"capturedAt→occurred_at"口径不在该日：${extra.length} 个`);
// 这条曾经把我骗过两次：先把 snake_case 时间戳误判成"无时间戳"，又把 updated_at 在日内的条目当成"多出来"。
// 现在逐条给出**四个时间戳各自在不在日内**，让口径差显形，而不是猜。
for (const x of extra) {
  const rec = fsAll.find((v) => v.f.toLowerCase() === String(x.path).toLowerCase());
  const flag = (t) => (t ? (inLocalDay(t) ? "✓" : "✗") : "—");
  const m = rec?.m ?? {};
  console.log(`   ${String(x.path).replace(ROOT, "")}`);
  console.log(`      capturedAt(${m.capturedAt ?? "-"})=${flag(m.capturedAt)} occurred_at(${m.occurredAt ?? "-"})=${flag(m.occurredAt)} created_at(${m.createdAt ?? "-"})=${flag(m.createdAt)} updated_at(${m.updatedAt ?? "-"})=${flag(m.updatedAt)}`);
}

console.log(`\n③ 该日文件系统条目的 capturedAt 分布（看是不是被时区挪了）`);
const hours = new Map();
for (const v of fsSet.values()) {
  const t = Date.parse(v.m.capturedAt ?? v.m.updatedAt);
  const h = new Date(t + 8 * 3600000).toISOString().slice(11, 13);
  hours.set(h, (hours.get(h) ?? 0) + 1);
}
console.log("   本地小时直方图：" + [...hours].sort().map(([h, n]) => `${h}时:${n}`).join(" "));
