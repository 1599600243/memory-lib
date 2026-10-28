// ATOMICWRITE-1 探针：逐个记录非法输入**当前**的状态码与错误码。
// 只读：自建临时 dataRoot，不碰生产。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-probe-4xx-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(path.join(dataRoot, "evidence", "conversations"), { recursive: true });
const evidence = ["---", "id: a", "type: conversation", "capturedAt: 2026-10-10T01:00:00.000Z", 'groupId: "g"', 'userId: "u"', "---", "", "body"].join("\n");
await fs.writeFile(path.join(dataRoot, "evidence", "conversations", "a.md"), evidence, "utf8");

const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const researcher = registry.frameworks[0].agents.find((a) => a.agent_id === "pilot-01").roles.find((r) => r.role_id === "researcher");
researcher.group_id = "g";
researcher.user_id = "u";
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: "Asia/Shanghai",
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});
const address = await server.listen();
const authBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };

async function post(route, body) {
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody, ...body }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const CASES = [
  ["calendarDate=2026-13-45 (month+day out of range)", "/v1/search", { query: "", calendarDate: "2026-13-45", calendarTimezone: "Asia/Shanghai" }],
  ["calendarDate=2026-02-30 (not a real date)", "/v1/search", { query: "", calendarDate: "2026-02-30", calendarTimezone: "Asia/Shanghai" }],
  ["calendarDate=2026-10-10T99 (timestamp suffix)", "/v1/search", { query: "", calendarDate: "2026-10-10T99", calendarTimezone: "Asia/Shanghai" }],
  ["calendarDate=10/10 (wrong shape)", "/v1/search", { query: "", calendarDate: "10/10", calendarTimezone: "Asia/Shanghai" }],
  ["calendarTimezone=Not/AZone", "/v1/search", { query: "", calendarDate: "2026-10-10", calendarTimezone: "Not/AZone" }],
  ["since/until garbage", "/v1/search", { query: "", since: "not-a-time", until: "also-not" }],
  ["cursor garbage (undecodable)", "/v1/search", { query: "", calendarDate: "2026-10-10", cursor: "!!!not-base64-json!!!" }],
  ["cursor decodes but wrong shape", "/v1/search", { query: "", calendarDate: "2026-10-10", cursor: Buffer.from('{"a":1}').toString("base64url") }],
  ["offset negative", "/v1/search", { query: "", calendarDate: "2026-10-10", offset: -5 }],
  ["limit huge", "/v1/search", { query: "", calendarDate: "2026-10-10", limit: 99999 }],
  ["weekStartsOn=9 on date/resolve", "/v1/date/resolve", { text: "本周", now: "2026-10-10T00:00:00.000Z", timezone: "Asia/Shanghai", weekStartsOn: 9 }],
  ["date/resolve timezone bad", "/v1/date/resolve", { text: "10/10", now: "2026-10-10T00:00:00.000Z", timezone: "Not/AZone" }],
  ["date/resolve now bad", "/v1/date/resolve", { text: "10/10", now: "nonsense", timezone: "Asia/Shanghai" }],
];

const rows = [];
for (const [label, route, body] of CASES) {
  const out = await post(route, body);
  rows.push({ label, route, status: out.status, code: out.body?.error?.code ?? out.body?.reason ?? null, message: String(out.body?.error?.message ?? out.body?.message ?? "").slice(0, 110) });
}
console.log(JSON.stringify(rows, null, 2));

await server.close();
await fs.rm(tmp, { recursive: true, force: true });
