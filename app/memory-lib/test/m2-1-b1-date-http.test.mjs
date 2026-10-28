// M2.1-B1 端到端：经**真实 HTTP 入口**把「10/10 我们聊了什么」变成范围，再用**已有的按天枚举**
// 把那一整天取全。
//
// 为什么必须有这一层（接线门）：`resolveDateText()` 直调只证明纯函数对；
// 本单要的是"这条链走得通" —— 解析出的范围必须是既有按天枚举**真正认得的输入**，
// 且取回的是**完整**的一天，不是 top-N 里随缘的几条。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 那一天的对话条数 —— 与产品岗在生产库实测的「2026-10-10 = 9 条」同量级，
// 本测试用自造 fixture 复现同一形状，另见报告里的真实库只读读数。
const DAY_COUNT = 9;

function conversation(id, capturedAt) {
  return ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, 'groupId: "group-b1"', 'userId: "user-b1"', "---", "", `excerpt for ${id}`].join("\n");
}

test("「10/10 我们聊了什么」resolves over HTTP and enumerates the whole local day", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-b1-e2e-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversationRoot = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversationRoot, { recursive: true });

  // 上海本地 2026-10-10 00:00 .. 23:59 之间的 9 条（UTC 跨 10-09T16:00Z .. 10-10T15:59Z）。
  const capturedAtList = [
    "2026-10-09T16:00:00.000Z", // 本地 10-10 00:00（边界，含）
    "2026-10-09T22:00:00.000Z", // 本地 10-10 06:00
    "2026-10-10T00:00:00.000Z", // 本地 10-10 08:00
    "2026-10-10T02:00:00.000Z", // 本地 10-10 10:00
    "2026-10-10T04:00:00.000Z", // 本地 10-10 12:00
    "2026-10-10T06:00:00.000Z", // 本地 10-10 14:00
    "2026-10-10T08:00:00.000Z", // 本地 10-10 16:00
    "2026-10-10T12:00:00.000Z", // 本地 10-10 20:00
    "2026-10-10T15:59:59.999Z", // 本地 10-10 23:59:59.999（边界，含）
  ];
  assert.equal(capturedAtList.length, DAY_COUNT);
  for (const [index, capturedAt] of capturedAtList.entries()) {
    await fs.writeFile(path.join(conversationRoot, `day-${String(index).padStart(2, "0")}.md`), conversation(`day-${index}`, capturedAt), "utf8");
  }
  // 前一天/后一天各一条，落在半开区间之外 —— 用来证明"取全"不是"多取"。
  await fs.writeFile(path.join(conversationRoot, "outside-before.md"), conversation("outside-before", "2026-10-09T15:59:59.999Z"), "utf8");
  await fs.writeFile(path.join(conversationRoot, "outside-after.md"), conversation("outside-after", "2026-10-10T16:00:00.000Z"), "utf8");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "group-b1";
  researcher.user_id = "user-b1";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

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
    calendarTimezone: "Asia/Shanghai",
    // 与 localhost-server 第 866 行同形状：agentId/roleId 由已验证身份注入。
    // 少传 agentId 会让 self-root 兜底失效，静默漏掉角色记忆。
    libFactory: ({ scopes, agentId, roleId, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, roleId, principal, vectorLane: { probe: false } }),
  });

  try {
    const address = await server.listen();
    const authBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };
    async function post(route, body) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...authBody, ...body }),
      });
      return { status: response.status, body: await response.json() };
    }

    // ── 第一跳：人话 → 范围（纯规则，零模型） ──
    const now = "2026-10-10T01:00:00.000Z"; // 上海本地 10-10 09:00
    const resolved = await post("/v1/date/resolve", { text: "10/10 我们聊了什么", now, timezone: "Asia/Shanghai" });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.ok, true);
    assert.equal(resolved.body.calendarDate, "2026-10-10");
    assert.equal(resolved.body.yearInferred, true, "10/10 has no year, so it must be flagged");
    assert.equal(resolved.body.timezone, "Asia/Shanghai");
    assert.equal(resolved.body.range.since, "2026-10-09T16:00:00.000Z");
    assert.equal(resolved.body.range.untilExclusive, "2026-10-10T16:00:00.000Z");

    // ── 第二跳：用解析出的范围调**已有的按天枚举**，把那天取全 ──
    const collected = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await post("/v1/search", {
        query: "",
        calendarDate: resolved.body.calendarDate,
        calendarTimezone: resolved.body.timezone,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.resolvedRange.calendarDate, "2026-10-10");
      assert.equal(page.body.resolvedRange.calendarTimezone, "Asia/Shanghai");
      collected.push(...(page.body.results ?? []).map((item) => item.id));
      cursor = page.body.nextCursor;
      pages += 1;
      assert.ok(pages < 10, "traversal must terminate");
    } while (cursor);

    // 完整性：那天的 9 条一条不少、一条不多。
    assert.equal(pages, 3, "9 entries at limit 3 must take exactly 3 pages");
    assert.equal(collected.length, DAY_COUNT, `expected the whole day (${DAY_COUNT}), got ${collected.length}: ${collected.join(",")}`);
    assert.deepEqual([...collected].sort(), capturedAtList.map((_, index) => `day-${index}`).sort());
    assert.equal(new Set(collected).size, collected.length, "no duplicates");

    // 半开区间的两个端点：前一日最后 1ms 与次日第 0ms 都不属于"10/10"。
    assert.equal(collected.includes("outside-before"), false, "the previous day's last instant must not leak in");
    assert.equal(collected.includes("outside-after"), false, "the next day's first instant must not leak in");

    // ── 等价性：用 since/until 走同一条链，结果必须一致（两个入口一个答案） ──
    const byRange = await post("/v1/search", {
      query: "",
      since: resolved.body.range.since,
      until: resolved.body.range.inclusiveEnd,
      limit: 100,
    });
    assert.equal(byRange.status, 200);
    assert.deepEqual(
      (byRange.body.results ?? []).map((item) => item.id).sort(),
      [...collected].sort(),
      "calendarDate and the equivalent since/until must return the same set",
    );

    // ── 失败路径：解析不了必须明确失败，且**没有 range**，不能被当 wildcard ──
    const unresolved = await post("/v1/date/resolve", { text: "随便聊聊", now, timezone: "Asia/Shanghai" });
    assert.equal(unresolved.status, 422);
    assert.equal(unresolved.body.ok, false);
    assert.equal(unresolved.body.reason, "no-match");
    assert.equal(unresolved.body.range, undefined, "a failure must not carry a range");

    // ── 硬规则：缺 now 必须拒绝（平台不猜"现在"） ──
    const missingNow = await post("/v1/date/resolve", { text: "10/10", timezone: "Asia/Shanghai" });
    assert.equal(missingNow.status, 400);
    assert.match(missingNow.body.error.message, /now is required/u);

    // ── 歧义：locale 未知时给候选，不许替用户选、不许合并两天 ──
    const ambiguous = await post("/v1/date/resolve", { text: "10/11", now, timezone: "Asia/Shanghai", locale: null });
    assert.equal(ambiguous.status, 422);
    assert.equal(ambiguous.body.reason, "ambiguous");
    assert.equal(ambiguous.body.ambiguous.candidates.length, 2);
    assert.equal(ambiguous.body.range, undefined, "an ambiguous answer must never be merged into one query");

    // ── 真实日历校验：2/30 必须失败，不许滚到 3 月 ──
    const rolled = await post("/v1/date/resolve", { text: "2/30", now, timezone: "Asia/Shanghai" });
    assert.equal(rolled.status, 422);
    assert.equal(rolled.body.reason, "invalid-date");
    assert.equal(rolled.body.calendarDate, undefined);

    // ── 重放：同一请求必须得到同一范围（可审计） ──
    const replay = await post("/v1/date/resolve", { text: "10/10 我们聊了什么", now, timezone: "Asia/Shanghai" });
    assert.deepEqual(replay.body.range, resolved.body.range);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
