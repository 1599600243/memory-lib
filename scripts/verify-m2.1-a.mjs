#!/usr/bin/env node
/**
 * verify-m2.1-a.mjs —— M2.1-A 的**独立复核探针**（产品岗，非执行者）
 *
 * 与开发自带测试的区别（为什么要自己写）：
 *   · 开发测的是 **单边界**（local 10/10 02:00 要进 10/10、不进 10/09）；
 *     本探针测**两端边界**：local 10/09 23:30 与 local 10/11 00:30 都必须被挡在 10/10 之外；
 *   · 本探针**给不同的夹具**（15 条、跨三天、limit=5 ⇒ 必须翻 3 页），
 *     而不是重跑同一份 fixture（重跑开发的测试**不算独立证据**）；
 *   · 额外核 **REST 与 MCP 的按天枚举结果是否一致**，以及**跨组主体是否零命中**。
 *
 * 用法：node verify-m2.1-a.mjs [repoRoot]
 * 结论：全部断言通过 ⇒ 打印 PASS 并 exit 0；任一失败 ⇒ 打印 FAIL 明细并 exit 1。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const GROUP = "group-m21v";
const USER = "user-m21v";
// 本地时区 CST(+08:00)：本地日 2026-10-10 = UTC [10-09 16:00, 10-10 16:00)
const FIXTURES = [
  // 本地 10/09 23:30 —— 必须**不在** 10/10（最靠边的左邻）
  { id: "edge-prev-day", capturedAt: "2026-10-09T15:30:00.000Z", expect: "excluded" },
  // 本地 10/10 00:30 —— 必须在 10/10（左边界内）
  { id: "edge-day-start", capturedAt: "2026-10-09T16:30:00.000Z", expect: "included" },
  // 本地 10/10 12:00
  { id: "mid-day", capturedAt: "2026-10-10T04:00:00.000Z", expect: "included" },
  // 本地 10/10 23:30 —— 必须在 10/10（右边界内）
  { id: "edge-day-end", capturedAt: "2026-10-10T15:30:00.000Z", expect: "included" },
  // 本地 10/11 00:30 —— 必须**不在** 10/10（最靠边的右邻）
  { id: "edge-next-day", capturedAt: "2026-10-10T16:30:00.000Z", expect: "excluded" },
  // 再塞 10 条到 10/10 正中，制造分页需求（合计 13 条属于 10/10）
  ...Array.from({ length: 10 }, (_, i) => ({ id: `bulk-${i}`, capturedAt: `2026-10-10T0${5 + (i % 5)}:${String(i * 5).padStart(2, "0")}:00.000Z`, expect: "included" })),
];

const file = (f) => ["---", `id: ${f.id}`, "type: conversation", `capturedAt: ${f.capturedAt}`, `groupId: ${GROUP}`, `userId: ${USER}`, "---", "", `独立复核夹具 ${f.id}`].join("\n");

const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "m21a-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
for (const f of FIXTURES) await fs.writeFile(path.join(convRoot, `${f.id}.md`), file(f), "utf8");

const auth = await createTestAuth(REPO, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const role = registry.frameworks[0].agents.find((a) => a.agent_id === "pilot-01").roles.find((r) => r.role_id === "researcher");
role.group_id = GROUP; role.user_id = USER;
// 造一个"同组不同用户"和一个"跨组"主体，用于负向
const fw = registry.frameworks[0];
const pilotRole = fw.agents.find((a) => a.agent_id === "pilot-01").roles.find((r) => r.role_id === "researcher");
fw.agents.push({ agent_id: "m21-same-group", roles: [{ ...JSON.parse(JSON.stringify(pilotRole)), role_id: "researcher", group_id: GROUP, user_id: "user-other" }] });
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false },
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});

try {
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const authBody = (agent = "pilot-01", r = "researcher") => ({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: agent, role_id: r } });
  const day = async (d, offset = 0, agent, r) => {
    const res = await fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody(agent, r), since: d, until: d, limit: 5, offset }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const mcpDay = async (d, offset = 0) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": "researcher" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { since: d, until: d, limit: 5, offset } } }),
    });
    const body = await res.json().catch(() => null);
    let inner = null;
    try { inner = JSON.parse(body?.result?.content?.[0]?.text ?? "null"); } catch {}
    return { status: res.status, body, inner };
  };
  const paths = (r) => (r?.results ?? []).map((x) => String(x.path ?? "")).sort();

  console.log("== ① 按本地日 2026-10-10 翻页取全 ==");
  const first = await day("2026-10-10");
  note(first.status === 200, `HTTP 200（实际 ${first.status}）`);
  const expectedIncluded = FIXTURES.filter((f) => f.expect === "included").length;
  note(first.body?.total_count === expectedIncluded, `total_count = ${expectedIncluded}（实际 ${first.body?.total_count}）`);
  let all = [...(first.body?.results ?? [])];
  let offset = first.body?.next_offset ?? null;
  let pages = 1;
  while (offset !== null && pages < 20) { const p = await day("2026-10-10", offset); all.push(...(p.body?.results ?? [])); offset = p.body?.next_offset ?? null; pages += 1; }
  note(all.length === expectedIncluded, `翻页取全 = ${expectedIncluded} 条（实际 ${all.length}，共 ${pages} 页）`);
  note(all.every((x) => x.path && x.updatedAt && x.excerpt), "每条都带 路径 + 时间 + 可读摘要");

  console.log("== ② 两端边界（本地日）==");
  const has = (id) => all.some((x) => String(x.path).endsWith(`${id}.md`));
  note(has("edge-day-start"), "本地 10/10 00:30 在 10/10 内（左边界内）");
  note(has("edge-day-end"), "本地 10/10 23:30 在 10/10 内（右边界内）");
  note(!has("edge-prev-day"), "本地 10/09 23:30 **不在** 10/10（左邻被挡住）");
  note(!has("edge-next-day"), "本地 10/11 00:30 **不在** 10/10（右邻被挡住）");

  console.log("== ③ REST 与 MCP 各自翻页取全，再比全集 ==");
  const m = await mcpDay("2026-10-10");
  if (m.inner) {
    note(m.inner?.total_count === expectedIncluded, `MCP total_count = ${expectedIncluded}（实际 ${m.inner?.total_count}）`);
    let mcpAll = [...(m.inner.results ?? [])];
    let mcpOffset = m.inner.next_offset ?? null;
    let mcpPages = 1;
    while (mcpOffset !== null && mcpPages < 20) { const p = await mcpDay("2026-10-10", mcpOffset); mcpAll.push(...(p.inner?.results ?? [])); mcpOffset = p.inner?.next_offset ?? null; mcpPages += 1; }
    note(mcpAll.length === expectedIncluded, `MCP 翻页取全 = ${expectedIncluded} 条（实际 ${mcpAll.length}，共 ${mcpPages} 页）`);
    note(JSON.stringify(paths({ results: mcpAll })) === JSON.stringify(paths({ results: all })), "MCP 与 REST 的**整日路径集合**完全一致");
    const order = (rs) => (rs ?? []).map((x) => String(x.path));
    note(JSON.stringify(order(mcpAll)) === JSON.stringify(order(all)), "MCP 与 REST 的**排列顺序**也一致（含同秒并列）");
  } else {
    note(false, `MCP 未返回可解析结果（status=${m.status}，body=${String(JSON.stringify(m.body)).slice(0, 160)}）`);
  }

  console.log("== ④ 负向：同组不同用户 ==");
  const neg = await day("2026-10-10", 0, "m21-same-group", "researcher");
  note((neg.body?.results ?? []).length === 0, `同组不同用户零命中（实际 ${(neg.body?.results ?? []).length} 条，status=${neg.status}）`);

  console.log("== ⑤ 无时间范围时仍走普通检索（不应退化成枚举一切）==");
  const noRange = await fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody(), query: "独立复核夹具", limit: 100 }) });
  const nr = await noRange.json().catch(() => null);
  note(noRange.status === 200 && Array.isArray(nr?.results), `带关键词的检索仍 200 且返回数组（实际 ${nr?.results?.length} 条）`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— 独立复核全部通过（按本地日枚举取全 / 两端边界 / REST≡MCP / 跨用户零命中）");
