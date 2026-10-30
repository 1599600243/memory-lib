// VISIBILITY-FIX-1-REJECT4 —— 喂给模型的 persona 必须来自**服务端解析出的身份**（**红先行**）。
//
// 产品裁决（2026-10-17）：
//   ① 身份（role_id/agent_id/group_id/user_id）**只能由服务端从凭据解析**，是权限与归属的权威；
//      客户端给的同类字段只能被忽略或用于收窄，永远不能扩大可见范围。
//   ② `mode` 是**同一身份之下的内容维度（子键/标签）**，不是权限维度：可以由调用方指定，
//      但只能在"已经属于该身份"的数据里选，绝不能凭它越过身份读到别人的数据。
//   ③ persona 的权威键 = (服务端解析出的 role_id, mode)；drafts 的权威键 = (服务端解析出的 role_id)。
//   ④ **凡是喂给模型的内容，其 persona 必须来自该身份**；禁止任何路径用写死的/缺省的 persona 顶替。
//
// 病根（本文件要抓的就是它）：`src/pet.mjs` 的 `loadPersona(mode, roleId)` 调用成
//   `loadPersona(semanticMode, roleId)` → `personaStore.loadPersona(mode || roleId || "companion")`
// ⇒ **喂给模型的 persona 是按 mode 取的**（`Persona角色：companion`），
//   而 REST `/v1/pet/runtime/persona/get` 与 `/mcp pet_persona_get` 是按身份取的 —— 两条口径不一致。
//
// 本文件断言（全部看**真正喂进模型的那个 prompt**，不看 REST/MCP 的返回体）：
//   ① `/v1/pet/command` 普通对话：模型收到的 persona 必须来自身份 ok=pet（不是 mode=companion）
//   ② 宠物桥普通对话：同上
//   ③ 流式路径（桥 stream=true）：同上
//   ④ 负断言 + 正对照：另一个身份（pet-assistant）取到的是**它自己**的 persona；
//      且**任何路径**都不得把别人的 persona 喂进模型
//   ⑤ 身份缺省兜底：没有为该身份配 persona 时，**不许**拿别的身份的 persona 顶替
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createPetRuntimeStore } from "../src/pet-runtime-store.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GROUP = "home-circle";
const USER = "user-owner";
const PET = { agent: "pilot-01", role: "pet" };
const PET_ASSISTANT = { agent: "pilot-01", role: "pet-assistant" };

// 每个身份一份**可辨识**的 persona（夹具非空 ⇒ 断言有判别力）。
// ⚠️ 标记之间**不能互为子串**（否则负断言 `!text.includes(别人的标记)` 会恒真）——
//    每个标记都以 `#` 收尾，判定统一走 `hasMark`，避免子串误判。
const MARK = {
  pet: "VISFIX1R4-MARK-PET#",
  petAssistant: "VISFIX1R4-MARK-PETASSISTANT#",
  companion: "VISFIX1R4-MARK-MODE-COMPANION#",
  assistant: "VISFIX1R4-MARK-MODE-ASSISTANT#",
};
const hasMark = (text, mark) => text.includes(mark);

// 捕获**真正喂给模型**的消息（只读，不参与判定之外的逻辑）
let captured = [];
const fakeLlm = {
  async chat(messages) { captured.push(messages); return "收到（测试）。"; },
  async *chatStream(messages) { captured.push(messages); yield "收到（测试）。"; },
};

function promptOf(calls) {
  return (calls ?? []).map((messages) => (messages ?? []).map((m) => String(m?.content ?? "")).join("\n")).join("\n");
}
// 从喂给模型的 prompt 里抓 persona 标识行。
// `Persona角色：` 是 persona 的 **role_id**（= 身份），`表达方式：` 是 persona 的 tone
// —— 夹具把每个身份的 tone 写成唯一标记，所以"取到了谁的 persona"由 tone 判定。
const personaRoleLine = (text) => /Persona角色：([^\n]*)/u.exec(text)?.[1] ?? "(没有 Persona 角色行)";
const personaToneLine = (text) => /表达方式：([^\n]*)/u.exec(text)?.[1] ?? "(没有 表达方式 行)";

