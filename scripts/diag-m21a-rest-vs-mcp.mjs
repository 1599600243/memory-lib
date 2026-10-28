#!/usr/bin/env node
/** 诊断：REST 与 MCP 按天枚举首页逐条对比（看排序 / 字段形状差异） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const GROUP = "group-m21v", USER = "user-m21v";
const FIXTURES = [
  ["edge-prev-day", "2026-10-09T15:30:00.000Z"], ["edge-day-start", "2026-10-09T16:30:00.000Z"],
  ["mid-day", "2026-10-10T04:00:00.000Z"], ["edge-day-end", "2026-10-10T15:30:00.000Z"],
  ["edge-next-day", "2026-10-10T16:30:00.000Z"],
  ...Array.from({ length: 10 }, (_, i) => [`bulk-${i}`, `2026-10-10T0${5 + (i % 5)}:${String(i * 5).padStart(2, "0")}:00.000Z`]),
];
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "m21a-diag-"));
const workspaceRoot = path.join(tmp, "workspace"), dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
for (const [id, capturedAt] of FIXTURES) {
  await fs.writeFile(path.join(convRoot, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, `groupId: ${GROUP}`, `userId: ${USER}`, "---", "", `夹具 ${id}`].join("\n"), "utf8");
}
const auth = await createTestAuth(REPO, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const r = registry.frameworks[0].agents.find((a) => a.agent_id === "pilot-01").roles.find((x) => x.role_id === "researcher");
r.group_id = GROUP; r.user_id = USER;
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false },
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;
const ident = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };

const rest = await (await fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, since: "2026-10-10", until: "2026-10-10", limit: 5, offset: 0 }) })).json();
const mcpRes = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": "researcher" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { since: "2026-10-10", until: "2026-10-10", limit: 5, offset: 0 } } }) });
const mcpBody = await mcpRes.json();
let mcp = null;
try { mcp = JSON.parse(mcpBody?.result?.content?.[0]?.text ?? "null"); } catch (e) { console.log("解析失败:", e.message); }

const show = (label, obj) => {
  console.log(`\n=== ${label} （status=${mcpRes.status}）keys=${obj ? Object.keys(obj).join(",") : "-"} total=${obj?.total_count} count=${obj?.count} next=${obj?.next_offset} has_more=${obj?.has_more}`);
  for (const it of obj?.results ?? []) console.log(`   ${it.path ?? it.id ?? JSON.stringify(it).slice(0, 80)}   updatedAt=${it.updatedAt ?? "-"}`);
};
show("REST 首页", rest);
show("MCP  首页", mcp);
console.log("\n=== MCP 原始返回（前 700 字）===");
console.log(JSON.stringify(mcpBody).slice(0, 700));

// 用不同 limit 探排序稳定性
for (const lim of [3, 5, 13]) {
  const a = await (await fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, since: "2026-10-10", until: "2026-10-10", limit: lim, offset: 0 }) })).json();
  console.log(`\nREST limit=${lim} 顺序: ${(a.results ?? []).map((x) => x.path.replace(/^.*[/\\]/, "")).join(" | ")}`);
}
await server.close();
await fs.rm(tmp, { recursive: true, force: true });
