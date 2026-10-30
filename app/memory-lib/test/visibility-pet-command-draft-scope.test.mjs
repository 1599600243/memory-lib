// VISIBILITY-FIX-1-REJECT2 第 2 项（追加）—— `/v1/pet/command` 的 `/draft` 也是草稿写入通道（**红先行**）。
//
// 事实：草稿有**三条**写入通道，而不是两条：
//   · /mcp  `pet_drafts_put`        → petRuntime.draftsPut（作用域 = principal.role_id）
//   · REST  `POST /v1/pet/runtime/drafts/put`（作用域 = 认证身份的 role_id）
//   · REST  `POST /v1/pet/command` 的 `/draft <内容>` → onDraft → handlePetDraft（**上一版漏了**）
// 第三条此前走 `handlePetDraft(draft)` 且不带作用域 ⇒ 落盘 `role_id` 用 putDraft 的默认值 "companion"，
// 于是"用 `/draft` 存进草稿区"的草稿在 /mcp 与 REST 的清单里**都看不见**。
//
// 本文件断言（正对照 + 双向）：
//   ① `/draft` 写入后，/mcp 清单看得见（正对照，证明夹具非空）
//   ② `/draft` 写入后，REST 清单也看得见（同一作用域口径）
//   ③ `/draft:list` 走同一条通道，看得到 /mcp 写入的草稿（反方向）
//   ④ 落盘 `role_id` 必须是认证身份的 role_id（不是 "companion" 默认值）
//   ⑤ 相反作用的身份（只有 role_id 不同）看不到这些草稿
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
const STEWARD = { agent: "pilot-01", role: "pet-steward" };

async function withServer(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r2-petcmd-"));
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
    libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
    calendarTimezone: "Asia/Shanghai",
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
    return await fn({ rest, mcp, dataRoot });
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const contents = (drafts) => (drafts ?? []).map((d) => String(d?.content ?? ""));

test("① /v1/pet/command 的 /draft 写入必须被 /mcp 与 REST 看见，且作用域是认证身份的 role_id", async () => {
  await withServer(async ({ rest, mcp, dataRoot }) => {
    const mark = "VISFIX1R2-DRAFT-VIA-PET-COMMAND";
    const cmd = await rest(PET, "/v1/pet/command", { input: `/draft ${mark}`, mode: "companion" });
    assert.equal(cmd.status, 200, JSON.stringify(cmd.body).slice(0, 300));
    assert.match(String(cmd.body?.reply ?? ""), /已保存到草稿区/u, String(cmd.body?.reply ?? ""));

    // 正对照：/mcp 必须看得见
    const viaMcp = await mcp(PET, "pet_drafts_list", { limit: 100 });
    assert.equal(viaMcp.isError, false, viaMcp.text.slice(0, 300));
    assert.ok(contents(viaMcp.parsed?.drafts).includes(mark), `/mcp 必须看得见 /draft 写的草稿；实际 ${JSON.stringify(contents(viaMcp.parsed?.drafts))}`);

    // 同一作用域口径：REST 也必须看得见
    const viaRest = await rest(PET, "/v1/pet/runtime/drafts/list", { mode: "companion" });
    assert.ok(contents(viaRest.body?.drafts).includes(mark), `REST 必须看得见 /draft 写的草稿；实际 ${JSON.stringify(contents(viaRest.body?.drafts))}`);

    // 落盘作用域必须是认证身份的 role_id，而不是 putDraft 的默认值 "companion"
    const files = await fs.readdir(path.join(dataRoot, "drafts"));
    const owners = [];
    for (const name of files.filter((n) => n.endsWith(".json"))) {
      const value = JSON.parse(await fs.readFile(path.join(dataRoot, "drafts", name), "utf8"));
      if (value.content === mark) owners.push(value.role_id);
    }
    assert.deepEqual(owners, ["pet"], `/draft 落盘的 role_id 必须是认证身份的 role_id；实际 ${JSON.stringify(owners)}`);

    // 只有 role_id 不同的身份看不到
    const steward = await mcp(STEWARD, "pet_drafts_list", { limit: 100 });
    assert.ok(!contents(steward.parsed?.drafts).includes(mark), `pet-steward 不该看见 pet 的 /draft 草稿；实际 ${JSON.stringify(contents(steward.parsed?.drafts))}`);
  });
});

test("② /draft:list 与 /mcp 双向可见（反方向）", async () => {
  await withServer(async ({ rest, mcp }) => {
    const mark = "VISFIX1R2-DRAFT-MCP-THEN-COMMAND-LIST";
    const put = await mcp(PET, "pet_drafts_put", { content: mark, mode: "companion" });
    assert.equal(put.isError, false, put.text.slice(0, 300));
    const listed = await rest(PET, "/v1/pet/command", { input: "/draft:list", mode: "companion" });
    assert.equal(listed.status, 200, JSON.stringify(listed.body).slice(0, 300));
    assert.match(String(listed.body?.reply ?? ""), /草稿区共有 1 条/u, `/draft:list 必须看到 /mcp 写的那 1 条；实际 ${String(listed.body?.reply ?? "")}`);
  });
});
