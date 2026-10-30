#!/usr/bin/env node
// TZ-CONFIG-1 证据：部署默认时区配置前后，**同一个裸日期**的条数。
// 对同一个本机实例发两次 /v1/search：
//   ① 裸 since/until（不给 calendarTimezone）⇒ 走部署默认
//   ② 显式 calendarDate + calendarTimezone=Asia/Shanghai ⇒ 走显式
// 二者必须一致；再对比显式 UTC 的结果，展示"省略时区"的后果有多大。
import fs from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:8799";
const SECRET_FILE = process.argv[3] ?? "D:\\MemoryLib\\sc2-realdata-copy\\runtime\\secrets\\memory-lib_deepseek-harness.secret";
const DAY = process.argv[4] ?? "2026-10-07";

const secret = (await fs.readFile(SECRET_FILE, "utf8")).replace(/\r?\n$/u, "");
const authBody = { credential_ref: "memory-lib/deepseek-harness", secret, principal: { agent_id: "pilot-01", role_id: "reader" } };

async function post(route, body) {
  const response = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody, ...body }) });
  return { status: response.status, body: await response.json() };
}

async function countAll(extra) {
  let total = null; let cursor = null; let returned = 0; let range = null;
  for (let guard = 0; guard < 40; guard += 1) {
    const page = await post("/v1/search", { query: "", limit: 100, ...extra, ...(cursor ? { cursor } : {}) });
    if (page.status !== 200) return { error: page.body, range };
    total = page.body.total_count;
    range ??= page.body.resolvedRange;
    returned += (page.body.results ?? []).length;
    if (!page.body.nextCursor) break;
    cursor = page.body.nextCursor;
  }
  return { total, returned, complete: returned === total, range };
}

const out = { day: DAY, base: BASE };
out["① 裸 since/until（走部署默认）"] = await countAll({ since: DAY, until: DAY });
out["② 显式 calendarDate + Asia/Shanghai"] = await countAll({ calendarDate: DAY, calendarTimezone: "Asia/Shanghai" });
out["③ 显式 calendarDate + UTC（对照）"] = await countAll({ calendarDate: DAY, calendarTimezone: "UTC" });
out["结论"] = out["① 裸 since/until（走部署默认）"].total === out["② 显式 calendarDate + Asia/Shanghai"].total
  ? "裸查询与显式部署时区一致 ✅"
  : "裸查询与显式部署时区**不一致** ❌";
console.log(JSON.stringify(out, null, 2));
