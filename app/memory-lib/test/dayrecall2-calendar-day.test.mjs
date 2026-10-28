// DAYRECALL-2 —— 「哪一天」必须是**硬条件**，两条入口问的是同一个问题。
//
// 被打回的事实（`046a016` 上实测，1297→1407 条真实证据里的三天）：
//   ① 空 query + calendarDate（枚举）：9 / 185 / 133，窗口正确 —— DAYRECALL-1 已修好。
//   ② 有 query + calendarDate（检索）：**日期被整条丢掉**。问 10/10 拿回 10-19 的三条、
//      问 10/18 也拿回 10-19 的三条（探针 ②④⑤ 三条入口全是 `不在这一天: 3`）。
//      这比"0 条"更坏：它自信地答错。
//   根因：`lib.search()` 根本没有 `calendarDate` 形参；`/v1/search`（localhost-server:1074）
//   与 `/mcp memory_search`（mcp-server:409）都把 query 分支交给它，calendarDate 到不了。
//
// 本文件断言**具体 id 集合与具体窗口字符串**，不是 status=200：
//   - 跨零点：同一个 08:00 偏移下，23:59:30 与次日 00:00:30 必须分到两天；
//   - 时区不是 UTC：同一瞬时在 America/New_York 属于**前一天**（负偏移 + 前一日）；
//   - DST：America/New_York 2026-03-08 是 23 小时的一天，
//     窗口必须由 次日零点减当日零点 得出 ⇒ **禁止** 86400000 硬编码；
//   - 检索入口：有 query 时也必须落在当天，且与 REST / /mcp 两条入口逐字一致。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "Asia/Shanghai";

function conversation(id, capturedAt, body) {
  return ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, "groupId: home-circle", "userId: user-owner", "---", "", body ?? `fixture: ${id}`].join("\n");
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-dayrecall2-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversationsRoot = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversationsRoot, { recursive: true });
  // 跨零点：上海 10-18 23:59:30 与 10-19 00:00:30
  await fs.writeFile(path.join(conversationsRoot, "edge-before.md"), conversation("edge-before", "2026-10-18T15:59:30.000Z", "边界：上海 10-18 23:59:30"), "utf8");
  await fs.writeFile(path.join(conversationsRoot, "edge-after.md"), conversation("edge-after", "2026-10-18T16:00:30.000Z", "边界：上海 10-19 00:00:30"), "utf8");
  // 查询词命中：三天各一条，且 10-18 那条是**唯一**含「游戏」的 10-18 文件
  await fs.writeFile(path.join(conversationsRoot, "game-1018.md"), conversation("game-1018", "2026-10-18T02:00:00.000Z", "上海 10-18 上午：聊了游戏玩法"), "utf8");
  await fs.writeFile(path.join(conversationsRoot, "game-1019.md"), conversation("game-1019", "2026-10-19T02:00:00.000Z", "上海 10-19 上午：又聊了游戏配置"), "utf8");
  await fs.writeFile(path.join(conversationsRoot, "game-1020.md"), conversation("game-1020", "2026-10-20T02:00:00.000Z", "上海 10-20 上午：还在聊游戏"), "utf8");
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const reader = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "reader");
  reader.group_id = "home-circle";
  reader.user_id = "user-owner";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return { tmp, dataRoot, workspaceRoot, auth };
}

// **与生产同一个工厂**（server.mjs 用的也是 src/server-wiring.mjs 这一个）。
function factory({ dataRoot, workspaceRoot, calendarTimezone }) {
  return createServerLibFactory({ dataRoot, workspaceRoot, calendarTimezone: calendarTimezone ?? null, vectorLane: { probe: false } });
}

