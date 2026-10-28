// VISIBILITY-FIX-1-REJECT3 —— 第四条写入通道：OpenAI 兼容宠物桥里的 `/draft`（**红先行**）。
//
// 病根（验收岗实测）：`POST /v1/pet/openai/chat/completions` 的 `/draft` 走
//   `bridgeDraft = (draft) => handlePetDraft({ ...draft, sessionId })`
// —— **不带作用域**，于是 `putDraft` 用默认值落盘 `role_id: "companion"`；
// 而三条读取入口（/mcp、REST /v1/pet/runtime/drafts/list、/v1/pet/command 的 /draft:list）
// 现在全部按认证身份的 `role_id`（`"pet"`）过滤 ⇒ **经这条通道写下的草稿没有任何入口能读回来**。
// 修前它是读得到的（REST 用 mode=companion 当作用域时正好命中）⇒ 本单把它从"可读回"变成了"写进去就消失"。
//
// 权威口径（与其它三条通道一致）：**作用域 = 认证身份的 role_id**；`pet_mode` 只是交互模式标签。
//
// 本文件断言：
//   ① 正对照 + 双向：经桥 `/draft` 写入的草稿，REST 与 /mcp 都必须看得见；落盘 role_id = "pet"
//   ② 反方向：经 /mcp 或 REST 写入的草稿，经桥 `/draft:list` 必须看得见
//   ③ 负断言 + 正对照：`pet-steward`（同 agent/同 group/同 user，只有 role_id 不同）
//      看不到 pet 的桥草稿，却看得见自己的桥草稿
//   ④ persona：查清桥的 persona 通道到底写什么（**不是** pet-runtime 写入通道），并钉住读路径按身份解析
//   ⑤ /mcp 的 `pet_command` 不走 onDraft（工具面不支持草稿）⇒ 必须**明确回「不可用」**且**不落盘**
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GROUP = "home-circle";
const USER = "user-owner";
const PET = { agent: "pilot-01", role: "pet" };
const PET_ASSISTANT = { agent: "pilot-01", role: "pet-assistant" };
const STEWARD = { agent: "pilot-01", role: "pet-steward" };

const fakeLlm = {
  async chat() { return "收到（测试）。"; },
  async *chatStream() { yield "收到（测试）。"; },
};

