// TZ-CONFIG-1-REJECT —— **接线门**：同一个部署默认时区必须在**所有入口**上一致生效。
//
// 被打回的事实（改动前 `2adbd14`，同一实例/同一数据/同一身份、同一条裸日期请求）：
//   REST  POST /v1/search   → 177 条 / [10-06T16:00Z, 10-07T16:00Z) / Asia/Shanghai
//   MCP   POST /mcp         → 146 条 / [10-07T00:00Z, 10-08T00:00Z) / UTC      ← 分裂
// 两条 MCP 通道之间也不一致：
//   stdio MCP（走 REST）    → 177 / Asia/Shanghai
//   streamable-http `/mcp`  → 146 / UTC
//
// 根因：`/mcp` 走**进程内** `coreFromLib`，两条工具处理器各有自己的兜底：
//   mcp-server.mjs:369  lib.timeline({ calendarTimezone: <只有显式传参才带> })
//   mcp-server.mjs:348  resolveDateText({ timezone: timezone ?? "UTC" })   ← 写死 UTC
// 而 REST 三条路由读的是 `options.calendarTimezone` ⇒ 进程内 MCP 拿不到部署默认。
//
// 本文件断言**具体窗口字符串与条数**（不是 status=200），并覆盖四种写法。
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
// 上海本地 2026-10-07 = [2026-10-06T16:00Z, 2026-10-07T16:00Z)
// UTC   2026-10-07    = [2026-10-07T00:00Z, 2026-10-08T00:00Z)
// 两者只差 16:00Z–24:00Z 这一段 ⇒ 夹具两条落在缝里，口径一换条数就变。
const DAY = "2026-10-07";
const SH = { since: "2026-10-06T16:00:00.000Z", until: "2026-10-07T15:59:59.999Z", untilExclusive: "2026-10-07T16:00:00.000Z" };
const UTC = { since: "2026-10-07T00:00:00.000Z", until: "2026-10-07T23:59:59.999Z", untilExclusive: "2026-10-08T00:00:00.000Z" };

function conversation(id, capturedAt, groupId = "home-circle", userId = "user-owner") {
  return ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, `groupId: ${groupId}`, `userId: ${userId}`, "---", "", `entry-entry-parity fixture: ${id}`].join("\n");
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-entry-parity-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversations = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversations, { recursive: true });
  // 只属于「上海 10-07」的两条（UTC 视角是 10-06）
  await fs.writeFile(path.join(conversations, "sh-only-a.md"), conversation("sh-only-a", "2026-10-06T16:30:00.000Z"), "utf8");
  await fs.writeFile(path.join(conversations, "sh-only-b.md"), conversation("sh-only-b", "2026-10-06T17:30:00.000Z"), "utf8");
  // 两个口径都算 10-07 的一条
  await fs.writeFile(path.join(conversations, "both.md"), conversation("both", "2026-10-07T09:00:00.000Z"), "utf8");
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const reader = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "reader");
  reader.group_id = "home-circle";
  reader.user_id = "user-owner";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return { tmp, dataRoot, workspaceRoot, auth };
}

// **与生产同一个工厂**（server.mjs 用的也是 src/server-wiring.mjs 这一个）。
// 上一版测试自己写了个"更完整"的工厂、把 calendarTimezone 前传了，于是测试绿而生产仍错。
// 所以这里绝不自己拼工厂。
function factory({ dataRoot, workspaceRoot, calendarTimezone }) {
  return createServerLibFactory({ dataRoot, workspaceRoot, calendarTimezone: calendarTimezone ?? null, vectorLane: { probe: false } });
}

