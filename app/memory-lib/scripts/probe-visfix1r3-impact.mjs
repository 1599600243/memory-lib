// VISIBILITY-FIX-1-REJECT3 —— 「这次改动可能影响的既有行为」探针（按机制穷举，修前/修后同型对读）。
//
// 只读：起临时夹具（mkdtemp + port 0），真实入口逐条量读数；不碰生产 8787、不写 D:\MemoryLib\data。
// 每条读数都含**具体值**（状态码 / 条数 / 落盘 role_id / pet_mode），表由 probe-visfix1r3-table.mjs 生成。
//
// 用法：node scripts/probe-visfix1r3-impact.mjs <outJson>
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? null;
const PET = { agent: "pilot-01", role: "pet" };
const PET_ASSISTANT = { agent: "pilot-01", role: "pet-assistant" };
const STEWARD = { agent: "pilot-01", role: "pet-steward" };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r3-probe-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(dataRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) { role.group_id ??= "home-circle"; role.user_id ??= "user-owner"; }
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

// 夹具：给"身份键"和"mode 键"各写一份可辨识 persona（标记互不为子串），让"取错键"直接可见
const { createPetRuntimeStore: makeStore } = await import("../src/pet-runtime-store.mjs");
const seed = makeStore({ dataRoot, workspaceRoot });
await seed.putPersonaConfig("pet", { name: "PROBE-PERSONA-PET#", tone: "PROBE-PERSONA-PET#" });
await seed.putPersonaConfig("pet-assistant", { name: "PROBE-PERSONA-PETASSISTANT#", tone: "PROBE-PERSONA-PETASSISTANT#" });
await seed.putPersonaConfig("companion", { name: "PROBE-PERSONA-MODE-COMPANION#", tone: "PROBE-PERSONA-MODE-COMPANION#" });
await seed.putPersonaConfig("assistant", { name: "PROBE-PERSONA-MODE-ASSISTANT#", tone: "PROBE-PERSONA-MODE-ASSISTANT#" });

// LLM 间谍：记录真正喂给模型的消息
let llmCalls = [];
const fakeLlm = {
  async chat(messages) { llmCalls.push(messages); return "收到（探针）。"; },
  async *chatStream(messages) { llmCalls.push(messages); yield "收到（探针）。"; },
};
const resetSpy = () => { llmCalls = []; };
const fedPrompt = () => llmCalls.map((ms) => (ms ?? []).map((m) => String(m?.content ?? "")).join("\n")).join("\n");
const fedRole = () => /Persona角色：([^\n]*)/u.exec(fedPrompt())?.[1] ?? "(未喂 persona)";
const fedTone = () => /表达方式：([^\n]*)/u.exec(fedPrompt())?.[1] ?? "(未喂 persona)";
const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, llm: fakeLlm,
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
  calendarTimezone: "Asia/Shanghai",
  petConfig: { openai: { credentialRef: auth.credentialRef, principal: { agent_id: PET.agent, role_id: PET.role } } },
});
const address = await server.listen();
const BASE = `http://127.0.0.1:${address.port}`;
const rest = (id, route, body = {}) => fetch(`${BASE}${route}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: id.agent, role_id: id.role }, ...body }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mcp = (id, name, args = {}) => fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": id.agent, "x-mcp-role": id.role },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
}).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  const text = body?.result?.content?.[0]?.text;
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* null */ }
  return { status: r.status, isError: body?.result?.isError === true, text: String(text ?? ""), parsed };
});
const bridge = (content) => fetch(`${BASE}/v1/pet/openai/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: ["Bear" + "er", auth.authValue].join(" ") },
  body: JSON.stringify({ model: "memory-lib-pet", stream: false, messages: [{ role: "user", content }] }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));
const stdio = createMcpHandler(createCoreClient(BASE, { credRef: auth.credentialRef, secret: auth.authValue, agent: PET.agent, role: PET.role }));
const bridgeReply = (t) => { try { return JSON.parse(t)?.choices?.[0]?.message?.content ?? ""; } catch { return ""; } };
const contents = (list) => (list ?? []).map((d) => String(d?.content ?? ""));

const rows = [];
const row = (entry, consumer, caller, reading) => rows.push({ entry, consumer, caller, reading });

