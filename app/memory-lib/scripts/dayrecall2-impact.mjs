#!/usr/bin/env node
// DAYRECALL-2 「受影响面」实测矩阵：把每条受本次改动影响的入口的读数打成一份 JSON，
// 供"修前 / 修后"逐项对照（报告里的受影响面清单就是它的两次输出）。
//
// 覆盖的入口 × 参数形状：
//   /v1/search        查询词，不带日期            ← 应当**逐字节不变**（本次不碰这条路）
//   /v1/search        查询词 + calendarDate       ← 本次修复点
//   /v1/search        查询词 + since/until 裸日期  ← 同为"按天"，但走 since/until 路，应不变
//   /v1/search        空 query + calendarDate     ← 枚举路，应不变
//   /mcp memory_search 查询词，不带日期            ← 应不变
//   /mcp memory_search 查询词 + calendarDate       ← 本次修复点（与 REST 同一答案）
//   /v1/recall/brief                             ← 既有消费者（不含按天参数），应不变
//
// 只读数据；实例起在 port 0；registry/secret 造在临时目录。自己 fs.writeFile 写结果
// （本沙箱不允许把 node 的 stdout 重定向到文件）。
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
const outPath = flag("--out", null);
const timezone = "Asia/Shanghai";
const QUERY = "游戏";
const DAY = "2026-10-18";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dayrecall2-impact-"));
const auth = await createTestAuth(ROOT, tmp);
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
  if (typeof text !== "string") return { error: `HTTP ${r.status}` };
  try { return { data: JSON.parse(text) }; } catch { return { error: "unparseable" }; }
}
const ids = (rows) => (rows ?? []).map((r) => path.basename(String(r.path ?? r.id ?? ""), ".md")).filter(Boolean);
const digest = (list) => ({ count: list.length, ids: list });

const out = { timezone, query: QUERY, day: DAY, measuredAt: new Date().toISOString(), surfaces: {} };

// 1) 查询词，不带日期（本次不碰）
{
  const r = await postRest("/v1/search", { query: QUERY, limit: 100, calendarTimezone: timezone });
  out.surfaces["/v1/search 查询词，无日期"] = { status: r.status, ...digest(ids(r.body.results)) };
}
// 2) 查询词 + calendarDate（修复点）
{
  const r = await postRest("/v1/search", { query: QUERY, calendarDate: DAY, limit: 100, calendarTimezone: timezone });
  out.surfaces["/v1/search 查询词+calendarDate"] = { status: r.status, resolvedRange: r.body.resolvedRange ?? null, ...digest(ids(r.body.results)) };
}
// 3) 查询词 + since/until 裸日期（同为按天，但走既有 since/until 路）
{
  const r = await postRest("/v1/search", { query: QUERY, since: DAY, until: DAY, limit: 100, calendarTimezone: timezone });
  out.surfaces["/v1/search 查询词+since/until裸日期"] = { status: r.status, resolvedRange: r.body.resolvedRange ?? null, ...digest(ids(r.body.results)) };
}
// 4) 空 query + calendarDate（枚举路）
{
  const r = await postRest("/v1/search", { query: "", calendarDate: DAY, limit: 100, calendarTimezone: timezone });
  out.surfaces["/v1/search 空query+calendarDate"] = { status: r.status, total_count: r.body.total_count, ...digest(ids(r.body.results)) };
}
// 5) MCP 查询词，不带日期
{
  const r = await callMcp("memory_search", { query: QUERY, limit: 100, calendarTimezone: timezone });
  out.surfaces["/mcp memory_search 查询词，无日期"] = r.error ? r : digest(ids(r.data.results));
}
// 6) MCP 查询词 + calendarDate（修复点）
{
  const r = await callMcp("memory_search", { query: QUERY, calendarDate: DAY, limit: 100, calendarTimezone: timezone });
  out.surfaces["/mcp memory_search 查询词+calendarDate"] = r.error ? r : { resolvedRange: r.data.resolvedRange ?? null, ...digest(ids(r.data.results)) };
}
// 7) recall_brief（既有消费者，不带按天参数）
{
  const r = await postRest("/v1/recall/brief", { days: 7, limit_chars: 600 });
  const text = typeof r.body?.brief === "string" ? r.body.brief : typeof r.body?.text === "string" ? r.body.text : JSON.stringify(r.body ?? {});
  out.surfaces["/v1/recall/brief"] = { status: r.status, chars: text.length, firstLine: text.split(/\r?\n/u)[0]?.slice(0, 120) ?? "" };
}
// 8) stdio MCP 链路（createCoreClient + createMcpHandler）
{
  const handler = createMcpHandler(createCoreClient(BASE, { credRef: auth.credentialRef, secret: auth.authValue, agent: "pilot-01", role: "reader" }));
  const both = {};
  for (const [label, args] of [["查询词，无日期", { query: QUERY, limit: 100, calendarTimezone: timezone }], ["查询词+calendarDate", { query: QUERY, calendarDate: DAY, limit: 100, calendarTimezone: timezone }]]) {
    const msg = await handler.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_search", arguments: args } });
    const text = msg?.result?.content?.[0]?.text;
    const data = typeof text === "string" ? JSON.parse(text) : {};
    both[`stdio memory_search ${label}`] = digest(ids(data.results));
  }
  Object.assign(out.surfaces, both);
}

if (outPath) await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(JSON.stringify(out, null, 2));
await server.close();
await fs.rm(tmp, { recursive: true, force: true });
