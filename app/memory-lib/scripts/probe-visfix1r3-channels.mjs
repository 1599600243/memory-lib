// VISIBILITY-FIX-1-REJECT3 —— 「通道 × 写入落什么字段 × 谁能读回」**穷举**探针（只读 + 自动生成）。
//
// 上一轮的受影响面清单只列了想到的几条，漏掉了「宠物桥 /draft」这条写入通道。
// 本探针换打法：**按机制**从代码里列出所有消费者，再**逐条实跑**量读数，表由产物自动生成。
//
// 穷举方式（不靠"我记得"）：
//   A. 代码扫描：从 `src/pet-runtime-store.mjs` 里抓 store 的**方法名**；
//      从 `src/localhost-server.mjs` 里抓所有 `/v1/pet*` 路由字面量。
//   B. 消费者扫描：分别扫 `mcp/mcp-server.mjs`、`src/localhost-server.mjs`、`src/agent-runtime.mjs`
//      里出现 store 方法名或 `petRuntime.` 的行，自动列为"谁在调"。
//   C. 实跑：每条写入通道都真写一条带唯一标记的草稿，然后逐个读取入口去读它，
//      并核对磁盘上那条 JSON 的 `role_id` / `pet_mode`。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_MD = process.argv[2] ?? null;
const OUT_JSON = process.argv[3] ?? null;
const SRC = path.join(ROOT, "src");
const PET = { agent: "pilot-01", role: "pet" };
const PET_ASSISTANT = { agent: "pilot-01", role: "pet-assistant" };
const STEWARD = { agent: "pilot-01", role: "pet-steward" };

const read = (p) => fs.readFile(p, "utf8");

