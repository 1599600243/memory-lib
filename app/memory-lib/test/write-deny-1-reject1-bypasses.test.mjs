// WRITE-DENY-1-REJECT1 —— 五条写授权旁路的回归断言（F1..F5）。
//
// 纪律（沿用本仓既有口径）：
//   · 每条"拒绝"都配同夹具的**正对照**（该能写的必须写得进）；
//   · 拒绝时必须断言**零写入**（文件清单/内容/mtime 不变），否则"403 了但已经落盘"查不出来；
//   · 断言打具体值（状态码、错误 detail、frontmatter 字段），不用恒真断言。
//
// 覆盖三条传输通道：REST、stdio MCP（core client → REST）、进程内 /mcp。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createRoleKey } from "../src/api-key-registry.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-wd1-reject1-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(workspaceRoot, { recursive: true });
const importsRoot = path.join(workspaceRoot, "imports");
await fs.mkdir(importsRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const apiKeyFile = path.join(path.dirname(auth.registryPath), "api-keys.json");
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const pilot = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01");

const OTHER_AGENT = "wd1r1-other-agent";
const ROLE = {
  // 普通写入角色：有 propose，但没有 admin、没有项目作用域
  A: { role_id: "wd1r1-a", group_id: "group-a", user_id: "user-a", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }] },
  // 持有 proj-a 项目作用域
  PROJ: { role_id: "wd1r1-proj", group_id: "group-a", user_id: "user-a", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "proj-a" }] },
  ADMIN: { role_id: "wd1r1-admin", group_id: "group-a", user_id: "user-admin", actions: ["search", "get", "propose", "admin"], scopes: [{ layer: "memory", visibility: "shared" }] },
  OTHER: { role_id: "wd1r1-other", group_id: "group-b", user_id: "user-b", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }] },
  // F5：**有 project 作用域但没有 propose** —— 旧代码会给 API-key 硬塞 propose
  NOPROPOSE: { role_id: "wd1r1-nopropose", group_id: "group-a", user_id: "user-np", actions: ["search", "get"], scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "proj-np" }] },
  // F5 正对照：**有 propose**
  WITHPROPOSE: { role_id: "wd1r1-withpropose", group_id: "group-a", user_id: "user-wp", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "proj-wp" }] },
};
for (const [key, role] of Object.entries(ROLE)) if (key !== "OTHER") pilot.roles.push({ ...role });
registry.frameworks[0].agents.push({ agent_id: OTHER_AGENT, roles: [{ ...ROLE.OTHER }] });
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
const secret = (await fs.readFile(path.join(auth.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).trim();

const server = createLocalhostServer({
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  apiKeyFile,
  dataRoot,
  workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});
const address = await server.listen();
const base = `http://127.0.0.1:${address.port}`;
after(async () => { await server.close(); });

async function http(roleKey, route, body = {}, headers = {}) {
  const agentId = roleKey === "OTHER" ? OTHER_AGENT : "pilot-01";
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ credential_ref: auth.credentialRef, secret, principal: { agent_id: agentId, role_id: ROLE[roleKey].role_id }, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

/** stdio MCP：core client 直连 REST（mcp-server.mjs:196 那条通道） */
async function mcpCall(roleKey, name, args) {
  const handler = createMcpHandler(createCoreClient(base, { credRef: auth.credentialRef, secret, agent: roleKey === "OTHER" ? OTHER_AGENT : "pilot-01", role: ROLE[roleKey].role_id }));
  const result = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const text = result.result?.content?.[0]?.text ?? "";
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { isError: result.result?.isError === true, text, data: parsed };
}

/** 进程内 /mcp（走 coreFromLib 自己的门，与 stdio 那条分离） */
async function inProcessMcp(roleKey, name, args) {
  const agentId = roleKey === "OTHER" ? OTHER_AGENT : "pilot-01";
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-mcp-credential-ref": auth.credentialRef,
      "x-mcp-secret": secret,
      "x-mcp-agent": agentId,
      "x-mcp-role": ROLE[roleKey].role_id,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const payload = await response.json().catch(() => ({}));
  const result = payload?.result ?? null;
  return { status: response.status, isError: result?.isError === true, text: result?.content?.[0]?.text ?? "", data: payload };
}

async function fileList() {
  const rows = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { rows.push(`${path.relative(dataRoot, absolute).replaceAll("\\", "/")}/`); await walk(absolute); }
      else rows.push(path.relative(dataRoot, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(dataRoot);
  return rows.sort();
}
async function read(relative) {
  return fs.readFile(path.join(dataRoot, relative), "utf8").catch(() => null);
}
async function statOrNull(relative) {
  return fs.stat(path.join(dataRoot, relative)).catch(() => null);
}

const TOOL_SECTIONS = { 用途: "工具笔记", 接入方式: "HTTP /v1/tools/note", 关键参数: "tool_name", 已知坑: "缺段会被 400 拒", 验证方式: "断言 403" };

// ─────────────────────────────────────────────────────────────── F1
test("REJECT1-F1 非 admin 自报 visibility=private 写 tools/note ⇒ 403 且零写入；admin ⇒ 200 且跨组可读", async () => {
  const before = await fileList();
  const denied = await http("A", "/v1/tools/note", { tool_name: "wd1r1-f1-forged", sections: TOOL_SECTIONS, visibility: "private", evidence_refs: ["wd1r1:f1"] });
  assert.equal(denied.status, 403, `claiming visibility=private must not bypass the platform gate, got ${denied.status} ${JSON.stringify(denied.data)}`);
  assert.equal(denied.data.error.code, "WRITE_SCOPE_DENIED", `the refusal must be a write-scope denial, got ${JSON.stringify(denied.data.error)}`);
  assert.deepEqual(await fileList(), before, "the refused tool note must create no file at all");

  // 同一条伪造在进程内 /mcp 上也必须被拒（两条传输同一把尺子）。
  // 注：toolNote 没有注册成 MCP 工具（MCP 只暴露 memory_write 等），所以这里用等价的
  // "layer=tool + 自报 private" 走 /mcp 的写门 —— 它同样必须按 platform 判权。
  const mcpDenied = await inProcessMcp("A", "memory_write", { layer: "tool", body: "想借默认可见性过门", tool_name: "wd1r1-f1-forged-mcp", sections: TOOL_SECTIONS, evidence_refs: ["wd1r1:f1m"] });
  assert.equal(mcpDenied.isError, true, `/mcp write that lands platform with a forged visibility must be refused, got ${JSON.stringify(mcpDenied.data)}`);
  assert.match(mcpDenied.text, /WRITE_SCOPE_DENIED|PLATFORM_REQUIRES_ADMIN/iu, `the /mcp refusal must name the write scope, got ${mcpDenied.text}`);
  await assert.rejects(fs.stat(path.join(dataRoot, "tools-memory/wd1r1-f1-forged-mcp.md")), "the refused /mcp write must create no file");

  // 正对照：admin ⇒ 200，落 platform，别的 group 读得到
  const allowed = await http("ADMIN", "/v1/tools/note", { tool_name: "wd1r1-f1-admin", sections: TOOL_SECTIONS, evidence_refs: ["wd1r1:f1a"] });
  assert.equal(allowed.status, 200, `an admin tool note must succeed, got ${allowed.status} ${JSON.stringify(allowed.data)}`);
  const fm = await read("tools-memory/wd1r1-f1-admin.md");
  assert.match(fm ?? "", /^visibility:\s*"?platform"?$/mu, `the written tool note must carry platform visibility, got ${String(fm).split("\n").find((l) => l.startsWith("visibility"))}`);
  const otherRead = await http("OTHER", "/v1/tools/get", { tool_name: "wd1r1-f1-admin" });
  assert.equal(otherRead.status, 200, `a platform tool note must be readable from another group, got ${otherRead.status}`);
});

// ─────────────────────────────────────────────────────────────── F2
test("REJECT1-F2 supersede 走同一道写门：platform 非 admin ⇒ 403 且新旧文件都不变", async () => {
  const seeded = await http("ADMIN", "/v1/write", { layer: "document", id: "wd1r1-f2-platform-old", body: "平台旧记录", evidence_refs: ["wd1r1:f2old"] });
  assert.equal(seeded.status, 200, `seeding a platform record as admin must succeed, got ${seeded.status} ${JSON.stringify(seeded.data)}`);
  const oldPath = "evidence/documents/wd1r1-f2-platform-old.md";
  const oldText = await read(oldPath);
  const oldStat = await statOrNull(oldPath);
  const before = await fileList();

  for (const [label, call] of [
    ["REST", () => http("A", "/v1/memory/supersede", { old_id: "wd1r1-f2-platform-old", layer: "document", id: "wd1r1-f2-platform-new", body: "想覆盖平台记录", evidence_refs: ["wd1r1:f2new"] })],
    ["stdio MCP", () => mcpCall("A", "memory_supersede", { old_id: "wd1r1-f2-platform-old", layer: "document", id: "wd1r1-f2-platform-new-mcp", body: "想覆盖平台记录", evidence_refs: ["wd1r1:f2newm"] })],
    ["in-process /mcp", () => inProcessMcp("A", "memory_supersede", { old_id: "wd1r1-f2-platform-old", layer: "document", id: "wd1r1-f2-platform-new-ip", body: "想覆盖平台记录", evidence_refs: ["wd1r1:f2newi"] })],
  ]) {
    const result = await call();
    const denied = label === "REST" ? result.status === 403 : result.isError === true;
    assert.ok(denied, `${label}: superseding a platform record without admin must be refused, got ${JSON.stringify(result.data ?? result.text)}`);
    if (label === "REST") assert.equal(result.data.error.code, "WRITE_SCOPE_DENIED", `${label}: must be a write-scope denial, got ${JSON.stringify(result.data.error)}`);
    else assert.match(result.text, /WRITE_SCOPE_DENIED|PLATFORM_REQUIRES_ADMIN/iu, `${label}: the refusal must name the write scope, got ${result.text}`);
  }
  assert.deepEqual(await fileList(), before, "refused supersedes must create no new file");
  assert.equal(await read(oldPath), oldText, "the old record must be byte-identical after the refusals");
  assert.equal((await statOrNull(oldPath)).mtimeMs, oldStat.mtimeMs, "the old record must not be rewritten (mtime unchanged)");

  // 正对照：admin 能取代，且旧记录被标记 superseded
  const allowed = await http("ADMIN", "/v1/memory/supersede", { old_id: "wd1r1-f2-platform-old", layer: "document", id: "wd1r1-f2-platform-admin-new", body: "平台新记录", evidence_refs: ["wd1r1:f2ok"] });
  assert.equal(allowed.status, 200, `an admin must be able to supersede a platform record, got ${allowed.status} ${JSON.stringify(allowed.data)}`);
  assert.match((await read(oldPath)) ?? "", /status:\s*"?superseded"?/u, "the old record must be marked superseded on the allowed path");
});

test("REJECT1-F2b supersede 的 project 作用域：无作用域 ⇒ 403 且零写入；有 ⇒ 200", async () => {
  const seeded = await http("PROJ", "/v1/project/state", { project: "proj-a", sections: { 目标: "项目取代", 当前进展: "种子", 下一步: "取代", 阻塞: "无" }, body: "项目旧版", evidence_refs: ["wd1r1:f2p-old"] });
  assert.equal(seeded.status, 200, `seeding a project record must succeed, got ${seeded.status} ${JSON.stringify(seeded.data)}`);
  const oldPath = "project-state/proj-a/current-state.md";
  const oldText = await read(oldPath);
  assert.ok(oldText, `the seeded project record must exist at ${oldPath}`);
  // 用**文件里真实的 id** 去取代，避免拿错 id（拿错会变成 404，测不到判权）
  const oldId = /^id:\s*"?([^"\n]+)"?$/mu.exec(oldText)?.[1]?.trim();
  assert.ok(oldId, `the project record must carry an id, got ${String(oldText).slice(0, 120)}`);
  const before = await fileList();
  const denied = await http("A", "/v1/memory/supersede", { old_id: oldId, layer: "project-decision", id: "wd1r1-f2b-deny", body: "无作用域的取代", evidence_refs: ["wd1r1:f2b"] });
  assert.equal(denied.status, 403, `superseding a project record without the project scope must be 403, got ${denied.status} ${JSON.stringify(denied.data)}`);
  assert.equal(denied.data.error.code, "WRITE_SCOPE_DENIED", `must be a write-scope denial, got ${JSON.stringify(denied.data.error)}`);
  assert.deepEqual(await fileList(), before, "a refused project supersede must create no file");
  assert.equal(await read(oldPath), oldText, "the project record must be unchanged after the refusal");
});

// ─────────────────────────────────────────────────────────────── F3
test("REJECT1-F3 tools/refresh 需要 admin：非 admin ⇒ 403 且内容/mtime/status 都不变", async () => {
  // 造一条 91 天前验证过的工具笔记（refresh 会把它改成 needs-review）
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  const seeded = await http("ADMIN", "/v1/tools/note", { tool_name: "wd1r1-f3-stale", sections: TOOL_SECTIONS, verified_at: old, evidence_refs: ["wd1r1:f3"] });
  assert.equal(seeded.status, 200, `seeding a stale tool note must succeed, got ${seeded.status} ${JSON.stringify(seeded.data)}`);
  const relative = "tools-memory/wd1r1-f3-stale.md";
  const beforeText = await read(relative);
  const beforeStat = await statOrNull(relative);
  assert.match(beforeText ?? "", /status:\s*"?active"?/u, "the seeded note must be active before refresh");

  const denied = await http("A", "/v1/tools/refresh", {});
  assert.equal(denied.status, 403, `a non-admin tools/refresh must be refused, got ${denied.status} ${JSON.stringify(denied.data)}`);
  assert.equal(await read(relative), beforeText, "a refused refresh must not rewrite the file");
  assert.equal((await statOrNull(relative)).mtimeMs, beforeStat.mtimeMs, "a refused refresh must not touch mtime");
  assert.match((await read(relative)) ?? "", /status:\s*"?active"?/u, "status must still be active after the refused refresh");

  const allowed = await http("ADMIN", "/v1/tools/refresh", {});
  assert.equal(allowed.status, 200, `an admin tools/refresh must succeed, got ${allowed.status} ${JSON.stringify(allowed.data)}`);
  assert.match((await read(relative)) ?? "", /status:\s*"?needs-review"?/u, "an allowed refresh must downgrade the stale note");
});

// ─────────────────────────────────────────────────────────────── F4
test("REJECT1-F4 身份位：跨身份自报 role/user 一律 403；同身份 ⇒ 200", async () => {
  const before = await fileList();
  const forgedRole = await http("A", "/v1/write", { layer: "curated-shared", visibility: "role", role_id: ROLE.OTHER.role_id, id: "wd1r1-f4-role", body: "想写到别人的角色", evidence_refs: ["wd1r1:f4"] });
  assert.equal(forgedRole.status, 403, `claiming another role_id must be refused, got ${forgedRole.status} ${JSON.stringify(forgedRole.data)}`);
  assert.equal(forgedRole.data.error.code, "WRITE_SCOPE_DENIED", `must be a write-scope denial, got ${JSON.stringify(forgedRole.data.error)}`);

  const forgedUser = await http("A", "/v1/write", { layer: "curated-shared", visibility: "user", user_id: ROLE.OTHER.user_id, id: "wd1r1-f4-user", body: "想写到别人的用户", evidence_refs: ["wd1r1:f4u"] });
  assert.equal(forgedUser.status, 403, `claiming another user_id must be refused, got ${forgedUser.status} ${JSON.stringify(forgedUser.data)}`);

  const forgedAgent = await http("A", "/v1/write", { layer: "curated-shared", visibility: "agent", agent: OTHER_AGENT, id: "wd1r1-f4-agent", body: "想写到别的 agent", evidence_refs: ["wd1r1:f4a"] });
  assert.equal(forgedAgent.status, 403, `claiming another agent must be refused, got ${forgedAgent.status} ${JSON.stringify(forgedAgent.data)}`);
  assert.deepEqual(await fileList(), before, "the refused cross-identity writes must create no file");

  // 正对照：同身份写 private ⇒ 200，本人可读、别组 404
  const own = await http("A", "/v1/write", { layer: "curated-shared", visibility: "private", id: "wd1r1-f4-own", body: "自己的私有记录", evidence_refs: ["wd1r1:f4o"] });
  assert.equal(own.status, 200, `writing private under your own identity must succeed, got ${own.status} ${JSON.stringify(own.data)}`);
  assert.equal((await http("A", "/v1/get", { id: "wd1r1-f4-own" })).status, 200, "the owner must read its own private record");
  assert.equal((await http("OTHER", "/v1/get", { id: "wd1r1-f4-own" })).status, 404, "another group must not read a private record");

  // 计划 confirm/done 也要带服务端身份：别的身份不能替别人确认计划
  const plan = await http("A", "/v1/plans/put", { topic: "wd1r1-f4-plan", sections: { 目标: "计划归属", 步骤: "- [ ] 断言跨身份被拒", 当前卡点: "无" }, evidence_refs: ["wd1r1:f4p"] });
  assert.equal(plan.status, 200, `owning a draft plan must succeed, got ${plan.status} ${JSON.stringify(plan.data)}`);
  const crossConfirm = await http("OTHER", "/v1/plans/confirm", { topic: "wd1r1-f4-plan" });
  assert.equal(crossConfirm.status, 403, `confirming someone else's plan must be refused, got ${crossConfirm.status} ${JSON.stringify(crossConfirm.data)}`);
  const ownConfirm = await http("A", "/v1/plans/confirm", { topic: "wd1r1-f4-plan" });
  assert.equal(ownConfirm.status, 200, `the owner must be able to confirm its own plan, got ${ownConfirm.status} ${JSON.stringify(ownConfirm.data)}`);
});

// ─────────────────────────────────────────────────────────────── F5
test("REJECT1-F5 API-key 不得平添 propose：有 project 作用域但无 propose ⇒ REST/MCP 都 403 且零写入", async () => {
  const noPropose = await createRoleKey({ file: apiKeyFile, pepper: "memory-lib-development-pepper", roleId: ROLE.NOPROPOSE.role_id, userId: ROLE.NOPROPOSE.user_id, groupId: ROLE.NOPROPOSE.group_id });
  const key = noPropose.secret;
  assert.ok(key, `createRoleKey must return the presented key, got ${JSON.stringify(noPropose).slice(0, 200)}`);

  const before = await fileList();
  const restDenied = await fetch(`${base}/v1/write`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ layer: "project-state", project: "proj-np", id: "wd1r1-f5-rest", body: "API-key 想写项目", evidence_refs: ["wd1r1:f5"] }),
  });
  const restData = await restDenied.json().catch(() => ({}));
  assert.equal(restDenied.status, 403, `an API key whose role lacks propose must not write, got ${restDenied.status} ${JSON.stringify(restData)}`);
  assert.deepEqual(await fileList(), before, "the refused API-key write must create no file");

  // 同一条 key 走进程内 /mcp 也必须被拒
  const mcpDenied = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": secret, "x-mcp-agent": "pilot-01", "x-mcp-role": ROLE.NOPROPOSE.role_id },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_write", arguments: { layer: "project-state", project: "proj-np", id: "wd1r1-f5-mcp", body: "x", evidence_refs: ["wd1r1:f5m"] } } }),
  });
  const mcpPayload = await mcpDenied.json().catch(() => ({}));
  assert.equal(mcpPayload?.result?.isError, true, `/mcp write with a propose-less role must be refused, got ${JSON.stringify(mcpPayload).slice(0, 300)}`);

  // 正对照：同样是 API-key，但角色**有** propose ⇒ 写得进
  const withPropose = await createRoleKey({ file: apiKeyFile, pepper: "memory-lib-development-pepper", roleId: ROLE.WITHPROPOSE.role_id, userId: ROLE.WITHPROPOSE.user_id, groupId: ROLE.WITHPROPOSE.group_id });
  const goodKey = withPropose.secret;
  const restAllowed = await fetch(`${base}/v1/write`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${goodKey}` },
    body: JSON.stringify({ layer: "project-state", project: "proj-wp", id: "wd1r1-f5-ok", body: "API-key 有 propose", evidence_refs: ["wd1r1:f5ok"] }),
  });
  const allowedData = await restAllowed.json().catch(() => ({}));
  assert.equal(restAllowed.status, 200, `an API key whose role holds propose AND the project scope must be able to write, got ${restAllowed.status} ${JSON.stringify(allowedData)}`);
});
