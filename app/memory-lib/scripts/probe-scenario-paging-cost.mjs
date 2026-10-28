#!/usr/bin/env node
// SCENARIO-2 探针：翻页耗时到底由"页数"还是"条数"决定？
//
// 为什么值得单独测：实测 105 条（1 满页 + 5 条）与 177 条（2 满页）耗时接近（1450ms vs 1663ms），
// 这不像"每次往返固定开销"，更像"每读取一条都要付一次代价"。
// 接入方要知道自己付的是什么：是网络往返，还是服务端逐条扫描。
//
// 只读：只发 /v1/date/resolve + /v1/search。
import fs from "node:fs/promises";
import { recallScenario } from "../src/scenario-recall.mjs";

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const withEquals = argv.find((item) => item.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return fallback;
}

const BASE_URL = arg("base-url", "http://127.0.0.1:8799");
const NOW = arg("now", "2026-10-15T08:00:00.000Z");
const TIMEZONE = arg("timezone", "Asia/Shanghai");
const CREDENTIAL_REF = arg("credential-ref", null);
const SECRET_FILE = arg("secret-file", null);
const secret = SECRET_FILE ? (await fs.readFile(SECRET_FILE, "utf8")).replace(/\r?\n$/u, "") : null;
const credentials = CREDENTIAL_REF && secret ? { credential_ref: CREDENTIAL_REF, secret } : {};
const principal = CREDENTIAL_REF ? { agent_id: arg("agent", "pilot-01"), role_id: arg("role", "reader") } : null;

// 先量出解析出的范围（一次即可）
const probe = await recallScenario({ text: "2026-10-07", now: NOW, timezone: TIMEZONE, baseUrl: BASE_URL, credentials, principal, pageSize: 100 });
assertOk(probe);
const { since, until } = { since: probe.range.since, until: probe.resolvedRangeUntil ?? undefined };
const untilInclusive = new Date(Date.parse(probe.range.untilExclusive) - 1).toISOString();

function assertOk(value) {
  if (value.kind !== "answer") throw new Error(`probe failed: ${JSON.stringify(value).slice(0, 200)}`);
}

// 直接数一次请求/页耗时与返回条数，用不同 pageSize 跑同一范围
const rows = [];
for (const pageSize of [10, 25, 50, 100]) {
  const url = `${BASE_URL}/v1/search`;
  const body = JSON.stringify({
    ...credentials,
    ...(principal ? { principal } : {}),
    query: "", since, until: untilInclusive, calendarTimezone: TIMEZONE, limit: pageSize,
  });
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const payload = await response.json();
  const ms = Date.now() - started;
  rows.push({ pageSize, ms, returned: payload.count ?? 0, total_count: payload.total_count ?? null, hasMore: payload.hasMore ?? null });
  // 第二页（若还有）
  if (payload.nextCursor) {
    const started2 = Date.now();
    const body2 = JSON.stringify({ ...credentials, ...(principal ? { principal } : {}), query: "", since, until: untilInclusive, calendarTimezone: TIMEZONE, limit: pageSize, cursor: payload.nextCursor });
    const response2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body2 });
    const payload2 = await response2.json();
    rows.push({ pageSize, page: 2, ms: Date.now() - started2, returned: payload2.count ?? 0, total_count: payload2.total_count ?? null, hasMore: payload2.hasMore ?? null });
  }
}

console.log(JSON.stringify({
  range: { since, untilInclusive },
  note: "同一范围、不同 limit ⇒ 看耗时是跟页数走还是跟条数走",
  rows,
}, null, 2));
