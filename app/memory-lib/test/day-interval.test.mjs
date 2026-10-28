// DAY-INTERVAL-1：统一「一天」的语义 —— `{since,until}` 纯日期 ≡ `{calendarDate}`。
//
// 背景（产品岗在 DAYRECALL-1 复核里留下的契约债）：
//   入口 A  `since/until` 纯日期 → 旧实现把 `until` 补成 `23:59:59.999`（**闭**尾端），
//           而且纯日期一律按 **UTC** 日解释（`calendarTimezone` 根本不参与）。
//   入口 B  `calendarDate + calendarTimezone` → 半开 `[startOfDay, nextDayStartOfDay)`，按**本地日**。
//   毫秒精度下今天结果常常相同（所以功能"看起来没问题"），但**语义随输入形态变化**：
//   调用方无法推理"until 到底含不含当天"，而研究结论明确要求统一成半开 `[start, end)`，
//   且**不许**用 `23:59:59.999`（精度迁移 / DST / 月长都会踩）。
//
// 本文件先把**等价性**与**边界四条**写成会失败的测试，再改实现。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryLib } from "../src/memory-lib.mjs";

// 夹具：同一个 UTC 瞬时在不同时区属于不同的本地日，所以每个时区都要单独验。
// 上海 = UTC+8：本地 10-10 00:30 = 10-09T16:30Z；本地 10-10 23:30 = 10-10T15:30Z。
const FIXTURES = [
  ["prev-local-2330", "2026-10-09T15:30:00.000Z", "本地 10-09 23:30（前一日）"],
  ["local-0000", "2026-10-09T16:00:00.000Z", "本地 10-10 00:00:00.000（当天第一毫秒）"],
  ["local-0030", "2026-10-09T16:30:00.000Z", "本地 10-10 00:30"],
  ["local-1200", "2026-10-10T04:00:00.000Z", "本地 10-10 12:00"],
  ["local-2330", "2026-10-10T15:30:00.000Z", "本地 10-10 23:30"],
  ["local-lastms", "2026-10-10T15:59:59.999Z", "本地 10-10 23:59:59.999（当天最后一毫秒）"],
  ["next-local-0000", "2026-10-10T16:00:00.000Z", "本地 10-11 00:00:00.000（次日第一毫秒 → 必须在外）"],
  ["next-local-0030", "2026-10-10T16:30:00.000Z", "本地 10-11 00:30（次日 → 必须在外）"],
];

async function buildLib(timezone, files = FIXTURES) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "day-interval-"));
  const root = path.join(tmp, "evidence", "conversations");
  await fs.mkdir(root, { recursive: true });
  for (const [id, capturedAt] of files) {
    await fs.writeFile(path.join(root, `${id}.md`), [
      "---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`,
      'groupId: "g"', 'userId: "u"', "---", "", `body ${id}`,
    ].join("\n"), "utf8");
  }
  const lib = createMemoryLib({
    dataRoot: tmp, workspaceRoot: tmp,
    principal: { group_id: "g", user_id: "u" },
    resolvedRoots: [root], vectorLane: { probe: false },
  });
  return { lib, tmp, timezone };
}

async function ids(lib, options) {
  const page = await lib.timeline({ limit: 100, ...options });
  return { ids: (page.results ?? []).map((item) => item.id), resolvedRange: page.resolvedRange };
}

// ─────────────────── 核心判据：两条入口必须给出同一个答案 ───────────────────