// 一个实例上暴露三种入口：REST /v1/search、MCP /mcp（tools/call）、stdio MCP 的客户端链路
async function withServer({ calendarTimezone = undefined }, fn) {
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
    libFactory: factory({ dataRoot, workspaceRoot, calendarTimezone }),
    ...(calendarTimezone === undefined ? {} : { calendarTimezone }),
  });
  try {
    const address = await server.listen();
    const rest = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" } };
    const mcpHeaders = {
      "content-type": "application/json",
      "x-mcp-credential-ref": auth.credentialRef,
      "x-mcp-secret": auth.authValue,
      "x-mcp-agent": "pilot-01",
      "x-mcp-role": "reader",
    };

    async function postRest(route, body) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...rest, ...body }) });
      return { status: response.status, body: await response.json() };
    }

    async function callMcp(name, args) {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args } } }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      const text = body?.result?.content?.[0]?.text;
      assert.equal(typeof text, "string", JSON.stringify(body));
      assert.equal(body.result.isError, false, `MCP 工具报错：${text}`);
      return JSON.parse(text);
    }

    // REST /v1/search：翻页取全
    async function restSearch(extra) {
      const ids = [];
      let cursor = null;
      let total = null;
      let resolvedRange = null;
      for (let guard = 0; guard < 30; guard += 1) {
        const page = await postRest("/v1/search", { query: "", limit: 2, ...extra, ...(cursor ? { cursor } : {}) });
        assert.equal(page.status, 200, JSON.stringify(page.body));
        total = page.body.total_count;
        resolvedRange ??= page.body.resolvedRange;
        ids.push(...(page.body.results ?? []).map((item) => item.id));
        if (!page.body.nextCursor) break;
        cursor = page.body.nextCursor;
      }
      return { total, ids, resolvedRange, complete: ids.length === total };
    }

    // MCP memory_search：解析它返回的 JSON 载荷
    async function mcpSearch(extra) {
      const data = await callMcp("memory_search", { since: DAY, until: DAY, limit: 100, ...extra });
      return {
        total: data.total_count,
        ids: (data.results ?? []).map((item) => item.id).sort(),
        resolvedRange: data.resolvedRange,
      };
    }

    // ---- 第三条入口：**stdio MCP 所用的那条链路** ----
    // 真正的 stdio 适配器（mcp_stdio.mjs 那条）在子进程里跑，而本沙箱禁止带管道的 spawn（EPERM）。
    // 这里在**进程内**按同一形状复刻它：`createCoreClient`（走 HTTP /v1/*）+ `createMcpHandler`。
    // 因此它验证的是"stdio 适配器真正会走的那些请求"，而不是另造一条旁路。
    const stdioClient = createCoreClient(`http://127.0.0.1:${address.port}`, { credRef: auth.credentialRef, secret: auth.authValue, agent: "pilot-01", role: "reader" });
    const stdioHandler = createMcpHandler(stdioClient);
    async function stdioCall(name, args) {
      const message = await stdioHandler.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: { ...args } } });
      const text = message?.result?.content?.[0]?.text;
      assert.equal(typeof text, "string", JSON.stringify(message));
      assert.equal(message.result.isError, false, `stdio 工具报错：${text}`);
      return JSON.parse(text);
    }
    async function stdioSearch(extra) {
      const data = await stdioCall("memory_search", { since: DAY, until: DAY, limit: 100, ...extra });
      return {
        total: data.total_count,
        ids: (data.results ?? []).map((item) => item.id).sort(),
        resolvedRange: data.resolvedRange,
      };
    }

    const restResolve = async (extra) => {
      const r = await postRest("/v1/date/resolve", { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z", ...extra });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { timezone: r.body.timezone, range: r.body.range };
    };
    const mcpResolve = async (extra) => {
      const data = await callMcp("memory_resolve_date", { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z", ...extra });
      return { timezone: data.timezone, range: data.range };
    };

    return await fn({ restSearch, mcpSearch, stdioSearch, restResolve, mcpResolve });
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// 断言"窗口逐字一致"：三个字符串都必须完全相等
function assertSameWindow(a, b, label) {
  assert.equal(a.since, b.since, `${label}: since 必须逐字一致`);
  assert.equal(a.until, b.until, `${label}: until 必须逐字一致`);
  assert.equal(a.untilExclusive, b.untilExclusive, `${label}: untilExclusive 必须逐字一致`);
  assert.equal(a.calendarTimezone, b.calendarTimezone, `${label}: calendarTimezone 必须逐字一致`);
}

test("① 省略时区：REST == /mcp == stdio，窗口与条数逐字一致（配了 Asia/Shanghai）", async () => {
  await withServer({ calendarTimezone: TZ }, async ({ restSearch, mcpSearch, stdioSearch }) => {
    const rest = await restSearch({ since: DAY, until: DAY });
    const mcp = await mcpSearch({});
    const stdio = await stdioSearch({});

    assert.equal(rest.complete, true);
    assert.equal(rest.total, 3, "上海口径下这一天是 3 条");
    assert.deepEqual(mcp.ids, [...rest.ids].sort(), "/mcp 的条目集合必须与 REST 相同");
    assert.equal(mcp.total, rest.total, "/mcp 的条数必须与 REST 相同");
    assert.deepEqual(stdio.ids, [...rest.ids].sort(), "stdio 的条目集合必须与 REST 相同");
    assert.equal(stdio.total, rest.total, "stdio 的条数必须与 REST 相同");
    assertSameWindow(mcp.resolvedRange, rest.resolvedRange, "省略时区(/mcp)");
    assertSameWindow(stdio.resolvedRange, rest.resolvedRange, "省略时区(stdio)");
    // 具体窗口字符串：必须是上海本地日
    assert.equal(rest.resolvedRange.since, SH.since);
    assert.equal(rest.resolvedRange.until, SH.until);
    assert.equal(rest.resolvedRange.untilExclusive, SH.untilExclusive);
    assert.equal(rest.resolvedRange.calendarTimezone, TZ);
    // 判别性：裂缝里的两条必须在内（UTC 口径会掉出去）
    assert.equal(rest.ids.includes("sh-only-a"), true);
    assert.equal(rest.ids.includes("sh-only-b"), true);
    assert.equal(mcp.ids.includes("sh-only-a"), true, "/mcp 也必须能看到上海 10-07 00:30 的那条");
    assert.equal(stdio.ids.includes("sh-only-a"), true, "stdio 也必须能看到上海 10-07 00:30 的那条");
  });
});

test("② 省略 timezone：/v1/date/resolve == memory_resolve_date（窗口与 timezone 逐字一致）", async () => {
  await withServer({ calendarTimezone: TZ }, async ({ restResolve, mcpResolve }) => {
    const rest = await restResolve({});
    const mcp = await mcpResolve({});

    assert.equal(rest.timezone, TZ);
    assert.equal(mcp.timezone, rest.timezone, "memory_resolve_date 省略 timezone 必须与 REST 同默认");
    assert.equal(mcp.range.since, rest.range.since);
    assert.equal(mcp.range.untilExclusive, rest.range.untilExclusive);
    assert.equal(rest.range.since, "2026-10-09T16:00:00.000Z", "必须是上海本地 10-10，不是 UTC 日");
    assert.equal(rest.range.untilExclusive, "2026-10-10T16:00:00.000Z");
  });
});

test("③ 显式传时区：三入口一致，且**覆盖**部署默认", async () => {
  await withServer({ calendarTimezone: TZ }, async ({ restSearch, mcpSearch, stdioSearch }) => {
    // 部署默认是上海，这里显式要 UTC ⇒ 必须拿到 UTC 的窗口（覆盖默认）
    const rest = await restSearch({ since: DAY, until: DAY, calendarTimezone: "UTC" });
    const mcp = await mcpSearch({ calendarTimezone: "UTC" });
    const stdio = await stdioSearch({ calendarTimezone: "UTC" });

    assert.equal(rest.resolvedRange.calendarTimezone, "UTC", "显式时区必须覆盖部署默认");
    assert.equal(rest.resolvedRange.since, UTC.since);
    assert.equal(rest.resolvedRange.untilExclusive, UTC.untilExclusive);
    assert.equal(rest.total, 1, "UTC 口径下这一天只有 both 一条");
    assert.equal(mcp.total, rest.total, "显式时区时 /mcp 与 REST 条数必须一致");
    assert.equal(stdio.total, rest.total, "显式时区时 stdio 与 REST 条数必须一致");
    assert.deepEqual(mcp.ids, [...rest.ids].sort());
    assert.deepEqual(stdio.ids, [...rest.ids].sort());
    assertSameWindow(mcp.resolvedRange, rest.resolvedRange, "显式时区(/mcp)");
    assertSameWindow(stdio.resolvedRange, rest.resolvedRange, "显式时区(stdio)");

    // 显式上海：三入口同样一致，且回到 3 条
    const restSh = await restSearch({ since: DAY, until: DAY, calendarTimezone: TZ });
    const mcpSh = await mcpSearch({ calendarTimezone: TZ });
    const stdioSh = await stdioSearch({ calendarTimezone: TZ });
    assert.equal(restSh.total, 3);
    assert.equal(mcpSh.total, 3);
    assert.equal(stdioSh.total, 3);
    assertSameWindow(mcpSh.resolvedRange, restSh.resolvedRange, "显式上海(/mcp)");
    assertSameWindow(stdioSh.resolvedRange, restSh.resolvedRange, "显式上海(stdio)");
  });
});

test("④ 未配置部署默认时区：三入口一致地回落到 UTC", async () => {
  await withServer({}, async ({ restSearch, mcpSearch, stdioSearch, restResolve, mcpResolve }) => {
    const rest = await restSearch({ since: DAY, until: DAY });
    const mcp = await mcpSearch({});
    const stdio = await stdioSearch({});

    assert.equal(rest.resolvedRange.calendarTimezone, "UTC", "未配置时必须回落 UTC");
    assert.equal(rest.resolvedRange.since, UTC.since);
    assert.equal(rest.resolvedRange.untilExclusive, UTC.untilExclusive);
    assert.equal(rest.total, 1);
    assert.equal(mcp.total, rest.total, "未配置时 /mcp 也必须回落 UTC");
    assert.equal(stdio.total, rest.total, "未配置时 stdio 也必须回落 UTC");
    assertSameWindow(mcp.resolvedRange, rest.resolvedRange, "未配置(/mcp)");
    assertSameWindow(stdio.resolvedRange, rest.resolvedRange, "未配置(stdio)");

    const rResolve = await restResolve({});
    const mResolve = await mcpResolve({});
    assert.equal(rResolve.timezone, "UTC");
    assert.equal(mResolve.timezone, "UTC", "未配置时 memory_resolve_date 也必须回落 UTC");
    assert.equal(mResolve.range.since, rResolve.range.since);
    assert.equal(mResolve.range.since, "2026-10-10T00:00:00.000Z");
  });
});
