import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { aggregateAgents } from "../web/console-agents.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("INJECT-FIX-1 F2：只有显式注入请求记 channel=inject，普通 recall 保持 localhost", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "inject-channel-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const auth = await createTestAuth(ROOT, tmp);
  const auditPath = path.join(tmp, "audit.jsonl");
  const dataRoot = path.join(tmp, "memory");
  const adapter = createLocalhostServer({
    libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: tmp, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    auditPath,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => adapter.close());
  const address = await adapter.listen();
  const url = `http://127.0.0.1:${address.port}/v1/recall/brief`;
  const body = JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" }, query: "不存在的事实", memory_only: true });
  const call = (headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  assert.equal((await call()).status, 200);
  assert.equal((await call({ "X-Memory-Channel": "inject" })).status, 200);
  assert.equal((await call({ "X-Memory-Channel": "untrusted-value" })).status, 200);

  const rows = (await fs.readFile(auditPath, "utf8")).trim().split(/\r?\n/u).map(JSON.parse).filter((row) => row.action === "recall_brief");
  assert.deepEqual(rows.map((row) => row.channel), ["localhost", "inject", "localhost"], "无声明和未知声明必须逐字保持 localhost");
  const rawInject = rows.find((row) => row.channel === "inject");
  assert.equal(rawInject.agent, "pilot-01");
  assert.equal(rawInject.role, "reader");

  const aggregate = aggregateAgents(rows);
  const reader = aggregate.rows.find((row) => row.agent === "pilot-01" && row.role === "reader");
  assert.deepEqual(reader.channels, [{ channel: "localhost", count: 2 }, { channel: "inject", count: 1 }]);
});
