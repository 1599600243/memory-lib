#!/usr/bin/env node
// VISIBILITY-AUDIT-2 / 项 3 —— API-key 身份**端到端实测**（把 VISIBILITY-AUDIT-1 §B.4 的三段推论变成读数）。
//
// 推论链（来自码读，本轮要实测或推翻）：
//   ① localhost-server.mjs:278-289 —— 非 admin 的 API-key principal 拿到固定四向 scope，
//      其中 `{ layer: "memory", visibility: "agent", project: keyPrincipal.role_id }`
//   ② memory-lib.mjs 的 memory/agent(<project>) 分支 ⇒ 根 = `curated/agents/<role_id>`
//   ③ 于是当某个 role_id **恰好等于某个 curated/agents/<name> 目录名**时，
//      该 API-key 身份会拿到**那个目录的全部角色记忆**（不看 agent_id）
//
// 做法：在真实数据副本上起服务；用库函数造一把 key（role_id = "steward"，
// 它**正好**是副本里的一个目录名）；带 Bearer 打 /v1/roles/list 与 /v1/search。
// 全部只读（副本只读；api-keys.json 写在临时目录）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createRoleKey } from "../src/api-key-registry.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const KEY_ROLE_ID = process.argv[3] ?? "steward";   // 副本里 curated/agents/steward 存在
const dataRoot = path.join(COPY, "memory");
const workspaceRoot = COPY;

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vis2-apikey-"));
const registryPath = path.join(COPY, "runtime", "identity.json");
const pepper = "vis2-audit-pepper";

// ① 先看这个 role_id 在 identity.json 里绑的是谁（决定 framework/agent 解析）
const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
let boundAgent = null;
for (const fw of registry.frameworks ?? []) for (const a of fw.agents ?? []) for (const r of a.roles ?? []) if (r.role_id === KEY_ROLE_ID) boundAgent = { framework: fw.framework_id, agent_id: a.agent_id, actions: r.actions, scopes: r.scopes };

// ② 造 key（api-keys.json 落在临时目录，不写副本）
const apiKeyFile = path.join(scratch, "api-keys.json");
const key = await createRoleKey({ file: apiKeyFile, groupId: "group-alpha", groupName: "alpha", userId: "user-alpha", userName: "alpha-user", roleId: KEY_ROLE_ID, roleName: KEY_ROLE_ID, pepper });

const out = {
  copy: COPY,
  key: { id: key.id, role_id: key.role_id, group_id: key.group_id, user_id: key.user_id },
  "① role_id 在 identity.json 里的绑定": boundAgent,
};

// 复刻 server 内部那句 `libFactory({...})`：用于在**不起请求**的情况下看清根集合。
const libFactoryFor = (options) => createMemoryLib({ dataRoot, workspaceRoot, scopes: options.scopes, agentId: options.agentId, principal: options.principal, vectorLane: { probe: false } });

const server = createLocalhostServer({
  registryPath,
  secretStore: { type: "file", dir: path.join(COPY, "runtime", "secrets") },
  apiKeyFile,
  apiKeyPepper: pepper,
  dataRoot,
  workspaceRoot,
  auditPath: path.join(scratch, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  indexScheduleEnabled: false,
  vectorLane: { probe: false },
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
});

try {
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const asKey = (route, body = {}) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.secret}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // ③ whoami：看 API-key 身份被解析成什么
  const whoami = await asKey("/v1/whoami");
  out["② whoami（API-key 身份）"] = whoami.status === 200 ? { principal: whoami.body.principal, scopes: whoami.body.scopes, actions: whoami.body.actions } : whoami;

  // ③ 直接量"这个 key 身份实际拿到的检索根"——这才是 B.4 推论的核心。
  //    不能只靠 /v1/roles/list（它还要条目自带 agent_id/role_id 才留下）。
  out["② API-key 身份解析出的检索根"] = (() => {
    const keyRole = { scopes: [{ layer: "memory", visibility: "agent", project: KEY_ROLE_ID }, { layer: "memory", visibility: "user", project: "user-alpha" }, { layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "platform" }] };
    const lib = libFactoryFor({ scopes: keyRole.scopes, agentId: boundAgent?.agent_id ?? null, principal: { framework_id: "deepseek-harness", agent_id: boundAgent?.agent_id ?? null, role_id: KEY_ROLE_ID, group_id: "group-alpha", user_id: "user-alpha" } });
    return lib.roots.map((r) => path.relative(dataRoot, typeof r === "string" ? r : r.path).replaceAll("\\", "/") || "(dataRoot 顶层)");
  })();

  // ④ 角色记忆：能不能看到 curated/agents/steward 下的东西
  const roles = await asKey("/v1/roles/list");
  out["③ /v1/roles/list（API-key）"] = roles.status === 200
    ? { count: roles.body.count, items: (roles.body.items ?? []).map((i) => ({ id: i.id, agent_id: i.agent_id, role_id: i.role_id, path: path.relative(dataRoot, i.path) })) }
    : { status: roles.status, error: roles.body.error };

  // ⑤ 检索：这个 key 身份能不能检索到 steward 目录里的条目（= 根的**实际**效果）
  const search = await asKey("/v1/search", { query: "恢复", limit: 20 });
  out["④ /v1/search?query=恢复（API-key）"] = { status: search.status, count: search.body.count, hits: (search.body.results ?? []).map((r) => path.relative(dataRoot, r.path)) };
  // 时间枚举：直接看 steward 目录里那条到底在不在结果里
  const enumerated = await asKey("/v1/search", { query: "", since: "2000-01-01", until: "2100-01-01", limit: 100 });
  out["⑤ 全时间枚举（API-key）"] = { status: enumerated.status, total: enumerated.body.total_count, stewardHits: (enumerated.body.results ?? []).map((r) => path.relative(dataRoot, r.path)).filter((p) => p.includes("agents")) };

  // ⑥ 对照：不带 Bearer、用 role reader 的普通凭证请求同一件事（正规入口）
  const secretText = (await fs.readFile(path.join(COPY, "runtime", "secrets", "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/u, "");
  const normal = await fetch(`${base}/v1/roles/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: "memory-lib/deepseek-harness", secret: secretText, principal: { agent_id: "pilot-01", role_id: "reader" } }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  out["⑤ 对照：普通身份 pilot-01/reader 的 /v1/roles/list"] = normal.status === 200 ? { count: normal.body.count, ids: (normal.body.items ?? []).map((i) => i.id) } : { status: normal.status, error: normal.body.error };

  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
