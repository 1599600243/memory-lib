// VISIBILITY-FIX-1-REJECT2 第 2 项 —— 宠物草稿**作用域口径统一 + 双向可见**（**红先行**）。
//
// 病根（验收岗实测）：
//   `/mcp pet_drafts_list` 返回 1 条（作用域 = 认证身份的 `role_id` = "pet"），
//   而 REST `/v1/pet/runtime/drafts/list` 带 mode=companion 返回 5 条，
//   **两条通道互相看不见对方写下的草稿** —— 同一条草稿"能不能看见"取决于走哪条入口。
//
// 本单裁决的口径（写进 `src/pet-runtime-store.mjs` 注释与 `localhost-server.mjs` 路由注释）：
//   · **作用域 = 认证身份的 `role_id`**（服务端从凭证解析，**不接受调用方自报**）；
//   · **`pet_mode` 只是交互模式标签**，落盘保存，**不参与可见性判定**。
//
// 本文件断言：
//   ① 正对照：/mcp 写入的草稿，**REST 必须看得见**（证明夹具非空、判据有判别力）
//   ② 反方向：REST 写入的草稿，**/mcp 必须看得见**
//   ③ 负断言 + 正对照：同 agent 同 group 同 user、**只有 role_id 不同**的 pet-steward
//      **看不到** pet 的草稿（"看不见"只能由 role 作用域解释），而它自己的草稿自己看得见
//   ④ 模式只是标签：同一身份用不同 mode 写入的草稿**互相可见**，且落盘 `pet_mode` 记录了模式
//   ⑤ 身份绑定：调用方自报 `role_id` / `mode` **不能**改变作用域（落盘 `role_id` 仍是认证身份的 role_id）
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

// 两个身份：**同一个 agent、同一个 group、同一个 user**，唯一的差别就是 role_id。
// ⇒ 任何"看不见"都只能由 role 作用域解释，不能由 agent/group/user 轴解释（判别力最强）。
const PET = { agent: "pilot-01", role: "pet" };
const STEWARD = { agent: "pilot-01", role: "pet-steward" };
const READER_ID = { agent: "pilot-01", role: "reader" };

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1-pet-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  await fs.mkdir(dataRoot, { recursive: true });

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  // 补 group/user：让 role 成为唯一变量
  for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
    role.group_id ??= GROUP;
    role.user_id ??= USER;
  }
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  // 身份确实存在（否则 /mcp 先 403 UNKNOWN_AGENT ⇒ 响应无 result ⇒ 负断言恒真，没有判别力）
  const roleIds = registry.frameworks[0].agents.flatMap((a) => a.roles).map((r) => r.role_id);
  assert.ok(roleIds.includes(PET.role), `夹具必须真的注册 ${PET.role}`);
  assert.ok(roleIds.includes(STEWARD.role), `夹具必须真的注册 ${STEWARD.role}`);
  assert.ok(roleIds.includes(READER_ID.role), `夹具必须真的注册 ${READER_ID.role}`);
  // reader 必须**没有** pet 动作，否则 ⑤ 的"无 pet 动作必须 403"是无判别力的
  const readerRole = registry.frameworks[0].agents.flatMap((a) => a.roles).find((r) => r.role_id === READER_ID.role);
  assert.ok(!(readerRole.actions ?? []).includes("pet"), `夹具前提：${READER_ID.role} 不该有 pet 动作`);
  return { tmp, dataRoot, workspaceRoot, auth };
}

async function withServer(fn) {
  const f = await fixture();
  const server = createLocalhostServer({
    registryPath: f.auth.registryPath,
    secretStore: f.auth.secretStore,
    dataRoot: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
    auditPath: path.join(f.tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory: createServerLibFactory({ dataRoot: f.dataRoot, workspaceRoot: f.workspaceRoot, vectorLane: { probe: false } }),
    calendarTimezone: "Asia/Shanghai",
  });
  try {
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const rest = (id, route, body = {}) => fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: f.auth.credentialRef, secret: f.auth.authValue, principal: { agent_id: id.agent, role_id: id.role }, ...body }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const mcp = (id, name, args = {}) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": f.auth.credentialRef, "x-mcp-secret": f.auth.authValue, "x-mcp-agent": id.agent, "x-mcp-role": id.role },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      const text = body?.result?.content?.[0]?.text;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 保持 null */ }
      return { status: r.status, isError: body?.result?.isError === true, text: String(text ?? ""), parsed };
    });
    return await fn({ rest, mcp, dataRoot: f.dataRoot });
  } finally {
    await server.close();
    await fs.rm(f.tmp, { recursive: true, force: true });
  }
}

