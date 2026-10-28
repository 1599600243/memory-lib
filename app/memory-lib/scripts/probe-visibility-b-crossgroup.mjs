#!/usr/bin/env node
// VISIBILITY-AUDIT-1 / 线 B（②③）—— 最小跨组夹具：两个组各有一个**同名** role，
// 用真实 HTTP 入口（/v1/roles/list，服务端注入 principal）量"能不能互相看见"。
//
// 为什么用 /v1/roles/list 而不是 timeline：角色记忆的读路径就是 role-memory 的 listRoleNotes，
// 而且它把 principal 传进了 principalAllowsContainer（role-memory.mjs:88），是本条要查的判据所在。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = process.cwd();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis-b-crossgroup-"));
const dataRoot = path.join(tmp, "memory");

function roleNote({ id, agent, role, marker }) {
  return ["---", `id: "${id}"`, 'layer: "role"', `agent_id: "${agent}"`, `role_id: "${role}"`, 'kind: "lesson"', 'confidence: "high"', 'status: "active"', "superseded_by: null", 'occurred_at: "2026-09-24T02:00:00.000Z"', 'updated_at: "2026-09-24T02:00:00.000Z"', "tags: []", "evidence_refs: []", 'tenant_id: "default"', 'container: "role"', 'visibility: "role"', "---", "", "## 经验", "", marker, ""].join("\n");
}

// group-a 与 group-b 各有一条**角色记忆**，agent_id 与 role_id **完全相同**（同名 role 场景）。
// 现实里 group 的唯一痕迹就是它在哪个组——所以这里两条的**归属字段完全一样**，
// 只有所在目录（= 现实里挂在哪个 agent 下）不同。
await fs.mkdir(path.join(dataRoot, "curated", "agents", "agent-in-group-a"), { recursive: true });
await fs.mkdir(path.join(dataRoot, "curated", "agents", "agent-in-group-b"), { recursive: true });
await fs.writeFile(path.join(dataRoot, "curated", "agents", "agent-in-group-a", "n-a.md"), roleNote({ id: "note-group-a", agent: "shared-agent", role: "shared-role", marker: "GROUP-A-NOTE" }), "utf8");
await fs.writeFile(path.join(dataRoot, "curated", "agents", "agent-in-group-b", "n-b.md"), roleNote({ id: "note-group-b", agent: "shared-agent", role: "shared-role", marker: "GROUP-B-NOTE" }), "utf8");

const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
// 两个 agent 各绑一个**同名 role_id**（shared-role），但分属不同 group。
const framework = registry.frameworks[0];
framework.agents = [
  { agent_id: "shared-agent", roles: [{ role_id: "shared-role", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get"], group_id: "group-a", user_id: "user-a" }] },
  { agent_id: "shared-agent", roles: [{ role_id: "shared-role", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get"], group_id: "group-b", user_id: "user-b" }] },
];
// 同名 agent_id + 同名 role_id 在同一个 framework 里无法区分 ⇒ 用**两条账密**各绑一组，
// 靠账号把 group 定死（identity.json 的账号才是 group 的真正来源）。
registry.accounts = [
  { username: "a@example", framework_id: framework.framework_id, credential_ref: auth.credentialRef, agent_id: "shared-agent", role_id: "shared-role", group_id: "group-a", user_id: "user-a", status: "active" },
  { username: "b@example", framework_id: framework.framework_id, credential_ref: auth.credentialRef, agent_id: "shared-agent", role_id: "shared-role", group_id: "group-b", user_id: "user-b", status: "active" },
];
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  dataRoot,
  workspaceRoot: tmp,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  indexScheduleEnabled: false,
  vectorLane: { probe: false },
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot: tmp, vectorLane: { probe: false } }),
});

const out = { fixture: { "note-group-a": "agent_id=shared-agent role_id=shared-role（目录 agent-in-group-a）", "note-group-b": "agent_id=shared-agent role_id=shared-role（目录 agent-in-group-b）" } };
try {
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  // 直接用 role 的 group_id 判据拿两条的身份（agent_id/role_id 相同），
  // 再量 /v1/roles/list 能看到哪几条。
  for (const group of ["group-a", "group-b"]) {
    const principal = { agent_id: "shared-agent", role_id: "shared-role", group_id: group, user_id: group === "group-a" ? "user-a" : "user-b" };
    const r = await fetch(`${base}/v1/roles/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal }) });
    const body = await r.json();
    out[`principal(group=${group}, agent=shared-agent, role=shared-role)`] = r.status === 200
      ? { seen: (body.items ?? []).map((i) => `${i.id}(agent=${i.agent_id},role=${i.role_id})`).sort() }
      : { status: r.status, error: body.error };
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
