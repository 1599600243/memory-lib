#!/usr/bin/env node
// VISIBILITY-AUDIT-1 / 线索 C —— 进程内 `/mcp` 的 `memory_role_list` 是否丢掉外围 principal？
//
// 线索指向：mcp/mcp-server.mjs:443
//     roleList: (payload) => wrap(() => roleMemory.listRoleNotes(payload)),
// 对照 REST：src/localhost-server.mjs:1293
//     await roleMemory.listRoleNotes({ principal: authenticatedPrincipal(authed, agent, role) })
// 而仓储：src/role-memory.mjs:78-92
//     trustedAgent = principal?.agent_id ?? agent_id      ← 两者都没有 ⇒ 不过滤
//     trustedRole  = principal?.role_id  ?? role_id       ← 两者都没有 ⇒ 不过滤
//     if (principal && !principalAllowsContainer(...)) continue   ← principal 为空 ⇒ 这条也不执行
//
// 本探针：最小夹具 + 真实 HTTP 实例，逐入口量"看得见几条"。
// 夹具里有 4 条角色记忆，分属 3 个 group / 2 个 agent / 2 个 role。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = process.cwd();

function roleNote({ id, agent, role, kind = "lesson", occurredAt = "2026-09-24T02:00:00.000Z", marker }) {
  return [
    "---",
    `id: "${id}"`,
    'layer: "role"',
    `agent_id: "${agent}"`,
    `role_id: "${role}"`,
    `kind: "${kind}"`,
    'confidence: "high"',
    'status: "active"',
    "superseded_by: null",
    `occurred_at: "${occurredAt}"`,
    'updated_at: "2026-09-24T02:00:00.000Z"',
    "tags: []",
    "evidence_refs: []",
    'tenant_id: "default"',
    'container: "role"',
    'visibility: "role"',
    "---",
    "",
    "## 经验",
    "",
    marker,
    "",
  ].join("\n");
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis-audit-c-"));
const dataRoot = path.join(tmp, "memory");
const workspaceRoot = tmp;

// 4 条角色记忆：覆盖 同 agent 同 role / 同 agent 异 role / 异 agent 同 role / 完全异己
const notes = [
  { id: "note-home-circle", agent: "pilot-01", role: "researcher", marker: "HOME-CIRCLE" },
  { id: "note-other-group-same-role", agent: "pilot-01", role: "researcher", marker: "OTHER-GROUP-SAME-ROLE" },
  { id: "note-same-agent-other-role", agent: "pilot-01", role: "steward", marker: "SAME-AGENT-OTHER-ROLE" },
  { id: "note-other-agent", agent: "work-circle", role: "ops-agent", marker: "OTHER-AGENT" },
];
for (const note of notes) {
  const dir = path.join(dataRoot, "curated", "agents", note.agent);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${note.id}.md`), roleNote(note), "utf8");
}

const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
// 把 pilot-01/researcher 指到 home-circle，work-circle 那套指到别的组
for (const agentEntry of registry.frameworks[0].agents) {
  for (const role of agentEntry.roles) {
    role.group_id = agentEntry.agent_id === "pilot-01" ? "home-circle" : "work-group";
    role.user_id = agentEntry.agent_id === "pilot-01" ? "user-owner" : "user-worker";
  }
}
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

async function collect(fetchImpl) {
  return { entries: await fetchImpl() };
}

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
});

const out = { notes: notes.map((n) => n.id), note: "4 条角色记忆分属 2 个 group / 2 个 agent / 2 个 role" };
try {
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const identities = [
    { agent_id: "pilot-01", role_id: "researcher", label: "pilot-01/researcher（group=home-circle）" },
    { agent_id: "pilot-01", role_id: "reader", label: "pilot-01/reader（group=home-circle）" },
  ];

  for (const identity of identities) {
    const id = { agent_id: identity.agent_id, role_id: identity.role_id };
    const entry = {};
    // ① REST /v1/roles/list（服务端注入 principal）
    const rest = await fetch(`${base}/v1/roles/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: id }) });
    const restBody = await rest.json();
    entry.REST_v1_roles_list = rest.status === 200 ? (restBody.items ?? []).map((i) => i.id).sort() : { status: rest.status, error: restBody.error };

    // ② 进程内 /mcp（同 localhost-server 第 684 行的装配）
    const mcpCall = async (args) => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": identity.agent_id, "x-mcp-role": identity.role_id },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_role_list", arguments: args } }),
      });
      const body = await response.json();
      if (response.status !== 200) return { http: response.status, error: body.error };
      const text = body?.result?.content?.[0]?.text;
      try { return JSON.parse(text); } catch { return { raw: text, isError: body?.result?.isError }; }
    };
    const empty = await mcpCall({});
    entry["MCP_/mcp_memory_role_list_空参数"] = Array.isArray(empty.items) ? empty.items.map((i) => i.id).sort() : empty;
    const filtered = await mcpCall({ agent_id: identity.agent_id });
    entry["MCP_/mcp_memory_role_list_仅自报 agent_id"] = Array.isArray(filtered.items) ? filtered.items.map((i) => i.id).sort() : filtered;

    // ③ MCP-over-HTTP client（stdio 适配器走的那条：createCoreClient → REST）
    const client = createCoreClient(base, { credRef: auth.credentialRef, secret: auth.authValue, agent: identity.agent_id, role: identity.role_id });
    const viaClient = await client.roleList({});
    entry["MCP_client_（stdio_适配器链路）"] = viaClient.status === 200 ? (viaClient.data.items ?? []).map((i) => i.id).sort() : { status: viaClient.status, error: viaClient.data?.error };

    // ④ 直连仓储（无 principal、无过滤参数）—— 用于说明根因，不代表任何入口
    const { createRoleMemory } = await import("../src/role-memory.mjs");
    const repo = createRoleMemory({ dataRoot });
    entry["直连仓储_listRoleNotes({})"] = (await repo.listRoleNotes({})).map((i) => i.id).sort();

    out[identity.label] = entry;
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