test("bare since/until is EXACTLY equivalent to calendarDate, in the same timezone", async () => {
  for (const timezone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
    const { lib, tmp } = await buildLib(timezone);
    try {
      const byRange = await ids(lib, { since: "2026-10-10", until: "2026-10-10", calendarTimezone: timezone });
      const byCalendar = await ids(lib, { calendarDate: "2026-10-10", calendarTimezone: timezone });
      assert.deepEqual(byRange.ids, byCalendar.ids, `${timezone}: 集合与**顺序**都必须一致`);
      assert.ok(byRange.ids.length > 0, `${timezone}: 夹具非空，等价性才有判别力`);
      // 解析出的**绝对范围**也必须一致 —— 否则"同结果"只是巧合。
      // 只比"真正生效的窗口"四个字段：`calendarDate` 是输入回显（入口 B 才有），
      // 不属于窗口语义，所以刻意不参与比较（这是有意的，不是为了让测试过）。
      const window = (range) => ({ since: range.since, until: range.until, untilExclusive: range.untilExclusive, calendarTimezone: range.calendarTimezone });
      assert.deepEqual(window(byRange.resolvedRange), window(byCalendar.resolvedRange), `${timezone}: 生效窗口必须逐字节一致`);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }
});

test("bare dates are interpreted in the LOCAL day of calendarTimezone, not the UTC day", async () => {
  // 上海本地 10-10 = [10-09T16:00Z, 10-10T16:00Z)。若仍按 UTC 日解释，
  // 这条必然红：local-0030（本地 00:30）会被排除，而 next-local-0030（次日）会被纳入。
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    const { ids: got, resolvedRange } = await ids(lib, { since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai" });
    assert.deepEqual(got, ["local-0000", "local-0030", "local-1200", "local-2330", "local-lastms"]);
    assert.equal(resolvedRange.since, "2026-10-09T16:00:00.000Z");
    // 对外统一成闭口径 `until`（当天最后一毫秒）+ 独立排他上界 `untilExclusive`（次日零点）。
    // 两者是**同一段时间**的两种写法，相差正好 1ms。
    assert.equal(resolvedRange.until, "2026-10-10T15:59:59.999Z", "闭口径：当天最后一毫秒");
    assert.equal(resolvedRange.untilExclusive, "2026-10-10T16:00:00.000Z", "排他上界：次日零点");
    assert.equal(Date.parse(resolvedRange.untilExclusive) - Date.parse(resolvedRange.until), 1);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────── 边界四条（产品岗点名要求） ───────────────────

test("boundaries: local 00:30 and 23:30 are IN; the neighbours on both sides are OUT", async () => {
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    const { ids: got } = await ids(lib, { calendarDate: "2026-10-10", calendarTimezone: "Asia/Shanghai" });
    // 在内
    assert.ok(got.includes("local-0000"), "本地 00:00:00.000 必须在（半开区间含起点）");
    assert.ok(got.includes("local-0030"), "本地 00:30 必须在");
    assert.ok(got.includes("local-2330"), "本地 23:30 必须在");
    assert.ok(got.includes("local-lastms"), "本地 23:59:59.999 必须在（半开区间最后一个毫秒）");
    // 在外（两侧邻居都要有）
    assert.equal(got.includes("prev-local-2330"), false, "前一日本地 23:30 必须在**外**");
    assert.equal(got.includes("next-local-0000"), false, "次日第一毫秒必须在**外**（这正是半开与闭尾端的差别）");
    assert.equal(got.includes("next-local-0030"), false, "次日 00:30 必须在**外**");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("the same four boundary rules hold for the bare since/until entry", async () => {
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    const { ids: got } = await ids(lib, { since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai" });
    for (const id of ["local-0000", "local-0030", "local-2330", "local-lastms"]) {
      assert.ok(got.includes(id), `${id} 必须在（两条入口同一套边界）`);
    }
    for (const id of ["prev-local-2330", "next-local-0000", "next-local-0030"]) {
      assert.equal(got.includes(id), false, `${id} 必须在**外**（两条入口同一套边界）`);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────── 带时刻的上界仍是"瞬时上界" ───────────────────

test("an until WITH a time is still an instant upper bound, unchanged", async () => {
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    // 显式时刻：含或不含由"≤"决定，但**不**做任何按天的扩张。
    const { ids: got } = await ids(lib, { since: "2026-10-09T16:00:00.000Z", until: "2026-10-10T04:00:00.000Z" });
    assert.ok(got.includes("local-0000"));
    assert.ok(got.includes("local-1200"), "上界是本地 12:00，含该瞬时");
    assert.equal(got.includes("local-2330"), false, "本地 23:30 晚于上界，必须在外");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("since with a bare date is inclusive of its own local first millisecond", async () => {
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    const { ids: got, resolvedRange } = await ids(lib, { since: "2026-10-10", calendarTimezone: "Asia/Shanghai" });
    assert.equal(resolvedRange.since, "2026-10-09T16:00:00.000Z");
    assert.ok(got.includes("local-0000"), "since 含当天的第一毫秒");
    assert.equal(got.includes("prev-local-2330"), false);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────── resolvedRange 必须回显（可审计） ───────────────────

test("resolvedRange is echoed for explicit since/until too, so callers need not guess", async () => {
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    const page = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai", limit: 5 });
    assert.ok(page.resolvedRange, "显式 since/until 也要回显解析后的绝对范围");
    assert.equal(page.resolvedRange.since, "2026-10-09T16:00:00.000Z");
    assert.equal(page.resolvedRange.until, "2026-10-10T15:59:59.999Z", "闭口径：当天最后一毫秒");
    assert.equal(page.resolvedRange.untilExclusive, "2026-10-10T16:00:00.000Z", "半开真值：次日零点");
    assert.equal(page.resolvedRange.calendarTimezone, "Asia/Shanghai");
    // 带时刻的输入按原样回显（不做按天扩张）
    const timed = await lib.timeline({ since: "2026-10-10T00:00:00.000Z", until: "2026-10-10T06:00:00.000Z", limit: 5 });
    assert.equal(timed.resolvedRange.since, "2026-10-10T00:00:00.000Z");
    assert.equal(timed.resolvedRange.until, "2026-10-10T06:00:00.000Z");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("hard rule: the half-open bound is never built from 23:59:59.999 for a bare date", async () => {
  const { lib, tmp } = await buildLib("Asia/Shanghai");
  try {
    for (const timezone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      const { resolvedRange } = await ids(lib, { since: "2026-10-10", until: "2026-10-10", calendarTimezone: timezone });
      // 半开区间的**真值**是 untilExclusive；它必须来自"次日**本地**零点"，
      // 不许由 23:59:59.999 派生。
      // （对外回显的闭口径 `until` 按定义就是最后一毫秒 —— 那是**派生**值，不是边界真值。）
      assert.doesNotMatch(String(resolvedRange.untilExclusive), /23:59:59\.999/u, `${timezone}: 排他上界不许由 23:59:59.999 派生`);
      assert.equal(Date.parse(resolvedRange.untilExclusive) - Date.parse(resolvedRange.until), 1, `${timezone}: 闭/开两种写法相差正好 1ms`);
      // 语义判据（不依赖 ISO 形状）：把上界换算到该时区，必须正好是**次日 00:00:00**。
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(resolvedRange.untilExclusive));
      const get = (type) => local.find((part) => part.type === type).value;
      assert.equal(`${get("hour")}:${get("minute")}:${get("second")}`, "00:00:00", `${timezone}: 排他上界必须是本地零点`);
      assert.equal(`${get("year")}-${get("month")}-${get("day")}`, "2026-10-11", `${timezone}: 且必须是**次日**的零点`);
    }
    // 夏令时日长不是 24 小时：美西 2026-03-08 是 23 小时 —— 半开区间必须仍然正确。
    const dstFixtures = [["dst-first", "2026-03-08T08:00:00.000Z"], ["dst-inside", "2026-03-08T20:00:00.000Z"], ["dst-next", "2026-03-09T07:00:00.000Z"]];
    const { lib: dstLib, tmp: dstTmp } = await buildLib("America/Los_Angeles", dstFixtures);
    try {
      const { ids: dstIds, resolvedRange } = await ids(dstLib, { since: "2026-03-08", until: "2026-03-08", calendarTimezone: "America/Los_Angeles" });
      assert.equal((Date.parse(resolvedRange.untilExclusive) - Date.parse(resolvedRange.since)) / 3_600_000, 23, "春季调时那天只有 23 小时");
      assert.deepEqual(dstIds, ["dst-first", "dst-inside"]);
    } finally { await fs.rm(dstTmp, { recursive: true, force: true }); }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
