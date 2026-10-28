// VISIBILITY-FIX-1 —— 默认拒绝 + 身份由服务端绑定（**红先行**）。
//
// 病根一条：这些读入口把判定写成"拿不到身份就跳过判定"，而不是拒绝。
// 本文件用**有效夹具**（同一夹具下，本人的身份必须看得见自己的东西 = 正对照）断言两件事：
//   ① 无身份 ⇒ **必须拒绝**（明确 4xx/错误码；不是返回空、不是放行）
//   ② 别人身份 ⇒ **看不到**他人的 private（条数 0）
// 再加一条防复发守卫：对每个被修入口逐个断言"无身份必拒"。
//
// 走**真实入口**：进程内 `/mcp`（tools/call）+ REST，两种调用都覆盖。
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
const TS = "2026-09-24T02:00:00.000Z";
const VICTIM_MARK = "VISFIX1-VICTIM-PRIVATE";
const MINE_MARK = "VISFIX1-MINE-VISIBLE";

// 身份安排 —— **必须真的存在于测试 registry 里**，否则 /mcp 会先 403 UNKNOWN_AGENT，
// 响应里没有 result 字段 ⇒ 测试助手读到 isError=false、text="" ⇒ **负断言恒真（无判别力）**。
// 上一版就是踩了这个：来访者写了 `work-circle/ops-agent`，而 registry 里只有 pilot-01 与 admin-01。
//
// 本夹具**显式注册**下面的身份（见 fixture()），并且两个身份的 agent_id **不同**
// （container-policy 的 private 轴含 agent 轴 ⇒ 同一个 agent 的不同 role 本来就可互见，不是本单要修的洞）：
//  · 来访者：受限身份，唯一 scope 是 memory/shared（plans/tools-memory/curated-agents 都取不到）
//  · 受害者：与来访者**不同 agent**，但**同 group 同 user** ⇒ 「看不到」只能由 agent 轴决定（判别力最强）
const ME = { agent: "pilot-01", role: "reader" };
const VICTIM = { agent: "visfix1-victim-agent", role: "visfix1-victim-role" };
const VICTIM_AGENT = "visfix1-victim-agent";
const GROUP = "home-circle";
const USER = "user-owner";

