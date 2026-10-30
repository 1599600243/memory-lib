#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT —— 复现验收岗那条反证，但用**真实数据副本 + 真实入口 + 真实凭据 + 多个真实身份**。
//
// 目标条目：memory/plans/memory-lib.md
//   visibility: private · agent_id: admin-01 · status: active
// ⇒ 只有 admin-01 该看得见。REST 侧由 authenticatedPrincipal 注入 principal，应当只回 1 条给 admin-01、其余 0 条。
// ⇒ `/mcp` 进程内（mcp/mcp-server.mjs:437 `planList: (payload) => wrap(() => plans.listPlans(payload))`）
//    把 payload 原样透传 ⇒ principal 为 null ⇒ plans-memory.mjs:146-148 三条 `if (principal && …)` **一条都不执行**。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = process.cwd();
const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const workspaceRoot = COPY;

// 被测身份：覆盖两个组、多个 agent/role（验收岗说"含别的组"）
const IDENTITIES = [
  { agent: "admin-01", role: "librarian-admin" },
  { agent: "pilot-01", role: "reader" },
  { agent: "pilot-01", role: "researcher" },
  { agent: "pilot-01", role: "steward" },
  { agent: "home-circle", role: "home-owner-agent" },
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis2r-plans-"));
const auth = await createTestAuth(ROOT, tmp);
// 不改副本的 identity.json；用测试 registry（agent/role 名与部署一致），group/user 沿用各 role 自带值。
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
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

const out = {
  fixture: "memory/plans/memory-lib.md（visibility=private, agent_id=admin-01, status=active）",
  identities: IDENTITIES.map((i) => `${i.agent}/${i.role}`),
};

try {
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const rows = [];

  for (const id of IDENTITIES) {
    const principal = { agent_id: id.agent, role_id: id.role };
    // ① REST /v1/plans/list（服务端注入 principal）
    const rest = await fetch(`${base}/v1/plans/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    // ② /mcp 进程内 memory_plan_list（空参数）
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": id.agent, "x-mcp-role": id.role },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_plan_list", arguments: {} } }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const mcpText = mcp.body?.result?.content?.[0]?.text;
    let mcpParsed = null;
    try { mcpParsed = JSON.parse(mcpText); } catch { /* keep null */ }
    const mcpIds = Array.isArray(mcpParsed) ? mcpParsed.map((p) => `${p.id}(agent=${p.agent_id ?? ""},vis=${p.visibility ?? ""})`) : null;

    rows.push({
      identity: `${id.agent}/${id.role}`,
      REST: rest.status === 200 ? { count: rest.body.count, ids: (rest.body.items ?? []).map((p) => p.id) } : { status: rest.status, error: rest.body.error },
      MCP_memory_plan_list: mcpParsed === null ? { raw: String(mcpText).slice(0, 120) } : { count: Array.isArray(mcpParsed) ? mcpParsed.length : null, ids: mcpIds },
    });
  }
  out["逐身份对照"] = rows;

  // ③ 第三条：memory_recall_brief 能不能"自报别的身份"读到角色记忆
  //    recall.mjs:93-97 myExperience(agent_id, role_id) → listRoleNotes({agent_id, role_id})（**不带 principal**）
  const briefRows = [];
  for (const [label, args] of [
    ["空参数（自报前）", {}],
    ["自报 agent_id=pilot-01（空 role）", { agent_id: "pilot-01" }],
    ["自报 agent_id=pilot-01 + role_id=researcher", { agent_id: "pilot-01", role_id: "researcher" }],
  ]) {
    // /mcp 进程内
    const mcpResp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": "reader" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_recall_brief", arguments: args } }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const text = mcpResp.body?.result?.content?.[0]?.text;
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* ignore */ }
    // REST 对照
    const restResp = await fetch(`${base}/v1/recall/brief`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" }, ...args }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    briefRows.push({
      args: label,
      MCP_has我的经验: typeof parsed?.text === "string" ? parsed.text.includes("我的经验") : null,
      MCP_snippet: typeof parsed?.text === "string" ? parsed.text.split("\n").filter((l) => l.includes("经验") || l.includes("EPERM") || l.includes("踩")).slice(0, 3).join(" | ").slice(0, 300) : String(text).slice(0, 200),
      REST_has我的经验: typeof restResp.body?.text === "string" ? restResp.body.text.includes("我的经验") : null,
      REST_snippet: typeof restResp.body?.text === "string" ? restResp.body.text.split("\n").filter((l) => l.includes("经验") || l.includes("EPERM") || l.includes("踩")).slice(0, 3).join(" | ").slice(0, 300) : null,
    });
  }
  out["memory_recall_brief 自报身份对照（同一个 reader 凭据）"] = briefRows;

  // ④ 内容级：memory_health 是否暴露绝对路径
  const health = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": "reader" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_health", arguments: {} } }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const healthText = health.body?.result?.content?.[0]?.text ?? "";
  out["memory_health 内容级"] = {
    exposesAbsolutePath: /[A-Za-z]:\\\\|[A-Za-z]:\\/.test(healthText),
    sample: healthText.replace(/\s+/gu, " ").slice(0, 400),
  };

  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
