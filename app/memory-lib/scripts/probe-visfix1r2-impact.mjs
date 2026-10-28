// VISIBILITY-FIX-1-REJECT2 —— 「这次改动可能影响的既有行为」探针。
//
// 只读：起一个**临时夹具实例**（tmp 目录，端口 0），走真实入口打表：
//   入口（/mcp vs REST）× 身份 × 既有行为（草稿 / persona / recall_brief / health / admin）
// 每条给出**实测原值**（状态码 + 条数 + 字段），表格由本脚本自动生成。
//
// 用法：node scripts/probe-visfix1r2-impact.mjs [outJson]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? null;
const PET = { agent: "pilot-01", role: "pet" };
const STEWARD = { agent: "pilot-01", role: "pet-steward" };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r2-probe-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(dataRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
  role.group_id ??= "home-circle";
  role.user_id ??= "user-owner";
}
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

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
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
  calendarTimezone: "Asia/Shanghai",
});
const address = await server.listen();
const BASE = `http://127.0.0.1:${address.port}`;
const rest = (id, route, body = {}) => fetch(`${BASE}${route}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: id.agent, role_id: id.role }, ...body }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mcp = (id, name, args = {}) => fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": id.agent, "x-mcp-role": id.role },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
}).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  const text = body?.result?.content?.[0]?.text;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, isError: body?.result?.isError === true, text: String(text ?? ""), parsed };
});

const rows = [];
function row(entry, consumer, caller, reading) { rows.push({ entry, consumer, caller, reading }); }

// ── A. 宠物草稿：两通道 × 两身份 ────────────────────────────────────────────
{
  const peek = [];
  const mcpPut = await mcp(PET, "pet_drafts_put", { content: "PROBE-MCP-PUT", mode: "companion", session_id: "s1" });
  peek.push(`/mcp put ${mcpPut.status} isError=${mcpPut.isError} role_id=${JSON.stringify(mcpPut.parsed?.role_id)} pet_mode=${JSON.stringify(mcpPut.parsed?.pet_mode)}`);
  const restPut = await rest(PET, "/v1/pet/runtime/drafts/put", { content: "PROBE-REST-PUT", mode: "companion", session_id: "s2" });
  peek.push(`REST put ${restPut.status} role_id=${JSON.stringify(restPut.body?.role_id)} pet_mode=${JSON.stringify(restPut.body?.pet_mode)}`);
  const restList = await rest(PET, "/v1/pet/runtime/drafts/list", { mode: "companion", limit: 100 });
  const mcpList = await mcp(PET, "pet_drafts_list", { mode: "companion", limit: 100 });
  const stewardList = await mcp(STEWARD, "pet_drafts_list", { limit: 100 });
  const restMark = new Set((restList.body?.drafts ?? []).map((d) => d.content));
  const mcpMark = new Set((mcpList.parsed?.drafts ?? []).map((d) => d.content));
  const stewardMark = new Set((stewardList.parsed?.drafts ?? []).map((d) => d.content));
  peek.push(`REST list ${restList.status} count=${restList.body?.count} contents=${JSON.stringify([...restMark])}`);
  peek.push(`/mcp list ${mcpList.status} isError=${mcpList.isError} count=${(mcpList.parsed?.drafts ?? []).length} contents=${JSON.stringify([...mcpMark])}`);
  peek.push(`/mcp list(pet-steward) count=${(stewardList.parsed?.drafts ?? []).length} contents=${JSON.stringify([...stewardMark])}`);
  row("宠物草稿（put/list）", "pet-runtime-store.putDraft/listDrafts", "/mcp pet_drafts_* 与 REST /v1/pet/runtime/drafts/*", peek.join(" | "));
}

// ── A2. `/v1/pet/command` 的 `/draft`（第三条写入通道）────────────────────────
{
  const mark = "PROBE-DRAFT-VIA-PET-COMMAND";
  const cmd = await rest(PET, "/v1/pet/command", { input: `/draft ${mark}`, mode: "companion" });
  const mcpList = await mcp(PET, "pet_drafts_list", { limit: 100 });
  const cmdList = await rest(PET, "/v1/pet/command", { input: "/draft:list", mode: "companion" });
  const contents = (mcpList.parsed?.drafts ?? []).map((d) => d.content);
  const owners = [];
  for (const name of (await fs.readdir(path.join(dataRoot, "drafts"))).filter((n) => n.endsWith(".json"))) {
    const value = JSON.parse(await fs.readFile(path.join(dataRoot, "drafts", name), "utf8"));
    if (value.content === mark) owners.push(`${value.role_id}/${String(value.pet_mode)}`);
  }
  row("宠物草稿（/draft 通道）", "pet.handleCommand onDraft → pet-runtime-store.putDraft", "REST POST /v1/pet/command（/draft、/draft:list）",
    [
      `REST /draft ${cmd.status} reply=${JSON.stringify(String(cmd.body?.reply ?? "").slice(0, 40))}`,
      `/mcp list 可见=${contents.includes(mark)} 条数=${contents.length}`,
      `落盘 role_id/pet_mode=${JSON.stringify(owners)}`,
      `REST /draft:list ${cmdList.status} reply=${JSON.stringify(String(cmdList.body?.reply ?? "").slice(0, 40))}`,
    ].join(" | "));
}

// ── B. persona：两通道 ───────────────────────────────────────────────────────
{
  const g1 = await mcp(PET, "pet_persona_get", { mode: "companion" });
  const l1 = await mcp(PET, "pet_persona_list", { mode: "companion" });
  const g2 = await rest(PET, "/v1/pet/runtime/persona/get", { mode: "companion" });
  const l2 = await rest(PET, "/v1/pet/runtime/persona/list", { mode: "companion" });
  const p2 = await rest(PET, "/v1/pet/runtime/persona/put", { mode: "assistant", content: "PROBE-PERSONA" });
  row("宠物 persona（get/list/put）", "pet-runtime-store.loadPersona/listPersonas", "/mcp pet_persona_* 与 REST /v1/pet/runtime/persona/*",
    [
      `/mcp get ${g1.status} isError=${g1.isError} role_id=${JSON.stringify(g1.parsed?.role_id)}`,
      `/mcp list ${l1.status} isError=${l1.isError} count=${(l1.parsed?.personas ?? []).length}`,
      `REST get ${g2.status} role_id=${JSON.stringify(g2.body?.role_id)}`,
      `REST list ${l2.status} count=${(l2.body?.personas ?? []).length}`,
      `REST put ${p2.status} role_id=${JSON.stringify(p2.body?.role_id)}`,
    ].join(" | "));
}

// ── C. recall_brief：两通道 ──────────────────────────────────────────────────
{
  const m = await mcp(PET, "memory_recall_brief", { format: "markdown", days: 7 });
  const r = await rest(PET, "/v1/recall/brief", { format: "markdown", days: 7 });
  const lenOf = (v) => (typeof v === "string" ? v.length : null);
  row("recall_brief", "recall.recallBrief", "/mcp memory_recall_brief 与 REST /v1/recall/brief",
    [
      `/mcp ${m.status} isError=${m.isError} keys=${JSON.stringify(Object.keys(m.parsed ?? {}))} brief_len=${JSON.stringify(lenOf(m.parsed?.brief) ?? lenOf(m.parsed?.text))}`,
      `REST ${r.status} keys=${JSON.stringify(Object.keys(r.body ?? {}))} brief_len=${JSON.stringify(lenOf(r.body?.brief) ?? lenOf(r.body?.text))}`,
    ].join(" | "));
}

// ── D. health：两通道（path-free 必须保持）───────────────────────────────────
{
  const m = await mcp(PET, "memory_health", {});
  const r = await fetch(`${BASE}/v1/health`).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  const hasPath = (v) => JSON.stringify(v ?? {}).includes("\"path\":");
  row("health（path-free）", "lib.health", "/mcp memory_health 与 REST GET /v1/health",
    [
      `/mcp ${m.status} isError=${m.isError} 含 path 字段=${hasPath(m.parsed)}`,
      `REST ${r.status} 含 path 字段=${hasPath(r.body)}`,
    ].join(" | "));
}

// ── E. 默认拒绝面：无身份 / 别人身份 ─────────────────────────────────────────
{
  const anon = await fetch(`${BASE}/v1/pet/runtime/drafts/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "companion" }) });
  const anonBody = await anon.json().catch(() => ({}));
  const noScope = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pet_drafts_list", arguments: {} } }),
  });
  const noScopeBody = await noScope.json().catch(() => ({}));
  row("身份缺失面", "identity guard / 动作门", "无凭证的 REST 与 /mcp",
    [
      `REST 无凭证 ${anon.status} code=${JSON.stringify(anonBody?.error?.code)}`,
      `/mcp 无凭证 ${noScope.status} code=${JSON.stringify(noScopeBody?.error?.code)}`,
    ].join(" | "));
}