async function withServer(fn) {
  const { tmp, dataRoot, workspaceRoot, auth } = await fixture();
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
    calendarTimezone: TZ,
    libFactory: factory({ dataRoot, workspaceRoot, calendarTimezone: TZ }),
  });
  try {
    const address = await server.listen();
    const rest = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" } };
    const mcpHeaders = { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": "reader" };

    async function postRest(route, body) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...rest, ...body }) });
      return { status: response.status, body: await response.json() };
    }
    async function callMcp(name, args) {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args } } }) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      const text = body?.result?.content?.[0]?.text;
      assert.equal(typeof text, "string", JSON.stringify(body));
      return JSON.parse(text);
    }
    // REST 翻页取全
    async function restPaged(extra) {
      const ids = []; let cursor = null; let total = null; let resolvedRange = null;
      for (let guard = 0; guard < 30; guard += 1) {
        const page = await postRest("/v1/search", { query: "", ...extra, ...(cursor ? { cursor } : {}) });
        assert.equal(page.status, 200, JSON.stringify(page.body));
        total = page.body.total_count; resolvedRange ??= page.body.resolvedRange;
        ids.push(...(page.body.results ?? []).map((item) => item.id));
        if (!page.body.nextCursor) break;
        cursor = page.body.nextCursor;
      }
      return { total, ids: ids.sort(), resolvedRange, complete: ids.length === total };
    }
    const stdioHandler = createMcpHandler(createCoreClient(`http://127.0.0.1:${address.port}`, { credRef: auth.credentialRef, secret: auth.authValue, agent: "pilot-01", role: "reader" }));
    async function stdioSearch(args) {
      const message = await stdioHandler.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_search", arguments: args } });
      const text = message?.result?.content?.[0]?.text;
      assert.equal(typeof text, "string", JSON.stringify(message));
      return JSON.parse(text);
    }
    return await fn({ postRest, callMcp, restPaged, stdioSearch });
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("① 跨零点：上海 23:59:30 与次日 00:00:30 必须分到两天（枚举入口）", async () => {
  await withServer(async ({ restPaged }) => {
    const d18 = await restPaged({ calendarDate: "2026-10-18", calendarTimezone: TZ });
    const d19 = await restPaged({ calendarDate: "2026-10-19", calendarTimezone: TZ });
    assert.equal(d18.complete, true);
    assert.equal(d19.complete, true);
    // 具体集合：10-18 只有 edge-before + game-1018
    assert.deepEqual(d18.ids, ["edge-before", "game-1018"]);
    // 10-19 只有 edge-after + game-1019
    assert.deepEqual(d19.ids, ["edge-after", "game-1019"]);
    // 具体窗口字符串（半开区间 [当日零点, 次日零点)）
    assert.equal(d18.resolvedRange.since, "2026-10-17T16:00:00.000Z");
    assert.equal(d18.resolvedRange.untilExclusive, "2026-10-18T16:00:00.000Z");
    assert.equal(d18.resolvedRange.until, "2026-10-18T15:59:59.999Z");
    assert.equal(d19.resolvedRange.since, "2026-10-18T16:00:00.000Z");
    assert.equal(d19.resolvedRange.untilExclusive, "2026-10-19T16:00:00.000Z");
    assert.equal(d19.resolvedRange.calendarTimezone, TZ);
  });
});

test("② 时区不是 UTC：同一批瞬时在 America/New_York 属于前一天", async () => {
  await withServer(async ({ restPaged }) => {
    const ny18 = await restPaged({ calendarDate: "2026-10-18", calendarTimezone: "America/New_York" });
    const ny19 = await restPaged({ calendarDate: "2026-10-19", calendarTimezone: "America/New_York" });
    // NY 10-18 12:00（= 16:00:30Z）与前一日 22:00（= 10-19T02:00Z）都落在 NY 的 10-18
    assert.deepEqual(ny18.ids, ["edge-after", "edge-before", "game-1019"]);
    // NY 的 10-19 从 10-19T04:00Z 起 ⇒ 只有 10-20T02:00Z 的 game-1020（本地 10-19 22:00）
    assert.deepEqual(ny19.ids, ["game-1020"]);
    assert.equal(ny18.resolvedRange.calendarTimezone, "America/New_York");
    assert.equal(ny18.resolvedRange.since, "2026-10-18T04:00:00.000Z");
    assert.equal(ny18.resolvedRange.untilExclusive, "2026-10-19T04:00:00.000Z");
    // 同一瞬时（16:00:30Z）在上海是 10-19、在纽约是 10-18 —— 这正是必须按查询时区重算的理由
    const sh19 = await restPaged({ calendarDate: "2026-10-19", calendarTimezone: TZ });
    assert.equal(sh19.ids.includes("edge-after"), true);
    assert.equal(ny18.ids.includes("edge-after"), true);
  });
});

