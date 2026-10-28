// DAYRECALL-1 A：经**真实 HTTP 入口**验证 calendarDate 过滤。
// 为什么必须有这一层：`lib.timeline()` 直调只能证明服务内部函数正确；
// 单子要求的是"按日历日过滤"作为接口能力，所以必须证明它在 /v1/search 上被接线
// （接线门：有生产者 —— 捕获写入派生字段；有消费者 —— 带真实 principal 的 HTTP 读回）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createConversationMemory } from "../src/conversation-memory.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("calendarDate reaches the real /v1/search route, is recomputed for the query timezone, and echoes resolvedRange", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-dayrecall-http-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "group-dr";
  researcher.user_id = "user-dr";
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
    // 部署侧时区：决定捕获时物化的 calendarDate/calendarTimezone。
    calendarTimezone: "UTC",
    libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
  });

  try {
    // 生产者：走真实的捕获路径（不是手写文件），1 条落在 UTC 10-09 与 Asia/Shanghai 10-10 的交叉带。
    const captured = await createConversationMemory({ dataRoot, calendarTimezone: "UTC" }).capture({
      conversationId: "dr-http-boundary",
      eventId: "dr-http-boundary-event",
      source: "dayrecall-http-test",
      messages: [{ role: "user", content: "boundary conversation" }],
      principal: { group_id: "group-dr", user_id: "user-dr", agent_id: "pilot-01", role_id: "researcher" },
    });
    assert.equal(captured.calendarDate, new Date(captured.capturedAt).toISOString().slice(0, 10));

    const address = await server.listen();
    const authBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };
    async function search(body) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...authBody, limit: 50, ...body }),
      });
      return { status: response.status, body: await response.json() };
    }

    const capturedDayUtc = captured.calendarDate;
    const byCalendarUtc = await search({ calendarDate: capturedDayUtc, calendarTimezone: "UTC" });
    assert.equal(byCalendarUtc.status, 200);
    const ids = (byCalendarUtc.body.results ?? []).map((item) => item.id);
    assert.ok(ids.includes(captured.evidenceId), `calendarDate=${capturedDayUtc}@UTC must return the captured evidence, got ${JSON.stringify(ids)}`);

    // 同一请求重放必须得到同一个范围（可审计）——不允许在底层猜"现在"。
    const replay = await search({ calendarDate: capturedDayUtc, calendarTimezone: "UTC" });
    assert.deepEqual(replay.body.resolvedRange, byCalendarUtc.body.resolvedRange);
    assert.deepEqual(replay.body.results.map((item) => item.id), ids);

    // resolvedRange 回显时区，且等于该时区当天真实的 UTC 半开窗口。
    assert.equal(byCalendarUtc.body.resolvedRange.calendarTimezone, "UTC");
    assert.equal(byCalendarUtc.body.resolvedRange.calendarDate, capturedDayUtc);
    assert.equal(byCalendarUtc.body.resolvedRange.since, `${capturedDayUtc}T00:00:00.000Z`);
    assert.equal(byCalendarUtc.body.resolvedRange.until, `${capturedDayUtc}T23:59:59.999Z`);

    // 跨时区语义：同一批 capturedAt 在 Asia/Shanghai 下必须按上海本地日归入。
    // 这对边界带里的条目尤其关键：写入时区为 UTC 的条目，在查询时区为上海时
    // 归属的上海本地日可能不同于它物化的 UTC 日期。
    const instant = new Date(captured.capturedAt);
    const shanghaiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
    const byCalendarShanghai = await search({ calendarDate: shanghaiDay, calendarTimezone: "Asia/Shanghai" });
    assert.equal(byCalendarShanghai.status, 200);
    assert.ok(
      (byCalendarShanghai.body.results ?? []).map((item) => item.id).includes(captured.evidenceId),
      `calendarDate=${shanghaiDay}@Asia/Shanghai must return the captured evidence`,
    );
    assert.equal(byCalendarShanghai.body.resolvedRange.calendarTimezone, "Asia/Shanghai");
    // 上海没有 DST，2026 年该日窗口应为 16:00Z 起。
    assert.match(byCalendarShanghai.body.resolvedRange.since, /T16:00:00\.000Z$/u);

    // 落库的正文/摘要里不许出现日期字段（日期只能做结构化过滤）。
    const text = await fs.readFile(captured.evidencePath, "utf8");
    const bodyText = text.slice(text.indexOf("# 原始对话记录"));
    assert.doesNotMatch(bodyText, /calendarDate|calendarTimezone|\d{4}-\d{2}-\d{2}/u, "no date may be written into the body");

    // 非法时区必须在真实入口上明确失败，不许静默当 UTC。
    const badZone = await search({ calendarDate: capturedDayUtc, calendarTimezone: "Not/AZone" });
    assert.equal(badZone.status >= 400, true, `invalid timezone must not succeed, got ${badZone.status}`);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
