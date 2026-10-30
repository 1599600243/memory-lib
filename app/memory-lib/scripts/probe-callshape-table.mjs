#!/usr/bin/env node
// CALLSHAPE-1 探针：契约文档 §5.1 那张实测表的数字，到底该由**哪套装配**量出来？
//
// 做法：在**真实数据副本**（只读）上起一个进程内服务端，
//   - 主口径：`src/server-wiring.mjs` 的工厂（= 生产 server.mjs 用的同一套）
//   - 对照口径：故意做一个**漏传 agentId** 的装配（D4F1 self-root 会失效）
// 身份 / 时区 / 参数照文档：pilot-01/reader、Asia/Shanghai、pageSize=100、chunkChars=8000。
import fs from "node:fs/promises";
import path from "node:path";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { recallScenario } from "../src/scenario-recall.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const DAYS = ["2026-10-07", "2026-10-05", "2026-09-24"];
const TZ = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const AGENT = "pilot-01";
const ROLE = "reader";

const dataRoot = path.join(COPY, "memory");
const workspaceRoot = COPY;

// 借用测试夹具在**临时目录**里生成 registry/secret（不写副本）。
const scratch = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "callshape-probe-"));
const auth = await createTestAuth(path.join(process.cwd()), scratch);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((agent) => agent.roles)) {
  role.group_id ??= "home-circle";
  role.user_id ??= "user-owner";
}
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

async function measureWith(libFactory, label) {
  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(scratch, `audit-${label}.jsonl`),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory,
    calendarTimezone: TZ,
  });
  try {
    const address = await server.listen();
    const rows = [];
    for (const day of DAYS) {
      const result = await recallScenario({
        text: day, now: NOW, timezone: TZ,
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentials: { credential_ref: auth.credentialRef, secret: auth.authValue },
        principal: { agent_id: AGENT, role_id: ROLE },
        pageSize: 100, chunkChars: 8000,
      });
      rows.push({
        day,
        kind: result.kind,
        total_count: result.totalCount ?? null,
        returned: result.count ?? null,
        complete: result.complete ?? null,
        total_chars: result.totalChars ?? null,
        chunks: result.chunks ? result.chunks.length : null,
      });
    }
    return rows;
  } finally {
    await server.close();
  }
}

const out = { copy: COPY, note: "§5.1 实测表的三天；两种装配对照" };

// ① 生产同一套装配
out["① server-wiring（= 生产形状）"] = await measureWith(
  createServerLibFactory({ dataRoot, workspaceRoot, calendarTimezone: TZ, vectorLane: { probe: false } }),
  "wiring",
);

// ② 漏传 agentId 的装配（旧探针的形状）
out["② 漏传 agentId 的装配（反例）"] = await measureWith(
  ({ scopes, principal, calendarTimezone }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, calendarTimezone, vectorLane: { probe: false } }),
  "noagent",
);

console.log(JSON.stringify(out, null, 2));
await fs.rm(scratch, { recursive: true, force: true });
