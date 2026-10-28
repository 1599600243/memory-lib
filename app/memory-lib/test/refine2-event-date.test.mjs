// REFINE-LOOP-2：记忆必须落在**事件日**，不能落在"提炼时刻"。
// 这一组锁的是库侧的两件事：
//   ① 写入器收到 calendarDate 就物化它；没收到就不写这一行（既有调用方字节不变）；
//   ② 按天查询（timeline / search 的 calendarDate）分档用**事件轴**（capturedAt → occurred_at），
//      不用 updated_at —— 后者是"记录什么时候被写/被改"，提炼产物写入时就是提炼时刻。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { eventClockValue, timestampValue } from "../src/time-util.mjs";

const roots = [];
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refine2-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "curated", "shared"), { recursive: true });
  await fs.mkdir(path.join(root, "evidence", "conversations"), { recursive: true });
  return root;
}
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

// 直接落一条记忆文件，精确控制两条时间轴
async function writeMemoryFile(root, { id, occurredAt, updatedAt, calendarDate = null, body = "一条记忆。" }) {
  const lines = [
    "---",
    `id: "${id}"`,
    `layer: "long-term"`,
    `container: "long-term"`,
    `visibility: "platform"`,
    `type: "memory"`,
    `status: "active"`,
    ...(calendarDate ? [`calendarDate: ${JSON.stringify(calendarDate)}`] : []),
    `occurred_at: ${JSON.stringify(occurredAt)}`,
    `valid_from: ${JSON.stringify(occurredAt)}`,
    `valid_to: null`,
    `updated_at: ${JSON.stringify(updatedAt)}`,
    `supersedes: []`,
    `superseded_by: null`,
    `tags: ["refined","fact"]`,
    `evidence_refs: ["ev-1#turn-1"]`,
    `tenant_id: "default"`,
    `group_id: "unknown"`,
    `user_id: "unknown"`,
    `agent_id: "admin-01"`,
    `role_id: "librarian-admin"`,
    "---",
    "",
    body,
  ];
  await fs.writeFile(path.join(root, "curated", "shared", `${id}.md`), lines.join("\n"), "utf8");
}

function makeLib(root) {
  return createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), scopes: null, calendarTimezone: "Asia/Shanghai", vectorLane: { probe: false } });
}

test("eventClockValue：事件轴优先（capturedAt → occurred_at → valid_from），updated_at 只作兜底", () => {
  const fm = { occurred_at: "2026-10-04T02:00:00.000Z", valid_from: "2026-10-04T02:00:00.000Z", updated_at: "2026-10-19T05:00:00.000Z" };
  assert.equal(eventClockValue(fm).field, "occurred_at", "有事件字段时不许拿 updated_at 当事件时刻");
  assert.equal(eventClockValue(fm).value, Date.parse("2026-10-04T02:00:00.000Z"));
  assert.equal(eventClockValue({ capturedAt: "2026-10-03T16:00:00.000Z", occurred_at: "2026-10-04T02:00:00.000Z" }).field, "capturedAt", "capturedAt 最优先");
  // 只有 updated_at 时才退回它（既有行为不变）
  assert.equal(eventClockValue({ updated_at: "2026-10-19T05:00:00.000Z" }).field, "updated_at");
  // timestampValue 仍以 updated_at 优先（排序/新鲜度语义不变）
  assert.equal(timestampValue(fm).field, "updated_at");
});

test("timeline 按事件日分档：occurred_at 那天能查到，updated_at（提炼那天）查不到", async () => {
  const root = await makeRoot();
  // 事件发生在 10-04（上海 10:00），但记忆是 10-19 写的
  await writeMemoryFile(root, { id: "m-event-1004", occurredAt: "2026-10-04T02:00:00.000Z", updatedAt: "2026-10-19T05:00:00.000Z", calendarDate: "2026-10-04", body: "关于 10-04 的事。" });
  const lib = makeLib(root);
  const onEventDay = await lib.timeline({ limit: 10, calendarDate: "2026-10-04", calendarTimezone: "Asia/Shanghai" });
  assert.equal(onEventDay.total_count, 1, "事件日必须能查到这条记忆");
  assert.equal(onEventDay.results[0].id, "m-event-1004");
  const onWriteDay = await lib.timeline({ limit: 10, calendarDate: "2026-10-19", calendarTimezone: "Asia/Shanghai" });
  assert.equal(onWriteDay.total_count, 0, "提炼那天不许出现（这就是「问 10-19 多出 652 条」的根因）");
});

