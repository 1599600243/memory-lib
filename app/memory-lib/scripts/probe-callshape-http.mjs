#!/usr/bin/env node
// CALLSHAPE-1 探针（HTTP 口径）：契约表的三天，在**生产同一套装配**下，
// 分别以 reader / researcher 两个身份量一遍，并单列"漏传 agentId"的反例。
//
// 目的：把"表里的数字到底属于哪个身份"这件事用读数摆出来 —— 表当前没写身份，
// 而身份（role_id）与装配（agentId）**都会**改变 09-24 那一行。
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

const dataRoot = path.join(COPY, "memory");
const scratch = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "callshape-http-"));
const auth = await createTestAuth(process.cwd(), scratch);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((agent) => agent.roles)) {
  role.group_id ??= "home-circle";
  role.user_id ??= "user-owner";
}
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

async function run(libFactory, roleId, label) {
  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot: COPY,
    auditPath: path.join(scratch, `${label}.jsonl`),
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
      const r = await recallScenario({
        text: day, now: NOW, timezone: TZ,
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentials: { credential_ref: auth.credentialRef, secret: auth.authValue },
        principal: { agent_id: AGENT, role_id: roleId },
        pageSize: 100, chunkChars: 8000,
      });
      rows.push({ day, total_count: r.totalCount ?? null, returned: r.count ?? null, complete: r.complete ?? null, total_chars: r.totalChars ?? null, chunks: r.chunks ? r.chunks.length : null });
    }
    return rows;
  } finally {
    await server.close();
  }
}

const wiring = createServerLibFactory({ dataRoot, workspaceRoot: COPY, calendarTimezone: TZ, vectorLane: { probe: false } });
const noAgent = ({ scopes, principal, calendarTimezone }) => createMemoryLib({ dataRoot, workspaceRoot: COPY, scopes, principal, calendarTimezone, vectorLane: { probe: false } });

const out = {};
out["A reader + server-wiring（agentId 在位）"] = await run(wiring, "reader", "reader-wiring");
out["B researcher + server-wiring（agentId 在位）"] = await run(wiring, "researcher", "researcher-wiring");
out["C researcher + 漏传 agentId（反例）"] = await run(noAgent, "researcher", "researcher-noagent");
out["D reader + 漏传 agentId（反例）"] = await run(noAgent, "reader", "reader-noagent");
console.log(JSON.stringify(out, null, 2));
await fs.rm(scratch, { recursive: true, force: true });