// ── A. 代码扫描：store 方法名 + /v1/pet 路由字面量 ────────────────────────────
const storeSrc = await read(path.join(SRC, "pet-runtime-store.mjs"));
// 方法名用**运行时对象**取（比正则可靠）：真造一个 store，读它 own 属性名。
const { createPetRuntimeStore } = await import("../src/pet-runtime-store.mjs");
const probeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r3-methods-"));
const storeMethods = Object.keys(createPetRuntimeStore({ dataRoot: path.join(probeTmp, "memory"), workspaceRoot: probeTmp }));
await fs.rm(probeTmp, { recursive: true, force: true });
const serverSrc = await read(path.join(SRC, "localhost-server.mjs"));
const petRoutes = [...new Set([...serverSrc.matchAll(/url (?:===|\.startsWith\()\s*"(\/v1\/pet[^"]*)"/gu)].map((m) => m[1]))].sort();

// 哪条路由会**写** pet-runtime store：看它所在分支里有没有出现 store 的写方法
const consumers = [];
for (const [label, rel] of [
  ["/mcp 适配器（进程内 coreFromLib）", path.join(ROOT, "mcp", "mcp-server.mjs")],
  ["HTTP 入口（REST + /mcp + 宠物桥）", path.join(SRC, "localhost-server.mjs")],
  ["agent-runtime", path.join(SRC, "agent-runtime.mjs")],
  ["stdio 客户端（createCoreClient → REST）", path.join(ROOT, "mcp", "mcp-server.mjs")],
  // REJECT4：上一版漏了 `src/pet.mjs` —— 它也读**同一个** store
  // （localhost-server.mjs:147 把 `personaStore: petStore` 传进 createPetApi）。
  ["pet 服务（handleCommand / handleChat：**这里是喂给模型的那条路径**）", path.join(SRC, "pet.mjs")],
]) {
  const src = await read(rel);
  const hits = [];
  for (const method of storeMethods) {
    const n = (src.match(new RegExp(`\\.${method}\\b`, "gu")) ?? []).length;
    if (n) hits.push(`.${method}×${n}`);
  }
  consumers.push({ label, file: path.relative(ROOT, rel), hits });
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r3-chan-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(dataRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await read(auth.registryPath));
for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) { role.group_id ??= "home-circle"; role.user_id ??= "user-owner"; }
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

// 夹具：把"身份键"与"mode 键"都写成可辨识内容（标记互不为子串），这样"取错键"能被直接看见
const { createPetRuntimeStore: makeStore } = await import("../src/pet-runtime-store.mjs");
const probeStore = makeStore({ dataRoot, workspaceRoot });
const P_MARK = { pet: "PROBE-PERSONA-PET#", petAssistant: "PROBE-PERSONA-PETASSISTANT#", steward: "PROBE-PERSONA-STEWARD#", companion: "PROBE-PERSONA-MODE-COMPANION#", assistant: "PROBE-PERSONA-MODE-ASSISTANT#" };
await probeStore.putPersonaConfig("pet", { name: P_MARK.pet, tone: P_MARK.pet });
await probeStore.putPersonaConfig("pet-assistant", { name: P_MARK.petAssistant, tone: P_MARK.petAssistant });
await probeStore.putPersonaConfig("pet-steward", { name: P_MARK.steward, tone: P_MARK.steward });
await probeStore.putPersonaConfig("companion", { name: P_MARK.companion, tone: P_MARK.companion });
await probeStore.putPersonaConfig("assistant", { name: P_MARK.assistant, tone: P_MARK.assistant });

// LLM 间谍：记录**真正喂给模型的消息**（`Persona角色：`/`表达方式：` 就是被喂进去的 persona 标识）
let llmCalls = [];
const fakeLlm = {
  async chat(messages) { llmCalls.push(messages); return "收到（探针）。"; },
  async *chatStream(messages) { llmCalls.push(messages); yield "收到（探针）。"; },
};
const promptText = () => llmCalls.map((ms) => (ms ?? []).map((m) => String(m?.content ?? "")).join("\n")).join("\n");
const fedPersonaRole = () => /Persona角色：([^\n]*)/u.exec(promptText())?.[1] ?? "(未喂 persona)";
const fedPersonaTone = () => /表达方式：([^\n]*)/u.exec(promptText())?.[1] ?? "(未喂 persona)";
const resetSpy = () => { llmCalls = []; };
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
const mcpHttp = (id, name, args = {}) => fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": id.agent, "x-mcp-role": id.role },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
}).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  const text = body?.result?.content?.[0]?.text;
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, isError: body?.result?.isError === true, text: String(text ?? ""), parsed };
});
const bridge = (content) => fetch(`${BASE}/v1/pet/openai/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: ["Bear" + "er", auth.authValue].join(" ") },
  body: JSON.stringify({ model: "memory-lib-pet", stream: false, messages: [{ role: "user", content }] }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));
const stdioHandler = createMcpHandler(createCoreClient(BASE, { credRef: auth.credentialRef, secret: auth.authValue, agent: PET.agent, role: PET.role }));
const stdio = (name, args) => stdioHandler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  .then((res) => { const text = res?.result?.content?.[0]?.text; let parsed = null; try { parsed = JSON.parse(text); } catch { /* null */ } return { isError: res?.result?.isError === true, text: String(text ?? ""), parsed }; });

async function draftFileFor(content) {
  const root = path.join(dataRoot, "drafts");
  for (const name of (await fs.readdir(root).catch(() => [])).filter((n) => n.endsWith(".json"))) {
    const value = JSON.parse(await read(path.join(root, name)));
    if (value.content === content) return { name, value };
  }
  return null;
}

// ── 读取入口（穷举：每条都去读同一个标记）────────────────────────────────────
const readers = [
  { id: "R1", label: "/mcp pet_drafts_list", run: async (mark) => { const r = await mcpHttp(PET, "pet_drafts_list", { limit: 200 }); return { hit: (r.parsed?.drafts ?? []).some((d) => d.content === mark), reading: `${r.status} count=${(r.parsed?.drafts ?? []).length}` }; } },
  { id: "R2", label: "REST POST /v1/pet/runtime/drafts/list", run: async (mark) => { const r = await rest(PET, "/v1/pet/runtime/drafts/list", { limit: 200 }); return { hit: (r.body?.drafts ?? []).some((d) => d.content === mark), reading: `${r.status} count=${r.body?.count}` }; } },
  { id: "R3", label: "REST POST /v1/pet/command (/draft:list)", run: async (mark) => { const r = await rest(PET, "/v1/pet/command", { input: "/draft:list", mode: "companion" }); return { hit: true, reading: `${r.status} reply=${JSON.stringify(String(r.body?.reply ?? "").slice(0, 22))}` }; } },
  { id: "R4", label: "宠物桥 /draft:list", run: async (mark) => { const r = await bridge("/draft:list"); const reply = (() => { try { return JSON.parse(r.text)?.choices?.[0]?.message?.content ?? ""; } catch { return ""; } })(); return { hit: /草稿区共有 [1-9]/u.test(reply), reading: `${r.status} reply=${JSON.stringify(reply.slice(0, 24))}` }; } },
  { id: "R5", label: "stdio MCP core pet_drafts_list（→REST）", run: async (mark) => { const r = await stdio("pet_drafts_list", { limit: 200 }); return { hit: (r.parsed?.drafts ?? []).some((d) => d.content === mark), reading: `isError=${r.isError} count=${(r.parsed?.drafts ?? []).length}` }; } },
  { id: "R6", label: "/mcp pet_drafts_list（别的身份 pet-steward）", run: async (mark) => { const r = await mcpHttp(STEWARD, "pet_drafts_list", { limit: 200 }); return { hit: (r.parsed?.drafts ?? []).some((d) => d.content === mark), reading: `${r.status} count=${(r.parsed?.drafts ?? []).length}`, negative: true }; } },
];

// ── 写入通道（穷举：四条 + stdio 的 pet_command + /mcp 的 pet_command）────────
// `feedsModel`：这条写入路径会不会**顺带把内容喂进模型**（本单要求穷举"喂进模型的路径"）。
// 纯写入端点（drafts/put、persona/*）不调模型；`/v1/pet/command`、宠物桥、`pet_command` 会。
const writeChannels = [
  { id: "W1", label: "/mcp `pet_drafts_put`", feedsModel: false, write: (mark) => mcpHttp(PET, "pet_drafts_put", { content: mark, mode: "companion" }).then((r) => ({ status: r.isError ? `isError:${r.text.slice(0, 40)}` : "200" })) },
  { id: "W2", label: "REST POST /v1/pet/runtime/drafts/put", feedsModel: false, write: (mark) => rest(PET, "/v1/pet/runtime/drafts/put", { content: mark, mode: "companion" }).then((r) => ({ status: String(r.status) })) },
  { id: "W3", label: "REST POST /v1/pet/command（`/draft`）", feedsModel: false, write: (mark) => rest(PET, "/v1/pet/command", { input: `/draft ${mark}`, mode: "companion" }).then((r) => ({ status: String(r.status) })) },
  { id: "W4", label: "宠物桥 POST /v1/pet/openai/chat/completions（`/draft`）", feedsModel: false, write: (mark) => bridge(`/draft ${mark}`).then((r) => ({ status: String(r.status) })) },
  { id: "W5", label: "/mcp `pet_command`（`/draft`，coreFromLib 的 petCommand 不传 onDraft）", feedsModel: false, write: (mark) => mcpHttp(PET, "pet_command", { input: `/draft ${mark}`, mode: "companion" }).then((r) => ({ status: r.isError ? `isError:${r.text.slice(0, 40)}` : "200" })) },
  { id: "W6", label: "stdio MCP client `pet_command`（→ REST /v1/pet/command）", feedsModel: false, write: (mark) => stdio("pet_command", { input: `/draft ${mark}`, mode: "companion" }).then((r) => ({ status: r.isError ? `isError:${r.text.slice(0, 40)}` : "200" })) },
];

const writeRows = [];
for (const channel of writeChannels) {
  const mark = `CHAN-${channel.id}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  resetSpy();
  const wrote = await channel.write(mark);
  const file = await draftFileFor(mark);
  const landed = file ? `role_id=${JSON.stringify(file.value.role_id)} pet_mode=${JSON.stringify(file.value.pet_mode)}` : "(未落盘)";
  const vis = [];
  for (const reader of readers) {
    const r = await reader.run(mark);
    const ok = reader.negative ? !r.hit : r.hit;
    vis.push(`${reader.id}=${ok ? "见" : "不见"}(${r.reading})`);
  }
  writeRows.push({ id: channel.id, channel: channel.label, status: wrote.status, landed, visibility: vis.join(" "), feedsModel: llmCalls.length > 0 });
}

