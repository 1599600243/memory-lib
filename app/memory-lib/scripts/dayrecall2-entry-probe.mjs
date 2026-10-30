#!/usr/bin/env node
// DAYRECALL-2 入口探针：同一个真实实例、同一份数据、同一身份，把**每一条按天入口**都打一遍。
//
// 覆盖：
//   ① REST POST /v1/search  空 query + calendarDate          → lib.timeline
//   ② REST POST /v1/search  有 query + calendarDate          → lib.search      ← 怀疑丢参数
//   ③ MCP  POST /mcp        memory_search 空 query            → coreFromLib → lib.timeline
//   ④ MCP  POST /mcp        memory_search 有 query            → coreFromLib → lib.search
//   ⑤ stdio MCP（createCoreClient 走 /v1/* + createMcpHandler）空/有 query
//
// 每个入口都**翻页取全**并回 total_count；有 query 的入口额外统计"返回结果里有多少条
// 其实不在这一天"（用独立 Intl 换算，不看实现自己报的字段）⇒ 直接暴露"日期被忽略"。
//
// 只读数据（data 全走读）；实例起在 port 0（随机空闲端口），registry/secret 在临时目录里造，
// 不碰生产 8787、不碰仓库 runtime/。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function flag(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }

const workspaceRoot = flag("--workspace-root", "D:\\MemoryLib\\dayrecall2-work\\data");
const dataRoot = path.join(workspaceRoot, "memory");
const timezone = flag("--timezone", "Asia/Shanghai");
const days = String(flag("--days", "2026-10-10,2026-10-18,2026-10-19")).split(",").map((d) => d.trim()).filter(Boolean);
const QUERY = flag("--query", "游戏");

// 独立时区换算（不 import 库）
const FMT = new Map();
function localDay(instantMs, zone) {
  let fmt = FMT.get(zone);
  if (!fmt) { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); FMT.set(zone, fmt); }
  const p = Object.fromEntries(fmt.formatToParts(new Date(instantMs)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// 独立读盘：给一条结果算"它到底属于哪一天"（有 calendarDate 用之，否则 capturedAt→时区）。
// 这是判定"查询路径有没有真的按天过滤"的唯一依据 —— 不看实现自己报的字段。
async function dayOfPath(filePath) {
  if (!filePath) return null;
  const text = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!text) return null;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/u)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^"|"$/gu, "");
  }
  if (fm.calendarDate) return fm.calendarDate;
  const ms = Date.parse(fm.capturedAt ?? fm.captured_at ?? "");
  return Number.isFinite(ms) ? localDay(ms, timezone) : null;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dayrecall2-probe-"));
const auth = await createTestAuth(ROOT, tmp);
// reader 角色需要带 group/user，否则 evidence 的 principal 级可见性检查会把它们全挡掉
{
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const reader = registry.frameworks[0].agents.find((a) => a.agent_id === "pilot-01").roles.find((r) => r.role_id === "reader");
  reader.group_id = "home-circle";
  reader.user_id = "user-owner";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

const server = createLocalhostServer({
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  dataRoot,
  workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  indexScheduleEnabled: false,
  vectorLane: { probe: false },
  calendarTimezone: timezone,
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot, calendarTimezone: timezone, summaryIndex: null, vectorLane: { probe: false } }),
});
const address = await server.listen();
const BASE = `http://127.0.0.1:${address.port}`;

const rest = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" } };
const mcpHeaders = { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": "reader" };

async function postRest(route, body) {
  const r = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...rest, ...body }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function callMcp(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json().catch(() => ({}));
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== "string") return { error: `HTTP ${r.status}`, body };
  try { return { data: JSON.parse(text) }; } catch { return { error: "unparseable" }; }
}

// REST 翻页
async function restPaged({ query, calendarDate, limit = 100, searchMode = undefined, rawQuota = undefined }) {
  const ids = []; let cursor = null; let total = null; let range = null; let pages = 0; let rows = [];
  for (let g = 0; g < 300; g += 1) {
    const page = await postRest("/v1/search", { query, calendarDate, calendarTimezone: timezone, limit, ...(searchMode ? { searchMode } : {}), ...(rawQuota ? { rawQuota } : {}), ...(cursor ? { cursor } : {}) });
    if (page.status !== 200) return { error: page.status, body: page.body };
    pages += 1; total = page.body.total_count; range ??= page.body.resolvedRange;
    rows.push(...(page.body.results ?? []));
    ids.push(...(page.body.results ?? []).map((i) => i.id));
    if (!page.body.nextCursor) break; cursor = page.body.nextCursor;
  }
  return { total, ids, range, pages, returned: ids.length, rows };
}

// 用独立读盘判定：这批结果里有多少条**不属于**这一天（= 日期没被真正当硬条件）。
async function offDayStats(rows, day) {
  const days = [];
  for (const row of rows) {
    if (row.path) days.push(await dayOfPath(row.path));
    else if (row.capturedAt) days.push(localDay(Date.parse(row.capturedAt), timezone));
    else days.push(null);
  }
  const off = days.filter((d) => d !== null && d !== day).length;
  const unknown = days.filter((d) => d === null).length;
  const distinct = [...new Set(days.filter(Boolean))].sort();
  return { 不在这一天: off, 日期不明: unknown, 覆盖到的日期: distinct };
}