async function resetDrafts() {
  const root = path.join(dataRoot, "drafts");
  for (const name of (await fs.readdir(root).catch(() => [])).filter((n) => n.endsWith(".json"))) await fs.unlink(path.join(root, name));
}
async function landed(content) {
  const root = path.join(dataRoot, "drafts");
  for (const name of (await fs.readdir(root).catch(() => [])).filter((n) => n.endsWith(".json"))) {
    const value = JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
    if (value.content === content) return `${JSON.stringify(value.role_id)}/${JSON.stringify(value.pet_mode ?? null)}`;
  }
  return "(未落盘)";
}
async function readbacks(mark) {
  const viaMcp = await mcp(PET, "pet_drafts_list", { limit: 200 });
  const viaRest = await rest(PET, "/v1/pet/runtime/drafts/list", { limit: 200 });
  const viaCmd = await rest(PET, "/v1/pet/command", { input: "/draft:list", mode: "companion" });
  const viaStdio = await stdio.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pet_drafts_list", arguments: { limit: 200 } } });
  let stdioParsed = null; try { stdioParsed = JSON.parse(viaStdio?.result?.content?.[0]?.text ?? ""); } catch { /* null */ }
  const steward = await mcp(STEWARD, "pet_drafts_list", { limit: 200 });
  return [
    `/mcp=${contents(viaMcp.parsed?.drafts).includes(mark) ? "见" : "不见"}(${viaMcp.status},${(viaMcp.parsed?.drafts ?? []).length})`,
    `REST=${contents(viaRest.body?.drafts).includes(mark) ? "见" : "不见"}(${viaRest.status},${viaRest.body?.count})`,
    `/v1/pet/command=${/共有 [1-9]/u.test(String(viaCmd.body?.reply ?? "")) ? "见" : "不见"}(${viaCmd.status})`,
    `stdio=${contents(stdioParsed?.drafts).includes(mark) ? "见" : "不见"}`,
    `别人角色=${contents(steward.parsed?.drafts).includes(mark) ? "见(异常)" : "不见"}`,
  ].join(" ");
}

// ── 1 四条写入通道，逐条独立量（每条前先清空草稿区）────────────────────────────
{
  const cases = [
    { id: "W1", entry: "宠物草稿写入通道 1/4：/mcp pet_drafts_put", consumer: "pet-runtime-store.putDraft", caller: "/mcp pet_drafts_put", write: (mark) => mcp(PET, "pet_drafts_put", { content: mark, mode: "companion" }).then((r) => `isError=${r.isError}`) },
    { id: "W2", entry: "宠物草稿写入通道 2/4：REST /v1/pet/runtime/drafts/put", consumer: "pet-runtime-store.putDraft", caller: "POST /v1/pet/runtime/drafts/put", write: (mark) => rest(PET, "/v1/pet/runtime/drafts/put", { content: mark, mode: "companion" }).then((r) => `${r.status}`) },
    { id: "W3", entry: "宠物草稿写入通道 3/4：REST /v1/pet/command 的 /draft", consumer: "pet.handleCommand onDraft → putDraft", caller: "POST /v1/pet/command", write: (mark) => rest(PET, "/v1/pet/command", { input: `/draft ${mark}`, mode: "companion" }).then((r) => `${r.status}`) },
    { id: "W4", entry: "宠物草稿写入通道 4/4：宠物桥 /v1/pet/openai/chat/completions 的 /draft", consumer: "pet.handleCommand onDraft → putDraft", caller: "POST /v1/pet/openai/chat/completions", write: (mark) => bridge(`/draft ${mark}`).then((r) => `${r.status}`) },
  ];
  for (const c of cases) {
    await resetDrafts();
    const mark = `PROBE-${c.id}-DRAFT`;
    const wrote = await c.write(mark);
    row(c.entry, c.consumer, c.caller, `写入 ${wrote} | 落盘 role_id/pet_mode=${await landed(mark)} | ${await readbacks(mark)}`);
  }
}

// ── 2 桥的 /draft:list（修前是 500）───────────────────────────────────────────
{
  await resetDrafts();
  await mcp(PET, "pet_drafts_put", { content: "PROBE-BRIDGE-LIST-1", mode: "companion" });
  await bridge("/draft PROBE-BRIDGE-LIST-2");
  const r = await bridge("/draft:list");
  row("宠物桥 /draft:list", "pet.handleCommand onDraft → listDrafts", "POST /v1/pet/openai/chat/completions（/draft:list）",
    `桥返回 ${r.status} reply=${JSON.stringify(bridgeReply(r.text).slice(0, 30))}`);
}

// ── 3 persona 读路径（口径：按身份解析，不按模式）──────────────────────────────
{
  const a = await mcp(PET, "pet_persona_get", { mode: "companion" });
  const b = await rest(PET, "/v1/pet/runtime/persona/get", { mode: "companion" });
  const c = await rest(STEWARD, "/v1/pet/runtime/persona/get", { mode: "companion" });
  const list = await rest(PET, "/v1/pet/runtime/persona/list", { mode: "companion" });
  row("宠物 persona（读路径）", "pet-runtime-store.loadPersona/listPersonas", "/mcp pet_persona_get 与 REST /v1/pet/runtime/persona/*",
    `/mcp role_id=${JSON.stringify(a.parsed?.role_id)} | REST(pet) role_id=${JSON.stringify(b.body?.role_id)} | REST(pet-steward) role_id=${JSON.stringify(c.body?.role_id)} | REST list count=${list.body?.personas?.length}`);
}