// ── F. 其它宠物命令入口（确认没有被这批改动顺手打断）────────────────────────
{
  const help = await rest(PET, "/v1/pet/command", { input: "/help", mode: "companion" });
  const clearAll = await rest(PET, "/v1/pet/command", { input: "/draft:clear all", mode: "companion" });
  const badMode = await rest(PET, "/v1/pet/command", { input: "hi", mode: "assistant" });
  const mcpDraftClear = await mcp(PET, "pet_drafts_clear", { all: true, mode: "companion" });
  row("其它宠物命令面", "pet.handleCommand / pet-runtime-store.clearDrafts", "REST /v1/pet/command 与 /mcp pet_drafts_clear",
    [
      `/help ${help.status}`,
      `/draft:clear all ${clearAll.status} reply=${JSON.stringify(String(clearAll.body?.reply ?? clearAll.body?.error?.message ?? "").slice(0, 30))}`,
      `pet 身份请求 assistant 模式 ${badMode.status} detail=${JSON.stringify(badMode.body?.error?.detail)}`,
      `/mcp pet_drafts_clear ${mcpDraftClear.status} isError=${mcpDraftClear.isError}`,
    ].join(" | "));
}

await server.close();
await fs.rm(tmp, { recursive: true, force: true });

if (OUT) await fs.writeFile(OUT, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
const md = ["| 入口 | 消费者 | 调用方 | 实测读数 |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${r.entry} | ${r.consumer} | ${r.caller} | ${r.reading.replace(/\|/gu, "\\|")} |`)].join("\n");
console.log(md);
