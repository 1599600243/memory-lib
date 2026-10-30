#!/usr/bin/env node
// TZ-CONFIG-1-REJECT 探针：同一实例、同一数据、同一身份，逐入口比对"省略时区"的裸日期。
//   REST  POST /v1/search
//   MCP   POST /mcp     （streamable-http，tools/call memory_search）
// 只读；不碰生产。
import fs from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:8799";
const SECRET_FILE = process.argv[3] ?? "D:\\MemoryLib\\sc2-realdata-copy\\runtime\\secrets\\memory-lib_deepseek-harness.secret";
const DAY = process.argv[4] ?? "2026-10-07";
const AGENT = "pilot-01";
const ROLE = "reader";

const secret = (await fs.readFile(SECRET_FILE, "utf8")).replace(/\r?\n$/u, "");
const authBody = { credential_ref: "memory-lib/deepseek-harness", secret, principal: { agent_id: AGENT, role_id: ROLE } };

async function post(route, body) {
  const response = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

// ---- REST：翻页取全 ----
async function restCount(extra) {
  let total = null; let cursor = null; let returned = 0; let range = null;
  for (let guard = 0; guard < 40; guard += 1) {
    const page = await post("/v1/search", { ...authBody, query: "", limit: 100, ...extra, ...(cursor ? { cursor } : {}) });
    if (page.status !== 200) return { error: page.body };
    total = page.body.total_count;
    range ??= page.body.resolvedRange;
    returned += (page.body.results ?? []).length;
    if (!page.body.nextCursor) break;
    cursor = page.body.nextCursor;
  }
  return { total, returned, complete: returned === total, range };
}

// ---- MCP over HTTP：tools/call ----
// 认证走 **X-MCP-\* 头**（localhost-server.mjs:611-614），不是请求体、也不是 tool arguments。
async function mcpCall(name, args) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mcp-credential-ref": authBody.credential_ref,
      "x-mcp-secret": authBody.secret,
      "x-mcp-agent": AGENT,
      "x-mcp-role": ROLE,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args } } }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) return { error: `HTTP ${response.status}`, body };
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== "string") return { error: "no text content", body };
  try { return { data: JSON.parse(text) }; } catch { return { error: "unparseable", text }; }
}

const out = { base: BASE, day: DAY, principal: `${AGENT}/${ROLE}` };

// ⓪ 诊断：进程外复刻 /mcp 的调用形状，确认 lib.timeline 到底用哪个时区
{
  const { createMemoryLib } = await import("../src/memory-lib.mjs");
  const path = await import("node:path");
  const dataRoot = path.join("D:\\MemoryLib\\sc2-realdata-copy", "memory");
  for (const [label, options] of [
    ["不带 calendarTimezone（旧形状）", {}],
    ["带 calendarTimezone=Asia/Shanghai（新形状）", { calendarTimezone: "Asia/Shanghai" }],
  ]) {
    const lib = createMemoryLib({ dataRoot, workspaceRoot: "D:\\MemoryLib\\sc2-realdata-copy", scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "episodic" }], agentId: AGENT, principal: { framework_id: "deepseek-harness", agent_id: AGENT, role_id: ROLE, group_id: "home-circle", user_id: "user-owner" }, vectorLane: { probe: false }, ...options });
    const page = await lib.timeline({ since: DAY, until: DAY, limit: 100 });
    out[`⓪ lib.timeline ${label}`] = { libCalendarTimezone: lib.calendarTimezone, total: page.total_count, range: page.resolvedRange };
  }
}

// ① 省略时区
out["REST /v1/search（省略时区）"] = await restCount({ since: DAY, until: DAY });
const mcpOmitted = await mcpCall("memory_search", { since: DAY, until: DAY, limit: 100 });
out["MCP /mcp memory_search（省略时区）"] = mcpOmitted.data
  ? { total: mcpOmitted.data.total_count, returned: (mcpOmitted.data.results ?? []).length, range: mcpOmitted.data.resolvedRange }
  : mcpOmitted;

// ② 显式时区
out["REST /v1/search（显式 Asia/Shanghai）"] = await restCount({ calendarDate: DAY, calendarTimezone: "Asia/Shanghai" });
const mcpExplicit = await mcpCall("memory_search", { since: DAY, until: DAY, calendarTimezone: "Asia/Shanghai", limit: 100 });
out["MCP /mcp memory_search（显式 Asia/Shanghai）"] = mcpExplicit.data
  ? { total: mcpExplicit.data.total_count, returned: (mcpExplicit.data.results ?? []).length, range: mcpExplicit.data.resolvedRange }
  : mcpExplicit;

// ③ date/resolve 省略 timezone
out["REST /v1/date/resolve（省略 timezone）"] = await (async () => {
  const r = await post("/v1/date/resolve", { ...authBody, text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z" });
  return r.status === 200 ? { timezone: r.body.timezone, range: r.body.range } : r.body;
})();
const mcpResolve = await mcpCall("memory_resolve_date", { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z" });
out["MCP /mcp memory_resolve_date（省略 timezone）"] = mcpResolve.data
  ? { timezone: mcpResolve.data.timezone, range: mcpResolve.data.range }
  : mcpResolve;

console.log(JSON.stringify(out, null, 2));