async function withServer(fn, { bridgeRole = PET.role } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r3-bridge-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  await fs.mkdir(dataRoot, { recursive: true });
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
    role.group_id ??= GROUP;
    role.user_id ??= USER;
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
    llm: fakeLlm,
    libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
    calendarTimezone: "Asia/Shanghai",
    // 宠物桥：与生产一致（server.mjs:118）——凭证引用 + **服务端配置的** principal
    petConfig: { openai: { credentialRef: auth.credentialRef, principal: { agent_id: PET.agent, role_id: bridgeRole } } },
  });
  try {
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const rest = (id, route, body = {}) => fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: id.agent, role_id: id.role }, ...body }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const mcp = (id, name, args = {}) => fetch(`${base}/mcp`, {
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
    // 宠物桥：OpenAI 兼容（Bearer 就是该 credentialRef 的 secret；身份由服务端 petConfig 绑定）
    const bridge = (content, extra = {}) => fetch(`${base}/v1/pet/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ["Bear" + "er", auth.authValue].join(" ") },
      body: JSON.stringify({ model: "memory-lib-pet", stream: false, messages: [{ role: "user", content }], ...extra }),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
    return await fn({ rest, mcp, bridge, dataRoot });
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const contents = (drafts) => (drafts ?? []).map((d) => String(d?.content ?? ""));
const bridgeReply = (text) => { try { return JSON.parse(text)?.choices?.[0]?.message?.content ?? ""; } catch { return ""; } };

async function draftRecords(dataRoot) {
  const root = path.join(dataRoot, "drafts");
  const out = [];
  for (const name of (await fs.readdir(root).catch(() => [])).filter((n) => n.endsWith(".json"))) {
    out.push(JSON.parse(await fs.readFile(path.join(root, name), "utf8")));
  }
  return out;
}

test("① 经宠物桥 /draft 写入的草稿，REST 与 /mcp 必须都能读回（落盘 role_id = 认证身份）", async () => {
  await withServer(async ({ rest, mcp, bridge, dataRoot }) => {
    const mark = "VISFIX1R3-BRIDGE-DRAFT";
    const w = await bridge(`/draft ${mark}`);
    assert.equal(w.status, 200, w.text.slice(0, 300));
    assert.match(bridgeReply(w.text), /已保存到草稿区/u, bridgeReply(w.text).slice(0, 120));

    // 正对照：REST 读得回
    const viaRest = await rest(PET, "/v1/pet/runtime/drafts/list", { mode: "companion", limit: 100 });
    assert.ok(contents(viaRest.body?.drafts).includes(mark), `REST 必须读得回桥写的草稿；实际 ${JSON.stringify(contents(viaRest.body?.drafts))}`);
    // 正对照：/mcp 读得回
    const viaMcp = await mcp(PET, "pet_drafts_list", { limit: 100 });
    assert.ok(contents(viaMcp.parsed?.drafts).includes(mark), `/mcp 必须读得回桥写的草稿；实际 ${JSON.stringify(contents(viaMcp.parsed?.drafts))}`);
    // 正对照：/v1/pet/command 的 /draft:list 也读得回
    const viaCmd = await rest(PET, "/v1/pet/command", { input: "/draft:list", mode: "companion" });
    assert.match(String(viaCmd.body?.reply ?? ""), /草稿区共有 1 条/u, String(viaCmd.body?.reply ?? ""));

    // 落盘证据：作用域是认证身份，mode 只是标签
    const mine = (await draftRecords(dataRoot)).filter((d) => d.content === mark);
    assert.equal(mine.length, 1, `桥写下的草稿必须落盘一次；实际 ${mine.length}`);
    assert.equal(mine[0].role_id, "pet", `落盘 role_id 必须是认证身份；实际 ${JSON.stringify(mine[0].role_id)}`);
    assert.equal(mine[0].pet_mode, "companion", `pet_mode 必须记录发起模式；实际 ${JSON.stringify(mine[0].pet_mode)}`);
  });
});

test("② 反方向：/mcp 与 REST 写的草稿，经宠物桥的 /draft:list 必须看得见", async () => {
  await withServer(async ({ rest, mcp, bridge }) => {
    const markMcp = "VISFIX1R3-FROM-MCP";
    const markRest = "VISFIX1R3-FROM-REST";
    assert.equal((await mcp(PET, "pet_drafts_put", { content: markMcp, mode: "companion" })).isError, false);
    // `pet` 身份只有 "pet" 动作（identity.json）⇒ 只有 companion 模式合法；
    // 两条通道都用 companion，验证的是"同一作用域下的草稿，经桥读得见"。
    assert.equal((await rest(PET, "/v1/pet/runtime/drafts/put", { content: markRest, mode: "companion" })).status, 200);

    const listed = await bridge("/draft:list");
    assert.equal(listed.status, 200, listed.text.slice(0, 300));
    assert.match(bridgeReply(listed.text), /草稿区共有 2 条/u, `桥的 /draft:list 必须看到 2 条；实际 ${bridgeReply(listed.text).slice(0, 80)}`);
  });
});

test("③ 负断言 + 正对照：pet-steward 看不到 pet 的桥草稿，却看得见自己的桥草稿", async () => {
  await withServer(async ({ mcp, bridge, dataRoot }) => {
    const petMark = "VISFIX1R3-BRIDGE-PET-ONLY";
    assert.equal((await bridge(`/draft ${petMark}`)).status, 200);

    // 正对照：pet 自己读得回（证明夹具非空、判据有判别力）
    const petList = await mcp(PET, "pet_drafts_list", { limit: 100 });
    assert.ok(contents(petList.parsed?.drafts).includes(petMark), `pet 必须读得回自己的桥草稿；实际 ${JSON.stringify(contents(petList.parsed?.drafts))}`);

    // 负断言：steward（同 agent/同 group/同 user，只有 role_id 不同）看不到
    const stewardList = await mcp(STEWARD, "pet_drafts_list", { limit: 100 });
    assert.ok(!contents(stewardList.parsed?.drafts).includes(petMark), `pet-steward 不该看见 pet 的草稿；实际 ${JSON.stringify(contents(stewardList.parsed?.drafts))}`);

    // 落盘复核：桥写的草稿只能落成 "pet"
    const owners = (await draftRecords(dataRoot)).filter((d) => d.content === petMark).map((d) => d.role_id);
    assert.deepEqual(owners, ["pet"], `桥草稿的落盘作用域；实际 ${JSON.stringify(owners)}`);
  });
});

test("④ persona：桥的 persona 通道**不是** pet-runtime 写入通道，读路径只认身份不认模式", async () => {
  // 事实（本单核实）：桥的 `bridgePersona` → `writePersonaMemory` 只写 evidence + curated-shared 候选，
  // **不**调用 `petStore.putPersonaConfig`；全仓库 `putPersonaConfig` 只有探针在用（无生产调用方）。
  // 所以 persona **不存在**"落到 mode 上"的缺陷；这里把它如实钉住，顺便证明读路径按身份解析。
  // 桥的 `onPersona` 只在 assistant/steward/governance 模式下挂着 ⇒ 桥身份取 `pet-assistant`。
  await withServer(async ({ rest, bridge, dataRoot }) => {
    const marker = `VISFIX1R3-BRIDGE-PERSONA-${Date.now()}`;
    const w = await bridge(`以后请用很短的句子回答（${marker}）`, { mode: "assistant" });
    assert.equal(w.status, 200, w.text.slice(0, 300));
    const body = JSON.parse(w.text);
    assert.equal(body?.object, "chat.completion", "桥的 persona 指令必须正常回一条 completion");
    assert.match(String(body?.choices?.[0]?.message?.content ?? ""), /已记入候选|好的/u, String(body?.choices?.[0]?.message?.content ?? ""));

    // ① 桥的 persona 指令**不**在 personas/ 落文件（写的是 curated-shared 候选）—— 如实断言，避免假前提。
    //    注意：不在这里断言"curated/shared 里没有新文件"——本测试并发跑多个用例，那是**共享**目录，
    //    这样的断言会被其它用例的写入干扰（无判别力）。
    const personasRoot = path.join(dataRoot, "..", "personas");
    const names = (await fs.readdir(personasRoot).catch(() => [])).filter((n) => n.endsWith(".json"));
    assert.deepEqual(names, [], `桥的 persona 指令不该在 personas/ 落文件；实际 ${JSON.stringify(names)}`);

    // ② 读路径（黑盒）：pet-assistant 读到的是**它自己**的内置 persona；另一个身份读到另一份
    const got = await rest(PET_ASSISTANT, "/v1/pet/runtime/persona/get", { mode: "assistant" });
    assert.equal(got.status, 200, JSON.stringify(got.body).slice(0, 200));
    assert.equal(got.body?.role_id, "pet-assistant", `REST persona get 的 role_id；实际 ${JSON.stringify(got.body?.role_id)}`);
    const other = await rest(PET, "/v1/pet/runtime/persona/get", { mode: "companion" });
    assert.equal(other.status, 200, JSON.stringify(other.body).slice(0, 200));
    assert.equal(other.body?.role_id, "pet", `另一个身份的 persona 必须仍是它自己的；实际 ${JSON.stringify(other.body?.role_id)}`);
    assert.notEqual(other.body?.name, "pet-assistant", "两个身份的 persona 不能是同一份");
  }, { bridgeRole: PET_ASSISTANT.role });
});

test("⑤ /mcp 的 pet_command 不支持草稿必须明说「不可用」且不落盘（不是静默丢弃）", async () => {
  await withServer(async ({ mcp, dataRoot }) => {
    const mark = "VISFIX1R3-MCP-COMMAND-DRAFT";
    const r = await mcp(PET, "pet_command", { input: `/draft ${mark}`, mode: "companion" });
    assert.equal(r.isError, false, r.text.slice(0, 300));
    assert.match(String(r.parsed?.reply ?? ""), /草稿区当前不可用/u, `/mcp 的 pet_command 必须明确回「不可用」；实际 ${JSON.stringify(r.parsed?.reply)}`);
    const left = (await draftRecords(dataRoot)).filter((d) => d.content === mark);
    assert.deepEqual(left, [], `不该落盘任何草稿；实际 ${JSON.stringify(left.map((d) => d.role_id))}`);
  });
});