test("同一瞬时在不同时区属于不同事件日（不许硬编码 +8）", async () => {
  const root = await makeRoot();
  // 10-04 22:00 上海 == 10-04 14:00 UTC → UTC 视角仍是 10-04；换一个更靠东的日界线场景：
  await writeMemoryFile(root, { id: "m-tz", occurredAt: "2026-10-04T16:30:00.000Z", updatedAt: "2026-10-19T05:00:00.000Z" });
  const lib = makeLib(root);
  const shanghai = await lib.timeline({ limit: 10, calendarDate: "2026-10-05", calendarTimezone: "Asia/Shanghai" });
  assert.equal(shanghai.total_count, 1, "上海视角：16:30Z 已是 10-05");
  const utc = await lib.timeline({ limit: 10, calendarDate: "2026-10-04", calendarTimezone: "UTC" });
  assert.equal(utc.total_count, 1, "UTC 视角：同一瞬时仍是 10-04");
});

test("since/until 时间范围也走事件轴（itemTimeRange 不是 updated_at）", async () => {
  const root = await makeRoot();
  await writeMemoryFile(root, { id: "m-range", occurredAt: "2026-10-04T02:00:00.000Z", updatedAt: "2026-10-19T05:00:00.000Z", calendarDate: "2026-10-04", body: "范围测试。" });
  const lib = makeLib(root);
  const inEventRange = await lib.timeline({ limit: 10, since: "2026-10-04T00:00:00.000Z", until: "2026-10-04T23:59:59.999Z", calendarTimezone: "Asia/Shanghai" });
  assert.equal(inEventRange.total_count, 1, "事件时刻落在范围里就必须返回");
  const inWriteRange = await lib.timeline({ limit: 10, since: "2026-10-19T00:00:00.000Z", until: "2026-10-19T23:59:59.999Z", calendarTimezone: "Asia/Shanghai" });
  assert.equal(inWriteRange.total_count, 0, "仅 updated_at 落在范围里不许返回");
});

test("写入器：给了 calendarDate 就物化；没给就不写这一行（既有调用方字节不变）", async () => {
  const root = await makeRoot();
  const writer = createMemoryWriter({ dataRoot: root });
  const principal = { agent_id: "admin-01", role_id: "librarian-admin", group_id: "g1", user_id: "u1" };
  const withDate = await writer.write({
    layer: "curated-shared", id: "with-date", body: "带事件日的记忆。", evidence_refs: ["ev-1#turn-1"], principal,
    occurred_at: "2026-10-04T02:00:00.000Z", valid_from: "2026-10-04T02:00:00.000Z", calendarDate: "2026-10-04",
  });
  const textWith = await fs.readFile(withDate.path, "utf8");
  assert.match(textWith, /^calendarDate: "2026-10-04"$/mu, "calendarDate 必须物化进 frontmatter");
  assert.match(textWith, /^occurred_at: "2026-10-04T02:00:00\.000Z"$/mu, "occurred_at 用事件时刻");
  const updated = /^updated_at: "(.*)"$/mu.exec(textWith)?.[1];
  assert.ok(updated && updated !== "2026-10-04T02:00:00.000Z", "updated_at 仍是写入时刻（两条时间轴分开）");

  const withoutDate = await writer.write({ layer: "curated-shared", id: "without-date", body: "没给事件日。", evidence_refs: ["ev-2#turn-1"], principal });
  const textWithout = await fs.readFile(withoutDate.path, "utf8");
  assert.doesNotMatch(textWithout, /calendarDate/u, "没传 calendarDate 就完全不出现这一行（既有文件字节不变）");
});

test("写进库的记忆能被 timeline 按事件日捞回（端到端：写入器 + 按天查询）", async () => {
  const root = await makeRoot();
  const writer = createMemoryWriter({ dataRoot: root });
  const principal = { agent_id: "admin-01", role_id: "librarian-admin", group_id: "g1", user_id: "u1" };
  await writer.write({
    layer: "curated-shared", id: "e2e", body: "端到端：事件发生在 10-04。", evidence_refs: ["ev-1#turn-1"], principal,
    occurred_at: "2026-10-04T02:00:00.000Z", valid_from: "2026-10-04T02:00:00.000Z", calendarDate: "2026-10-04",
  });
  const lib = makeLib(root);
  const page = await lib.timeline({ limit: 10, calendarDate: "2026-10-04", calendarTimezone: "Asia/Shanghai" });
  assert.equal(page.total_count, 1);
  assert.equal(page.results[0].calendarDate, "2026-10-04", "对外也如实回显物化的事件日");
});