// /mcp 的 `pet_drafts_put` 把解析结果包在 result.data（见 pet-runtime-store.putDraft）
const mcpDraftList = (r) => (Array.isArray(r?.parsed?.drafts) ? r.parsed.drafts : null);
const contents = (drafts) => (drafts ?? []).map((d) => String(d?.content ?? ""));

test("① 正对照：/mcp 写的草稿 REST 必须看得见（同一身份、REST 用 mode=companion）", async () => {
  await withServer(async ({ rest, mcp }) => {
    const mark = "VISFIX1R2-MCP-TO-REST";
    const put = await mcp(PET, "pet_drafts_put", { content: mark, kind: "conversation", mode: "companion", session_id: "s-mcp-1" });
    assert.equal(put.isError, false, `正对照写入不该失败：${put.text.slice(0, 300)}`);
    assert.equal(put.parsed?.role_id, "pet", `落盘作用域必须是认证身份的 role_id；实际 ${JSON.stringify(put.parsed?.role_id)}`);

    const list = await rest(PET, "/v1/pet/runtime/drafts/list", { mode: "companion" });
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    const got = contents(list.body?.drafts);
    assert.ok(got.includes(mark), `REST 必须看得见 /mcp 写的草稿；实际 ${JSON.stringify(got)}`);
    assert.equal(list.body?.count, got.length, "count 必须等于 drafts 长度");
  });
});

test("② 反方向：REST 写的草稿 /mcp 必须看得见", async () => {
  await withServer(async ({ rest, mcp }) => {
    const mark = "VISFIX1R2-REST-TO-MCP";
    const put = await rest(PET, "/v1/pet/runtime/drafts/put", { content: mark, kind: "conversation", mode: "companion", session_id: "s-rest-1" });
    assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 300));
    assert.equal(put.body?.role_id, "pet", `落盘作用域必须是认证身份的 role_id；实际 ${JSON.stringify(put.body?.role_id)}`);

    const list = await mcp(PET, "pet_drafts_list", { mode: "companion", limit: 100 });
    assert.equal(list.isError, false, `/mcp 列草稿不该失败：${list.text.slice(0, 300)}`);
    const got = contents(mcpDraftList(list));
    assert.ok(got.includes(mark), `/mcp 必须看得见 REST 写的草稿；实际 ${JSON.stringify(got)}`);
  });
});

test("③ 负断言 + 正对照：pet-steward 看不到 pet 的草稿，却看得见自己的", async () => {
  await withServer(async ({ rest, mcp }) => {
    const petMark = "VISFIX1R2-OWNED-BY-PET";
    const stewardMark = "VISFIX1R2-OWNED-BY-STEWARD";
    const petPut = await mcp(PET, "pet_drafts_put", { content: petMark, mode: "companion" });
    assert.equal(petPut.isError, false, petPut.text.slice(0, 300));
    const stewardPut = await rest(STEWARD, "/v1/pet/runtime/drafts/put", { content: stewardMark, mode: "steward" });
    assert.equal(stewardPut.status, 200, JSON.stringify(stewardPut.body).slice(0, 300));

    // 正对照：steward 自己的草稿必须看得见（否则"看不到 pet 的"没有判别力）
    const stewardList = await mcp(STEWARD, "pet_drafts_list", { limit: 100 });
    assert.equal(stewardList.isError, false, stewardList.text.slice(0, 300));
    const stewardGot = contents(mcpDraftList(stewardList));
    assert.ok(stewardGot.includes(stewardMark), `pet-steward 必须看得见自己的草稿；实际 ${JSON.stringify(stewardGot)}`);

    // 负断言：pet 的草稿一条都不许出现在 pet-steward 的清单里
    assert.ok(!stewardGot.includes(petMark), `pet-steward 不该看见 pet 的草稿；实际 ${JSON.stringify(stewardGot)}`);
    const petList = await rest(PET, "/v1/pet/runtime/drafts/list", {});
    const petGot = contents(petList.body?.drafts);
    assert.ok(petGot.includes(petMark), `pet 自己的清单必须含自己的草稿；实际 ${JSON.stringify(petGot)}`);
    assert.ok(!petGot.includes(stewardMark), `pet 不该看见 pet-steward 的草稿；实际 ${JSON.stringify(petGot)}`);
  });
});