const out = { base: BASE, dataRoot, timezone, query: QUERY, days: [] };

for (const day of days) {
  const entry = { day, paths: {} };

  // ① REST 空 query + calendarDate
  {
    const r = await restPaged({ query: "", calendarDate: day });
    entry.paths["① REST 空query+calendarDate"] = r.error ? r : { total: r.total, returned: r.returned, pages: r.pages, complete: r.returned === r.total, range: r.range };
  }
  // ② REST 有 query + calendarDate
  {
    const r = await restPaged({ query: QUERY, calendarDate: day });
    if (r.error) entry.paths["② REST 有query+calendarDate"] = r;
    else {
      entry.paths["② REST 有query+calendarDate"] = { total: r.total, returned: r.returned, pages: r.pages, complete: r.returned === r.total, range: r.range, ...await offDayStats(r.rows, day) };
    }
  }
  // ③ MCP 空 query
  {
    const ids = []; const rows = []; let total = null; let pages = 0; let range = null;
    let cursor = null;
    for (let g = 0; g < 300; g += 1) {
      const res = await callMcp("memory_search", { query: "", calendarDate: day, calendarTimezone: timezone, limit: 100, ...(cursor ? { cursor } : {}) });
      if (res.error) { ids.push(`ERR:${res.error}`); break; }
      pages += 1; total = res.data.total_count; range ??= res.data.resolvedRange;
      const pageRows = res.data.results ?? [];
      rows.push(...pageRows); ids.push(...pageRows.map((x) => x.id));
      if (!res.data.nextCursor) break; cursor = res.data.nextCursor;
    }
    entry.paths["③ MCP 空query+calendarDate"] = { total, returned: ids.length, pages, complete: ids.length === total, range, ...await offDayStats(rows, day) };
  }
  // ④ MCP 有 query
  {
    const ids = []; const rows = []; let total = null; let pages = 0; let range = null; let cursor = null;
    for (let g = 0; g < 300; g += 1) {
      const res = await callMcp("memory_search", { query: QUERY, calendarDate: day, calendarTimezone: timezone, limit: 100, ...(cursor ? { cursor } : {}) });
      if (res.error) { ids.push(`ERR:${res.error}`); break; }
      pages += 1; total = res.data.total_count; range ??= res.data.resolvedRange;
      const pageRows = res.data.results ?? [];
      rows.push(...pageRows); ids.push(...pageRows.map((x) => x.id));
      if (!res.data.nextCursor) break; cursor = res.data.nextCursor;
    }
    entry.paths["④ MCP 有query+calendarDate"] = { total, returned: ids.length, pages, complete: ids.length === total, range, ...await offDayStats(rows, day) };
  }
  // ⑥ REST 有 query + calendarDate + searchMode=evidence + rawQuota=100
  //    hybrid 把 evidence 配额写死 3 条；evidence 模式 + rawQuota 才能取全"那一天"的词面命中。
  {
    const r = await restPaged({ query: QUERY, calendarDate: day, limit: 100, searchMode: "evidence", rawQuota: 100 });
    if (r.error) entry.paths["⑥ REST 有query+evidence+rawQuota"] = r;
    else entry.paths["⑥ REST 有query+evidence+rawQuota"] = { returned: r.returned, pages: r.pages, ...await offDayStats(r.rows, day) };
  }
  out.days.push(entry);
}

// ⑤ stdio MCP 链路（进程内：createCoreClient 走 /v1/* + createMcpHandler）
{
  const stdioHandler = createMcpHandler(createCoreClient(BASE, { credRef: auth.credentialRef, secret: auth.authValue, agent: "pilot-01", role: "reader" }));
  const rows = [];
  for (const day of days) {
    for (const q of ["", QUERY]) {
      const ids = []; const pageRows = []; let total = null; let pages = 0; let cursor = null;
      for (let g = 0; g < 300; g += 1) {
        const msg = await stdioHandler.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_search", arguments: { query: q, calendarDate: day, calendarTimezone: timezone, limit: 100, ...(cursor ? { cursor } : {}) } } });
        const text = msg?.result?.content?.[0]?.text;
        if (typeof text !== "string") { ids.push("ERR"); break; }
        const data = JSON.parse(text);
        pages += 1; total = data.total_count;
        const got = data.results ?? [];
        pageRows.push(...got); ids.push(...got.map((x) => x.id));
        if (!data.nextCursor) break; cursor = data.nextCursor;
      }
      rows.push({ day, query: q === "" ? "(空)" : q, total, returned: ids.length, complete: ids.length === total, pages, ...await offDayStats(pageRows, day) });
    }
  }
  out["⑤ stdio MCP 链路"] = rows;
}

console.log(JSON.stringify(out, null, 2));
await server.close();
await fs.rm(tmp, { recursive: true, force: true });