// ── 4 模型面：**真正喂给模型的 persona 来自谁**（REJECT4 正题 + REJECT5 的 M5）────────
for (const path of [
  { id: "M1", entry: "喂给模型的路径 1/5：/v1/pet/command 普通对话", consumer: "pet.handleChat → loadPersona", caller: "POST /v1/pet/command", ident: PET, mode: "companion", run: () => rest(PET, "/v1/pet/command", { input: "记忆库是什么", mode: "companion" }) },
  { id: "M2", entry: "喂给模型的路径 2/5：宠物桥普通对话（stream=false）", consumer: "pet.handleChat → loadPersona", caller: "POST /v1/pet/openai/chat/completions", ident: PET, mode: "companion", run: () => bridge("记忆库是什么") },
  { id: "M3", entry: "喂给模型的路径 3/5：宠物桥普通对话（stream=true）", consumer: "pet.handleCommandStream → loadPersona", caller: "POST /v1/pet/openai/chat/completions", ident: PET, mode: "companion", run: () => bridge("记忆库是什么", { stream: true }) },
  { id: "M4", entry: "喂给模型的路径 4/5：另一个身份 pet-assistant 的 /v1/pet/command", consumer: "pet.handleChat → loadPersona", caller: "POST /v1/pet/command", ident: PET_ASSISTANT, mode: "assistant", run: () => rest(PET_ASSISTANT, "/v1/pet/command", { input: "记忆库是什么", mode: "assistant" }) },
  { id: "M5", entry: "喂给模型的路径 5/5：/mcp 的 pet_command 普通对话", consumer: "coreFromLib petCommand → pet.handleCommand", caller: "MCP tools/call pet_command（进程内 /mcp）", ident: PET, mode: "companion", run: () => mcp(PET, "pet_command", { input: "记忆库是什么", mode: "companion" }) },
]) {
  resetSpy();
  const r = await path.run();
  // `/mcp` 的返回是 JSON-RPC 包装：失败时 status 字段仍可能 200，用 isError 判别
  const failed = r.isError === true;
  row(path.entry, path.consumer, path.caller,
    `返回 ${failed ? `isError=true（${String(r.text ?? "").slice(0, 60)}）` : r.status} | 模型被调用=${llmCalls.length > 0 ? "是" : "否"} | 喂进模型的 Persona角色=${JSON.stringify(fedRole())} 正文=${JSON.stringify(fedTone())} | 来自该身份(${path.ident.role})=${fedRole() === path.ident.role ? "是" : "否"} | mode=${path.mode}`);
}

// ── 5 未受影响面 ─────────────────────────────────────────────────────────────
{
  const m = await mcp(PET, "memory_recall_brief", { format: "markdown", days: 7 });
  const r = await rest(PET, "/v1/recall/brief", { format: "markdown", days: 7 });
  const len = (v) => (typeof v === "string" ? v.length : null);
  row("recall_brief", "recall.recallBrief", "/mcp memory_recall_brief 与 REST /v1/recall/brief",
    `/mcp ${m.status} isError=${m.isError} brief_len=${len(m.parsed?.text)} | REST ${r.status} brief_len=${len(r.body?.text)}`);
}
{
  const m = await mcp(PET, "memory_health", {});
  const r = await fetch(`${BASE}/v1/health`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
  const hasPath = (v) => JSON.stringify(v ?? {}).includes("\"path\":");
  row("health（path-free）", "lib.health", "/mcp memory_health 与 REST GET /v1/health",
    `/mcp ${m.status} 含 path=${hasPath(m.parsed)} | REST ${r.status} 含 path=${hasPath(r.body)}`);
}
{
  const anon = await fetch(`${BASE}/v1/pet/runtime/drafts/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "companion" }) });
  const anonBody = await anon.json().catch(() => ({}));
  const anonBridge = await fetch(`${BASE}/v1/pet/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "/draft X" }] }) });
  row("身份缺失面", "identity guard / 动作门", "无凭证的 REST、/mcp 与宠物桥",
    `REST ${anon.status} code=${JSON.stringify(anonBody?.error?.code)} | 桥无凭证 ${anonBridge.status}`);
}

await server.close();
await fs.rm(tmp, { recursive: true, force: true });

if (OUT) await fs.writeFile(OUT, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(rows.map((r) => `${r.entry} :: ${r.reading}`).join("\n"));