async function withServer(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r4-persona-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  await fs.mkdir(dataRoot, { recursive: true });
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) { role.group_id ??= GROUP; role.user_id ??= USER; }
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  // 夹具：把"身份"与"mode"两条键**都**写上可辨识内容 —— 这样"取错键"能被直接看见
  const store = createPetRuntimeStore({ dataRoot, workspaceRoot });
  await store.putPersonaConfig("pet", { name: MARK.pet, tone: MARK.pet });
  await store.putPersonaConfig("pet-assistant", { name: MARK.petAssistant, tone: MARK.petAssistant });
  await store.putPersonaConfig("companion", { name: MARK.companion, tone: MARK.companion });
  await store.putPersonaConfig("assistant", { name: MARK.assistant, tone: MARK.assistant });

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
    llm: fakeLlm,
    libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
    calendarTimezone: "Asia/Shanghai",
    petConfig: { openai: { credentialRef: auth.credentialRef, principal: { agent_id: PET.agent, role_id: PET.role } } },
  });
  try {
    captured = [];
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const rest = (id, route, body = {}) => fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: id.agent, role_id: id.role }, ...body }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const bridge = (content, extra = {}) => fetch(`${base}/v1/pet/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ["Bear" + "er", auth.authValue].join(" ") },
      body: JSON.stringify({ model: "memory-lib-pet", messages: [{ role: "user", content }], ...extra }),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const mcp = (id, name, args = {}) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": id.agent, "x-mcp-role": id.role },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      const text = body?.result?.content?.[0]?.text;
      let parsed = null; try { parsed = JSON.parse(text); } catch { /* null */ }
      return { status: r.status, isError: body?.result?.isError === true, text: String(text ?? ""), parsed };
    });
    return await fn({ rest, bridge, mcp, dataRoot, store });
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("① /v1/pet/command 普通对话：喂给模型的 persona 必须来自身份（不是 mode）", async () => {
  await withServer(async ({ rest }) => {
    const r = await rest(PET, "/v1/pet/command", { input: "记忆库是什么", mode: "companion" });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const text = promptOf(captured);
    assert.ok(text.length > 0, "必须真的调用了模型（夹具前提）");
    assert.equal(personaRoleLine(text), "pet", `模型拿到的 Persona角色 必须是身份 role_id；实际 ${JSON.stringify(personaRoleLine(text))}`);
    assert.equal(personaToneLine(text), MARK.pet, `模型必须拿到**身份 pet 的** persona 内容；实际 ${JSON.stringify(personaToneLine(text))}`);
    assert.ok(!text.includes(MARK.companion), `不许把 mode 键的 persona 喂进模型；prompt=${text.slice(0, 200)}`);
  });
});

test("①b /mcp 的 pet_command：普通对话必须能工作（200 + isError=false）且模型真的收到 prompt", async () => {
  // 这一条是 REJECT5 的回归钉：`mcp-server.mjs` 的 petCommand 曾经**既不传 principal 也不传 roleId**，
  // 于是 `loadPersona` 改成"没身份就抛"之后，这条通道从"能用"变成 403 MISSING_PRINCIPAL，
  // **模型根本没被调用** —— 修好之后必须：HTTP 200、isError=false、且假 LLM 确实收到了 prompt。
  await withServer(async ({ mcp }) => {
    const r = await mcp(PET, "pet_command", { input: "记忆库是什么", mode: "companion" });
    assert.equal(r.status, 200, `HTTP 状态必须是 200；实际 ${r.status}，body=${r.text.slice(0, 200)}`);
    assert.equal(r.isError, false, `必须是成功结果，不许是 403/MISSING_PRINCIPAL；实际 ${r.text.slice(0, 300)}`);
    const text = promptOf(captured);
    assert.ok(text.length > 0, `/mcp pet_command 的模型必须被真的调用（LLM 间谍必须收到 prompt）；实际调用次数=${captured.length}`);
    assert.equal(personaRoleLine(text), "pet", `模型拿到的 Persona角色 必须是身份；实际 ${JSON.stringify(personaRoleLine(text))}`);
    assert.equal(personaToneLine(text), MARK.pet, `模型必须拿到身份 pet 的 persona 内容；实际 ${JSON.stringify(personaToneLine(text))}`);
    assert.ok(!text.includes(MARK.companion), `不许把 mode 键的 persona 喂进模型；prompt=${text.slice(0, 200)}`);
    assert.equal(String(r.parsed?.mode ?? ""), "companion", "模式仍应是调用方请求的 companion（mode 是子维度，不许被身份顶掉）");
  });
});

test("② 宠物桥普通对话：同上（身份 pet，mode companion）", async () => {
  await withServer(async ({ bridge }) => {
    const r = await bridge("记忆库是什么", { stream: false });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const text = promptOf(captured);
    assert.ok(text.length > 0, "必须真的调用了模型（夹具前提）");
    assert.equal(personaRoleLine(text), "pet", `桥喂给模型的 Persona角色 必须是身份 role_id；实际 ${JSON.stringify(personaRoleLine(text))}`);
    assert.equal(personaToneLine(text), MARK.pet, `桥必须喂**身份 pet 的** persona 内容；实际 ${JSON.stringify(personaToneLine(text))}`);
    assert.ok(!text.includes(MARK.companion), `不许把 mode 键的 persona 喂进模型；prompt=${text.slice(0, 200)}`);
  });
});

test("③ 流式路径（桥 stream=true）：同上", async () => {
  await withServer(async ({ bridge }) => {
    const r = await bridge("记忆库是什么", { stream: true });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const text = promptOf(captured);
    assert.ok(text.length > 0, "必须真的调用了模型（夹具前提）");
    assert.equal(personaRoleLine(text), "pet", `流式路径喂给模型的 Persona角色 必须是身份 role_id；实际 ${JSON.stringify(personaRoleLine(text))}`);
    assert.equal(personaToneLine(text), MARK.pet, `流式路径必须喂**身份 pet 的** persona 内容；实际 ${JSON.stringify(personaToneLine(text))}`);
    assert.ok(!text.includes(MARK.companion), `不许把 mode 键的 persona 喂进模型；prompt=${text.slice(0, 200)}`);
  });
});

test("④ 负断言 + 正对照：另一个身份取到自己的 persona；任何路径都不得喂进别人的", async () => {
  await withServer(async ({ rest, mcp }) => {
    // 正对照：pet-assistant 用 assistant 模式，模型必须拿到**它自己**的 persona
    const r = await rest(PET_ASSISTANT, "/v1/pet/command", { input: "记忆库是什么", mode: "assistant" });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const text = promptOf(captured);
    assert.equal(personaRoleLine(text), "pet-assistant", `pet-assistant 的 Persona角色 必须是它自己的身份；实际 ${JSON.stringify(personaRoleLine(text))}`);
    assert.equal(personaToneLine(text), MARK.petAssistant, `pet-assistant 必须拿到自己的 persona 内容；实际 ${JSON.stringify(personaToneLine(text))}`);
    // 负断言：不得出现另一个身份的 persona，也不得出现 mode 键的 persona
    assert.ok(!text.includes(MARK.pet), `不许把 pet 的 persona 喂给 pet-assistant；prompt=${text.slice(0, 200)}`);
    assert.ok(!text.includes(MARK.assistant), `不许把 mode 键的 persona 喂进模型；prompt=${text.slice(0, 200)}`);

    // 读取侧（本来就对，用作交叉校验）：两个入口都必须按身份给
    const restGet = await rest(PET, "/v1/pet/runtime/persona/get", { mode: "companion" });
    assert.equal(restGet.body?.role_id, "pet");
    const mcpGet = await mcp(PET, "pet_persona_get", { mode: "companion" });
    assert.equal(mcpGet.parsed?.role_id, "pet");
  });
});

test("⑤ 没有为该身份配 persona 时，禁止拿别的身份的 persona 顶替", async () => {
  await withServer(async ({ rest, dataRoot }) => {
    // 删掉 pet 的身份 persona，只留 mode 键那份 ⇒ 正确行为是"取不到身份 persona"（回退到内置缺省），
    // 而不是"顺手把 companion.json 的内容喂进模型"。
    const personasRoot = path.join(dataRoot, "..", "personas");
    await fs.rm(path.join(personasRoot, "pet.json"), { force: true });
    const r = await rest(PET, "/v1/pet/command", { input: "记忆库是什么", mode: "companion" });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const text = promptOf(captured);
    assert.ok(text.length > 0, "必须真的调用了模型（夹具前提）");
    assert.ok(!text.includes(MARK.companion), `身份 persona 缺失时不许拿 mode 键的 persona 顶替；prompt=${text.slice(0, 200)}`);
    assert.equal(personaRoleLine(text), "pet", `缺省 persona 的角色标识必须是身份；实际 ${JSON.stringify(personaRoleLine(text))}`);
  });
});