test("④ 模式只是标签：不同 mode 写入的草稿互相可见，且落盘 pet_mode 记录模式", async () => {
  // 用 pet-steward 这个身份同时写 `companion` 与 `steward` 两种模式：
  // `companion` 要求 actions 含 "pet"（有）；`steward` 要求 actions 含 "pet" + "steward"（有）。
  // ⇒ 两次写入都合法，而"能不能互相看见"只剩一个变量：mode 到底算不算作用域。
  await withServer(async ({ rest, mcp, dataRoot }) => {
    const companionMark = "VISFIX1R2-MODE-COMPANION";
    const stewardMark = "VISFIX1R2-MODE-STEWARD";
    const a = await mcp(STEWARD, "pet_drafts_put", { content: companionMark, mode: "companion" });
    const b = await rest(STEWARD, "/v1/pet/runtime/drafts/put", { content: stewardMark, mode: "steward" });
    assert.equal(a.isError, false, a.text.slice(0, 300));
    assert.equal(b.status, 200, JSON.stringify(b.body).slice(0, 300));

    // 两种 mode 的草稿都要出现在同一份清单里（如果 mode 还是作用域，这里必然少一条）
    const viaRest = await rest(STEWARD, "/v1/pet/runtime/drafts/list", { mode: "companion" });
    const gotRest = contents(viaRest.body?.drafts);
    assert.ok(gotRest.includes(companionMark) && gotRest.includes(stewardMark), `mode 不该切分可见性；实际 ${JSON.stringify(gotRest)}`);

    const viaMcp = await mcp(STEWARD, "pet_drafts_list", { mode: "assistant", limit: 100 });
    const gotMcp = contents(mcpDraftList(viaMcp));
    assert.ok(gotMcp.includes(companionMark) && gotMcp.includes(stewardMark), `mode 不该切分可见性；实际 ${JSON.stringify(gotMcp)}`);

    // 落盘证据：pet_mode 记录模式，role_id 记录作用域
    const files = await fs.readdir(path.join(dataRoot, "drafts"));
    const byContent = new Map();
    for (const name of files.filter((n) => n.endsWith(".json"))) {
      const value = JSON.parse(await fs.readFile(path.join(dataRoot, "drafts", name), "utf8"));
      byContent.set(value.content, value);
    }
    assert.equal(byContent.get(companionMark)?.pet_mode, "companion", "pet_mode 必须记录发起模式");
    assert.equal(byContent.get(stewardMark)?.pet_mode, "steward", "pet_mode 必须记录发起模式");
    assert.equal(byContent.get(stewardMark)?.role_id, "pet-steward", "role_id 必须是认证身份的作用域，不是 mode");
  });
});

test("⑤ 身份绑定：调用方自报 role_id / mode 不能改变作用域", async () => {
  await withServer(async ({ rest, mcp, dataRoot }) => {
    const mark = "VISFIX1R2-FORGED-SCOPE";
    // /mcp：工具参数里塞 role_id（schema 里有这个字段）——必须被服务端身份覆盖
    const put = await mcp(PET, "pet_drafts_put", { content: mark, role_id: "pet-steward", roleId: "pet-steward", mode: "companion" });
    assert.equal(put.isError, false, put.text.slice(0, 300));
    assert.equal(put.parsed?.role_id, "pet", `自报 role_id 不许改作用域；实际 ${JSON.stringify(put.parsed?.role_id)}`);

    // 落盘复核：草稿文件里的 role_id 必须是 "pet"（自报的 pet-steward 不得落盘）
    const files = await fs.readdir(path.join(dataRoot, "drafts"));
    const forged = [];
    for (const name of files.filter((n) => n.endsWith(".json"))) {
      const value = JSON.parse(await fs.readFile(path.join(dataRoot, "drafts", name), "utf8"));
      if (value.content === mark) forged.push(value.role_id);
    }
    assert.deepEqual(forged, ["pet"], `自报 role_id 不得落盘；实际 ${JSON.stringify(forged)}`);

    // 自报作用域的那个人**看不到**这条草稿（说明它真的落在 pet 名下）
    const stewardList = await mcp(STEWARD, "pet_drafts_list", { limit: 100 });
    assert.ok(!contents(mcpDraftList(stewardList)).includes(mark), `自报 role_id 不该把草稿写进别人的作用域；实际 ${JSON.stringify(contents(mcpDraftList(stewardList)))}`);
    // 本人看得到（正对照）
    const petList = await rest(PET, "/v1/pet/runtime/drafts/list", {});
    assert.ok(contents(petList.body?.drafts).includes(mark), `本人必须看得见自己写的草稿；实际 ${JSON.stringify(contents(petList.body?.drafts))}`);
    // 无 pet 动作的身份写草稿必须 403（不许因为自报就放行）
    const denied = await mcp(READER_ID, "pet_drafts_put", { content: mark, role_id: "pet", mode: "companion" });
    assert.equal(denied.isError, true, `reader 不该写草稿；实际 ${denied.text.slice(0, 200)}`);
    assert.match(denied.text, /FORBIDDEN|ACTION_DENIED/u, denied.text.slice(0, 200));
  });
});
