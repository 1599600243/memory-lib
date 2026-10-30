#!/usr/bin/env node
// VISIBILITY-FIX-1 追加 —— `learning` 当下即可复现吗？（真实数据副本 + 真实入口 + 真实身份）
// 用 /mcp 与 REST 两条路，身份 pilot-01/learner（actions 里确有 "learning"）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = process.cwd();
const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const workspaceRoot = COPY;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix-learn-"));
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
  role.group_id ??= "home-circle";
  role.user_id ??= "user-owner";
}
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const out = { copy: COPY, "learning 目录是否存在": false, 内容: {} };
try {
  const files = await fs.readdir(path.join(workspaceRoot, "learning"), { recursive: true });
  out["learning 目录是否存在"] = true;
  out["learning 下的文件数"] = files.length;
} catch { /* 无 learning 目录 */ }

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

try {
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const IDENTITIES = [["pilot-01", "learner"], ["pilot-01", "pet"], ["pilot-01", "reader"]];

  for (const [agent, role] of IDENTITIES) {
    const key = `${agent}/${role}`;
    // REST
    const rest = await fetch(`${base}/v1/learning/plan_get`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: agent, role_id: role }, topic: "memory-lib" }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    // MCP
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": agent, "x-mcp-role": role },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "learning_plan_get", arguments: { topic: "memory-lib" } } }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const text = String(mcp.body?.result?.content?.[0]?.text ?? "");
    out.内容[key] = {
      REST_status: rest.status,
      REST_有内容: JSON.stringify(rest.body).length > 80,
      REST_片段: JSON.stringify(rest.body).slice(0, 200),
      MCP_isError: mcp.body?.result?.isError ?? null,
      MCP_有内容: text.length > 80,
      MCP_片段: text.slice(0, 300),
    };
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