test("③ DST：America/New_York 2026-03-08 是 23 小时的一天（禁止 86400000 硬编码）", async () => {
  await withServer(async ({ restPaged }) => {
    const page = await restPaged({ calendarDate: "2026-03-08", calendarTimezone: "America/New_York" });
    // 3 月 8 日纽约春季前跳：本地 00:00 = 05:00Z，次日 00:00 = 04:00Z ⇒ 只有 23 小时
    assert.equal(page.resolvedRange.since, "2026-03-08T05:00:00.000Z");
    assert.equal(page.resolvedRange.untilExclusive, "2026-03-09T04:00:00.000Z");
    const spanMs = Date.parse(page.resolvedRange.untilExclusive) - Date.parse(page.resolvedRange.since);
    assert.equal(spanMs, 23 * 60 * 60 * 1000, "DST 日不是 24 小时；硬编码 86400000 会把这天算错");
    assert.equal(page.ids.length, 0, "这一天没有夹具文件");
  });
});

// 检索结果的标识是 `path`（枚举结果才带 `id`）—— 统一取 basename 再比较。
function idsOf(results) {
  return (results ?? []).map((item) => path.basename(String(item.path ?? item.id ?? ""), ".md")).filter(Boolean).sort();
}

test("④ 检索入口：有 query 时 calendarDate 仍是硬条件（REST / /mcp / stdio 三入口一致）", async () => {
  await withServer(async ({ postRest, callMcp, stdioSearch }) => {
    // 10-18 那天只有 game-1018 含「游戏」；game-1019 / game-1020 都在别的日子
    const rest = await postRest("/v1/search", { query: "游戏", calendarDate: "2026-10-18", calendarTimezone: TZ, limit: 100 });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const restIds = idsOf(rest.body.results);
    assert.deepEqual(restIds, ["game-1018"], "有 query 时必须只回当天命中的那一条");

    const mcp = await callMcp("memory_search", { query: "游戏", calendarDate: "2026-10-18", calendarTimezone: TZ, limit: 100 });
    assert.deepEqual(idsOf(mcp.results), restIds, "/mcp 必须与 REST 同一答案");

    const stdio = await stdioSearch({ query: "游戏", calendarDate: "2026-10-18", calendarTimezone: TZ, limit: 100 });
    assert.deepEqual(idsOf(stdio.results), restIds, "stdio 必须与 REST 同一答案");

    // 反证：问 10-19 拿到的是 10-19 那条，不是 10-18 / 10-20
    const rest19 = await postRest("/v1/search", { query: "游戏", calendarDate: "2026-10-19", calendarTimezone: TZ, limit: 100 });
    assert.deepEqual(idsOf(rest19.body.results), ["game-1019"]);

    // 不带 calendarDate ⇒ 三天的「游戏」都可能是候选（证明上面不是"只有一条"的巧合）
    const all = await postRest("/v1/search", { query: "游戏", calendarTimezone: TZ, limit: 100 });
    assert.equal(idsOf(all.body.results).length >= 2, true, `不带日期时不该只剩一条：${JSON.stringify(idsOf(all.body.results))}`);

    // 完整性：evidence 模式 + rawQuota 能取全那天所有词面命中
    const full = await postRest("/v1/search", { query: "游戏", calendarDate: "2026-10-18", calendarTimezone: TZ, limit: 100, searchMode: "evidence", rawQuota: 100 });
    assert.deepEqual(idsOf(full.body.results), ["game-1018"]);

    // 非法日期：4xx，不许 500
    const bad = await postRest("/v1/search", { query: "游戏", calendarDate: "2026-13-40", calendarTimezone: TZ });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });
});