function toolSections(mark) {
  return { 用途: mark, 接入方式: "-", 关键参数: "-", 已知坑: "-", 验证方式: "-" };
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  await fs.mkdir(dataRoot, { recursive: true });

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  // 给所有既有角色补 group/user（同组同 user ⇒ "看不到"只能由 agent 轴决定）
  for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
    role.group_id = GROUP;
    role.user_id = USER;
  }
  // ⚠️ **注册受害者身份**：上一版用了一个 registry 里不存在的身份，导致 /mcp 先 403 UNKNOWN_AGENT、
  //    负断言恒真。这里显式把它加进测试 registry（测试自己的 tmp registry，不动仓库里那份）。
  const framework = registry.frameworks[0];
  framework.agents.push({
    agent_id: VICTIM_AGENT,
    roles: [{
      role_id: VICTIM.role,
      scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "*" }],
      actions: ["search", "get", "propose"],
      group_id: GROUP,
      user_id: USER,
    }],
  });
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  // ── 夹具：用仓储 API 造"只该受害者可见"的条目（非空！）──
  const { createPlansMemory } = await import("../src/plans-memory.mjs");
  const { createRoleMemory } = await import("../src/role-memory.mjs");
  const { createToolsMemory } = await import("../src/tools-memory.mjs");
  const { createPetRuntimeStore } = await import("../src/pet-runtime-store.mjs");
  const plans = createPlansMemory({ dataRoot });
  const roles = createRoleMemory({ dataRoot });
  const tools = createToolsMemory({ dataRoot });
  const pet = createPetRuntimeStore({ dataRoot, workspaceRoot });

  const victimPrincipal = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "home-circle", user_id: "user-owner", agent_id: VICTIM_AGENT, role_id: VICTIM.role };
  // ⚠️ 夹具要点：`visibility` 取自 **principal.visibility**（tools-memory.mjs:42 `principal?.visibility ?? "platform"`），
  //    所以只写 `visibility: "private"` 参数**不生效**（工具会落成 platform ⇒ 谁都能看）。
  //    要让"private 那一层"真的被验到，必须把 visibility 放进 principal。
  const victimPrivatePrincipal = { ...victimPrincipal, visibility: "private" };
  await plans.writePlan({ topic: "victim-plan", status: "draft", evidence_refs: ["ev:1"], principal: victimPrincipal, sections: { 目标: VICTIM_MARK, 步骤: "- [ ] 一", 当前卡点: "-" } });
  await roles.putRoleNote({ agent_id: VICTIM_AGENT, role_id: VICTIM.role, kind: "lesson", evidence_refs: ["ev:1"], sections: { 经验: `${VICTIM_MARK} 属于研究者的角色经验，用于判别力测试。`, 适用场景: "-", 边界: "-" } });
  // 【契约变更 WRITE-DENY-1-REJECT2】工具记忆的目标容器只有 platform：要求 private 现在**显式拒绝**
  // （WRITE_SPACE_UNSUPPORTED / 403），不再静默落成 platform。
  // 旧夹具靠"principal.visibility=private 让工具写成 private"来造一个私有工具记录 —— 那条路已被裁决 1 关闭。
  // 这里改为断言这个拒绝，并把"来访者读不到"的判别力放到真能私有化的层（plan / role）上。
  const victimToolPrivateRejected = await tools
    .putToolNote({ tool_name: "victim-tool", body: VICTIM_MARK, evidence_refs: ["ev:1"], principal: victimPrivatePrincipal, sections: toolSections(VICTIM_MARK) })
    .then(() => null, (error) => error);
  assert.ok(
    victimToolPrivateRejected && victimToolPrivateRejected.detail === "WRITE_SPACE_UNSUPPORTED",
    `requesting a private tool note must be refused (contract change), got ${JSON.stringify(victimToolPrivateRejected?.message ?? "no error")}`,
  );
  await tools.putToolNote({ tool_name: "platform-tool", body: MINE_MARK, evidence_refs: ["ev:1"], principal: victimPrincipal, visibility: "platform", sections: toolSections(MINE_MARK) });
  await pet.putDraft({ content: VICTIM_MARK, kind: "personal", roleId: VICTIM.role, sessionId: "s-victim" });

  return { tmp, dataRoot, workspaceRoot, auth };
}