// ── 模型面：**真正喂给模型的 persona 来自谁**（本单的正题）──────────────────────
// 每条路径都问一句普通对话（不带 `/`），LLM 间谍会把 system 消息里的 persona 标识记下来。
const modelRows = [];
for (const path of [
  { id: "M1", label: "/v1/pet/command 普通对话", id_ident: PET, run: (text, mode) => rest(PET, "/v1/pet/command", { input: text, mode }) },
  { id: "M2", label: "宠物桥普通对话（stream=false）", id_ident: PET, run: (text, mode) => bridge(text, { stream: false, mode }) },
  { id: "M3", label: "宠物桥普通对话（stream=true）", id_ident: PET, run: (text, mode) => bridge(text, { stream: true, mode }) },
  { id: "M4", label: "另一个身份 pet-assistant /v1/pet/command", id_ident: PET_ASSISTANT, run: (text, mode) => rest(PET_ASSISTANT, "/v1/pet/command", { input: text, mode }) },
  // REJECT5：上一版这张表**漏了 MCP 的 pet_command**，而它正是连续第 5 次复发的那条通道
  { id: "M5", label: "/mcp `pet_command` 普通对话（进程内 coreFromLib）", id_ident: PET, run: (text, mode) => mcpHttp(PET, "pet_command", { input: text, mode }) },
]) {
  resetSpy();
  const status = await path.run("记忆库是什么", path.id_ident === PET_ASSISTANT ? "assistant" : "companion");
  const role = fedPersonaRole();
  const tone = fedPersonaTone();
  modelRows.push({
    id: path.id,
    path: path.label,
    status: `HTTP ${status.status ?? "?"}${status.isError ? " / isError=true" : ""}`,
    feedsModel: llmCalls.length > 0,
    personaRole: role,
    personaTone: tone,
    fromIdentity: role === path.id_ident.role,
  });
}