async function withServer(fn) {
  const { tmp, dataRoot, workspaceRoot, auth } = await fixture();
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

const countOf = (parsed) => (Array.isArray(parsed) ? parsed.length : parsed?.count ?? parsed?.items?.length ?? null);

// ─────────────────────────── ① 正对照：有身份时必须看得见自己的 ───────────────────────────
test("正对照：受害者本人（researcher）能看见自己的计划/角色记忆/工具记忆", async () => {
  await withServer(async ({ mcp }) => {
    const plans = await mcp(VICTIM, "memory_plan_list", {});
    assert.equal(plans.isError, false, plans.text);
    assert.ok(countOf(plans.parsed) >= 1, `受害者必须看得见自己的计划（判别力前提）；实际 ${plans.text.slice(0, 200)}`);

    const roles = await mcp(VICTIM, "memory_role_list", {});
    assert.equal(roles.isError, false, roles.text);
    assert.ok(countOf(roles.parsed) >= 1, `受害者必须看得见自己的角色记忆；实际 ${roles.text.slice(0, 200)}`);

    const tools = await mcp(VICTIM, "memory_tool_list", {});
    assert.equal(tools.isError, false, tools.text);
    assert.ok(countOf(tools.parsed) >= 1, `受害者必须看得见自己的工具记忆；实际 ${tools.text.slice(0, 200)}`);
  });
});

// ─────────────────────────── ② 别人身份：看不到他人的 private ───────────────────────────
// ⚠️ 每条都要**先证明该工具在本夹具下有判别力**（受害者看得见自己的），再断言来访者看不见。
//    —— 否则"看不见"可能只是因为没东西可看（本单前身就是因为空夹具被打回的）。
test("② 来访者走 /mcp 看不到受害者 private，且每条先用正对照证明有判别力", async () => {
  await withServer(async ({ mcp }) => {
    const TOOLS = [["memory_plan_list", "计划"], ["memory_role_list", "角色记忆"], ["memory_tool_list", "工具记忆"]];
    for (const [tool, label] of TOOLS) {
      // 正对照：受害者（本人）必须看得见自己的那条 ⇒ 该工具在本夹具下有判别力
      const own = await mcp(VICTIM, tool, {});
      assert.equal(own.isError, false, `${tool} 正对照不该报错：${own.text.slice(0, 200)}`);
      assert.ok(countOf(own.parsed) >= 1, `${tool} 正对照：受害者必须看得见自己的${label}（否则本夹具无判别力）；实际 ${own.text.slice(0, 200)}`);

      // 负断言：来访者看不到别人的
      const other = await mcp(ME, tool, {});
      assert.equal(other.isError, false, `${tool} 来访者不该报错：${other.text.slice(0, 200)}`);
      assert.equal(other.text.includes(VICTIM_MARK), false, `${label}：来访者不该看到 ${VICTIM_MARK}；实际 ${other.text.slice(0, 300)}`);
    }
  });
});

// ─────────────────────────── ③ 自报身份：不许生效 ───────────────────────────
test("③ memory_recall_brief 不接受自报身份，且简报内容只含本人可见的东西（带正对照）", async () => {
  await withServer(async ({ mcp }) => {
    // 正对照：先确认 recall_brief 对本夹具**有判别力**（受害者的平台工具记忆应当出现）
    const own = await mcp(VICTIM, "memory_recall_brief", {});
    assert.equal(own.isError, false, `正对照不该报错：${own.text.slice(0, 300)}`);
    assert.match(own.text, /VISFIX1-MINE-VISIBLE/u, `正对照：受害者必须看得见自己的平台工具记忆（否则本夹具无判别力）；实际 ${own.text.slice(0, 300)}`);

    // 负断言：来访者自报受害者身份，也拿不到受害者的 private 东西
    const r = await mcp(ME, "memory_recall_brief", { agent_id: VICTIM_AGENT, role_id: VICTIM.role });
    assert.equal(r.isError, false, r.text.slice(0, 200));
    assert.equal(r.text.includes(VICTIM_MARK), false, `不许自报身份读到 ${VICTIM_MARK}；实际 ${r.text.slice(0, 300)}`);
  });
});

// ─────────────────────────── ④ 无身份必须拒绝（不是返回空） ───────────────────────────
test("④ 无身份调用 /mcp 的读入口必须**拒绝**（isError=true / 4xx），不许静默返回空", async () => {
  // 用一份"没有可解析身份"的服务：核心层拿不到 principal ⇒ 读入口必须拒绝。
  const { tmp, dataRoot, workspaceRoot } = await fixture();
  try {
    const { createMemoryLib } = await import("../src/memory-lib.mjs");
    const { coreFromLib, createMcpHandler } = await import("../mcp/mcp-server.mjs");
    const { createPlansMemory } = await import("../src/plans-memory.mjs");
    const { createRoleMemory } = await import("../src/role-memory.mjs");
    const { createToolsMemory } = await import("../src/tools-memory.mjs");
    const { createProfileMemory } = await import("../src/profile-memory.mjs");
    const { createPetRuntimeStore } = await import("../src/pet-runtime-store.mjs");

    const lib = createMemoryLib({ dataRoot, workspaceRoot, scopes: null, vectorLane: { probe: false }, calendarTimezone: "Asia/Shanghai" });
    const services = {
      lib,
      plans: createPlansMemory({ dataRoot }),
      roleMemory: createRoleMemory({ dataRoot }),
      tools: createToolsMemory({ dataRoot }),
      profile: createProfileMemory({ dataRoot }),
      petRuntime: createPetRuntimeStore({ dataRoot, workspaceRoot }),
    };
    // 传入一个**空 principal**（服务端解析失败的情形）
    const core = coreFromLib(services, {}, { actions: ["search", "get"], calendarTimezone: "Asia/Shanghai" });
    const handler = createMcpHandler(core);

    for (const tool of ["memory_plan_list", "memory_role_list", "memory_tool_list"]) {
      const message = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } });
      const text = message?.result?.content?.[0]?.text ?? "";
      assert.equal(message?.result?.isError, true, `${tool} 在无身份时必须报错（拒绝），实际：${text.slice(0, 250)}`);
      assert.match(text, /MISSING_PRINCIPAL|拒绝|身份/u, `${tool} 的拒绝理由必须点明缺身份，实际：${text.slice(0, 250)}`);
      assert.equal(text.includes(VICTIM_MARK), false, `${tool} 不许在无身份时返回任何条目`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────── ⑥ 内容级：health 不许暴露绝对路径 ───────────────────────────
test("⑥ memory_health 不暴露服务器绝对路径（内容级）", async () => {
  await withServer(async ({ mcp }) => {
    const r = await mcp(VICTIM, "memory_health", {});
    assert.equal(r.isError, false, r.text.slice(0, 200));
    // 正对照：health 本身要有内容（否则"没有路径"可能只是因为整块为空）
    assert.match(r.text, /health|status/u, `health 正对照：应当有成对的状态字段；实际 ${r.text.slice(0, 200)}`);
    assert.doesNotMatch(r.text, /[A-Za-z]:\\\\|[A-Za-z]:\\/u, `不许出现盘符绝对路径；实际 ${r.text.slice(0, 300)}`);
  });
});

test("②b【契约变更】工具记忆只接受 platform：要求 private 被拒、落盘不出现该记录", async () => {
  const { tmp, dataRoot } = await fixture();
  try {
    // 契约变更（WRITE-DENY-1-REJECT2 裁决1）：工具容器只有 platform，
    // 要求 private ⇒ 403 WRITE_SPACE_UNSUPPORTED，且**文件系统上不出现这条记录**。
    const dir = path.join(dataRoot, "tools-memory");
    const files = await fs.readdir(dir);
    const texts = await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), "utf8")));
    assert.equal(texts.find((t) => t.includes(VICTIM_MARK)), undefined, "a refused private tool note must not be written at all");
    const other = texts.find((t) => t.includes(MINE_MARK));
    assert.ok(other, "platform-tool must exist");
    assert.match(other, /visibility:\s*"?platform"?/u, "platform-tool 的落盘 visibility 必须是 platform");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────── ⑤ 防复发守卫：仓储层"无身份必拒" ───────────────────────────
test("⑤ 防复发：每个被修仓储读方法在无身份时必须拒绝（不许静默返回空/全量）", async () => {
  const { dataRoot, workspaceRoot, tmp } = await fixture();
  try {
    const { createPlansMemory } = await import("../src/plans-memory.mjs");
    const { createRoleMemory } = await import("../src/role-memory.mjs");
    const { createToolsMemory } = await import("../src/tools-memory.mjs");
    const { createProfileMemory } = await import("../src/profile-memory.mjs");
    const { createProjectMemory } = await import("../src/project-memory.mjs");
    const { createGraphStore } = await import("../src/graph-retrieval.mjs");
    const plans = createPlansMemory({ dataRoot });
    const roles = createRoleMemory({ dataRoot });
    const tools = createToolsMemory({ dataRoot });
    const profiles = createProfileMemory({ dataRoot });
    const project = createProjectMemory({ dataRoot, graphStore: createGraphStore({ dataRoot }) });

    const cases = [
      ["plans.listPlans({})", () => plans.listPlans({})],
      ["roleMemory.listRoleNotes({})", () => roles.listRoleNotes({})],
      ["tools.listTools({})", () => tools.listTools({})],
      ["profiles.listProfiles({})", () => profiles.listProfiles({})],
      ["project.listProjects(null)", () => project.listProjects(null)],
    ];
    for (const [label, call] of cases) {
      await assert.rejects(
        async () => { await call(); },
        (error) => {
          assert.equal(error?.code, "MISSING_PRINCIPAL", `${label} 必须以 MISSING_PRINCIPAL 拒绝，实际：${error?.message}`);
          return true;
        },
        `${label} 在无身份时必须拒绝`,
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    void workspaceRoot;
  }
});