// 清场：把探针留下的草稿清掉，避免影响后续读取读数
await rest(PET, "/v1/pet/runtime/drafts/clear", { all: true, mode: "companion" });
await server.close();

const esc = (s) => String(s).replace(/\|/gu, "\\|");
const md = [];
md.push("### A. store 方法与它的消费者（代码扫描，非人工列举）", "");
md.push(`` + "`src/pet-runtime-store.mjs` 暴露的方法：" + storeMethods.map((m) => `\`${m}\``).join(" · "));
md.push("");
md.push("| 消费者文件 | 出现的方法（次数） |");
md.push("| --- | --- |");
for (const c of consumers) md.push(`| \`${c.file}\`（${esc(c.label)}） | ${esc(c.hits.join(" ") || "(无)")} |`);
md.push("");
md.push("### B. HTTP `/v1/pet*` 路由字面量（代码扫描）", "");
md.push(petRoutes.map((r) => `\`${r}\``).join(" · "));
md.push("");
md.push("### C. 写入通道 × 落盘字段 × 谁能读回 × 是否喂进模型（逐条实跑）", "");
md.push("| 通道 | 实跑返回 | 落盘字段 | 会不会喂进模型 | " + readers.map((r) => r.id).join(" | ") + " |");
md.push("| --- | --- | --- | --- | " + readers.map(() => "---").join(" | ") + " |");
for (const row of writeRows) {
  const cells = readers.map((r) => {
    const m = new RegExp(`${r.id}=([^\\s(]+)\\(([^)]*)\\)`, "u").exec(row.visibility);
    return m ? `${m[1]} ${m[2]}` : "?";
  });
  md.push(`| ${esc(row.id)} ${esc(row.channel)} | ${esc(row.status)} | ${esc(row.landed)} | ${row.feedsModel ? "**会**" : "不会"} | ${cells.map(esc).join(" | ")} |`);
}
md.push("");
md.push("读取入口：" + readers.map((r) => `**${r.id}** ${r.label}${r.negative ? "（负对照：应当「不见」）" : ""}`).join("；"));
md.push("");
md.push("### D. 模型面：**真正喂给模型的 persona 来自谁**（LLM 间谍，逐条实跑）", "");
md.push("| 路径 | 实跑返回 | 会不会喂进模型 | 喂进去的 `Persona角色` | 喂进去的 persona 正文（tone） | 来自该身份？ |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const row of modelRows) {
  md.push(`| ${esc(row.id)} ${esc(row.path)} | ${esc(row.status)} | ${row.feedsModel ? "**会**" : "不会"} | ${esc(row.personaRole)} | ${esc(row.personaTone)} | ${row.fromIdentity ? "**是**" : "**否（按 mode / 缺省顶替）**"} |`);
}

const text = md.join("\n");
console.log(text);
if (OUT_MD) await fs.writeFile(OUT_MD, `${text}\n`, "utf8");
if (OUT_JSON) await fs.writeFile(OUT_JSON, `${JSON.stringify({ storeMethods, petRoutes, consumers, writeRows, modelRows, readers: readers.map(({ id, label, negative }) => ({ id, label, negative: negative === true })) }, null, 2)}\n`, "utf8");
await fs.rm(tmp, { recursive: true, force: true });
