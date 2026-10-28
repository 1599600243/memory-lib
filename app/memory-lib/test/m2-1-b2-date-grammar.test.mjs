// M2.1-B2：更开放的时间表达（**仍然是纯规则、零模型**）。
//
// 先写、先跑红：这些表达在 M2.1-B1 上会**明确失败**（那是对的，但不够用）。
// 本单要覆盖：N天前 / 大前天 / 上上周 / 近N周 / 最近N天 / 上个月N号 / 近N个月 /
// 区间（上周一到上周三、10月1号到10月7号）/ 未来（明天·后天·下周三）/ 口语尾巴（…那天）。
//
// 沿用 M2.1-B1 的全部硬规则（半开区间、日历运算、严格校验、时区集中、now 显式、歧义给候选）。
//
// 锚点刻意选 **2026-10-12（周一）**：周内第一天，周/月/日三种边界同时可判别。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveDateText, resolveDateRangeText, listSupportedDateExpressions } from "../src/date-query.mjs";

const NOW = "2026-10-12T04:00:00.000Z"; // 上海本地 2026-10-12（周一）12:00
const TZ = "Asia/Shanghai";

function resolve(text, extra = {}) {
  return resolveDateText({ text, now: NOW, timezone: TZ, ...extra });
}
function ok(text, extra = {}) {
  const result = resolve(text, extra);
  assert.equal(result.ok, true, `expected "${text}" to resolve, got: ${JSON.stringify(result)}`);
  return result;
}
function fails(text, reason, extra = {}) {
  const result = resolve(text, extra);
  assert.equal(result.ok, false, `expected "${text}" to FAIL, got: ${JSON.stringify(result)}`);
  if (reason) assert.equal(result.reason, reason, `wrong reason for "${text}"`);
  return result;
}
// 上海本地某日 00:00 的 UTC 瞬时。
const sh = (day) => new Date(Date.parse(`${day}T00:00:00.000Z`) - 8 * 3600_000).toISOString();
// 断言某表达解析出的半开区间 = [startDay, endDayExclusive)
function assertSpan(text, startDay, endDayExclusive, extra = {}) {
  const result = ok(text, extra);
  assert.equal(result.range.since, sh(startDay), `${text}: wrong since`);
  assert.equal(result.range.untilExclusive, sh(endDayExclusive), `${text}: wrong untilExclusive`);
  return result;
}

// ───────────────────────── 相对日 ─────────────────────────

test("N天前 counts calendar days back from the local reference day", () => {
  assert.equal(ok("一天前").calendarDate, "2026-10-11");
  assert.equal(ok("1天前").calendarDate, "2026-10-11");
  assert.equal(ok("三天前").calendarDate, "2026-10-09");
  assert.equal(ok("五天前").calendarDate, "2026-10-07");
  assert.equal(ok("三十天前").calendarDate, "2026-09-12");
  // 都是单日、都不是补出来的年份。
  for (const text of ["一天前", "三天前", "五天前"]) {
    assert.equal(ok(text).grain, "day");
    assert.equal(ok(text).yearInferred, false);
  }
});

test("大前天 is three days back, alongside 前天 (two) and 昨天 (one)", () => {
  assert.equal(ok("昨天").calendarDate, "2026-10-11");
  assert.equal(ok("前天").calendarDate, "2026-10-10");
  assert.equal(ok("大前天").calendarDate, "2026-10-09");
  // 与 N天前 必须一致（同一个语义，两条写法）。
  assert.equal(ok("大前天").calendarDate, ok("三天前").calendarDate);
});

test("N天前 is a half-open single day, and a DST day is still not 24 hours", () => {
  assertSpan("三天前", "2026-10-09", "2026-10-10");
  // 美西 2026-03-08 是 23 小时日：N天前 走到它时必须仍然按本地午夜推。
  const result = resolveDateText({ text: "一天前", now: "2026-03-09T20:00:00.000Z", timezone: "America/Los_Angeles" });
  assert.equal(result.calendarDate, "2026-03-08");
  assert.equal((Date.parse(result.range.untilExclusive) - Date.parse(result.range.since)) / 3600_000, 23);
});

// ───────────────────────── 相对周 / 近N周 ─────────────────────────

test("上上周 is two whole weeks before this week", () => {
  assertSpan("上周", "2026-10-05", "2026-10-12");
  assertSpan("上上周", "2026-09-28", "2026-10-05");
  assert.equal(ok("上上周").grain, "week");
  assert.equal(ok("上上周").calendarDate, null, "a week is not a single day");
  assert.equal(ok("上上周").weekStartsOn, 1);
});

test("近N周 / 最近N周 are rolling N*7-day windows ending today", () => {
  assertSpan("近一周", "2026-10-06", "2026-10-13");
  assertSpan("近两周", "2026-09-29", "2026-10-13");
  assertSpan("最近三周", "2026-09-22", "2026-10-13");
  assert.equal(ok("近一周").grain, "week");
  assert.ok(ok("近一周").assumptions.some((a) => /rolling/u.test(a)), "the rolling semantics must be auditable");
});

// ───────────────────────── 最近N天 ─────────────────────────

test("最近N天 / 近N天 are rolling N-day windows ending today (inclusive)", () => {
  // now 的本地日 = 2026-10-12；「最近三天」= 10-10 / 10-11 / 10-12 三天。
  assertSpan("最近三天", "2026-10-10", "2026-10-13");
  assertSpan("近三天", "2026-10-10", "2026-10-13");
  assertSpan("最近五天", "2026-10-08", "2026-10-13");
  assertSpan("最近一天", "2026-10-12", "2026-10-13");
  assert.equal(ok("最近三天").grain, "day");
});

test("最近N天 and (N天前 到 今天) describe the same window", () => {
  // 两条写法必须落在同一个区间上 —— 否则用户换个说法就会得到不同的答案。
  // 「最近三天」= 10-10..10-12 = 「两天前 到 今天」。
  const rolling = ok("最近三天");
  const explicit = ok("两天前到今天");
  assert.equal(rolling.range.since, explicit.range.since);
  assert.equal(rolling.range.untilExclusive, explicit.range.untilExclusive);
});

// ───────────────────────── 相对月 ─────────────────────────

test("上个月N号 resolves inside the previous calendar month", () => {
  assert.equal(ok("上个月15号").calendarDate, "2026-09-15");
  assert.equal(ok("上个月15日").calendarDate, "2026-09-15");
  assert.equal(ok("上个月1号").calendarDate, "2026-09-01");
  assert.equal(ok("上上个月15号").calendarDate, "2026-08-15");
  assert.equal(ok("上个月15号").grain, "day");
});

test("a day that does not exist in the target month fails instead of rolling over", () => {
  // now = 2026-03-12 ⇒ 上个月 = 2026-02（非闰年 ⇒ 28 天）。29/30 号都不存在 ⇒ 必须失败，不许滚到 3 月。
  fails("上个月29号", "invalid-date", { now: "2026-03-12T04:00:00.000Z" });
  fails("上个月30号", "invalid-date", { now: "2026-03-12T04:00:00.000Z" });
  // 同一句在闰年成立（2024-02 有 29 天）。
  assert.equal(ok("上个月29号", { now: "2024-03-12T04:00:00.000Z" }).calendarDate, "2024-02-29");
  // 30 天的月份里 30 号存在。
  assert.equal(ok("上个月30号", { now: "2026-11-12T04:00:00.000Z" }).calendarDate, "2026-10-30");
  // 2 月的 31 号在**任何**年份都不存在（now=2026-10-12 ⇒ 上个月 = 2026-09，只有 30 天）。
  fails("上个月31号", "invalid-date");
  // 判别性：失败结果不许留下"某一天"。
  const rejected = fails("上个月30号", "invalid-date", { now: "2026-03-12T04:00:00.000Z" });
  assert.equal(rejected.calendarDate, undefined);
  assert.equal(rejected.range, undefined);
});

test("近N个月 is N whole calendar months ending with the current month", () => {
  // 含本月在内的 N 个完整日历月。
  assertSpan("近一个月", "2026-10-01", "2026-11-01");
  assertSpan("近三个月", "2026-08-01", "2026-11-01");
  assertSpan("最近两个月", "2026-09-01", "2026-11-01");
  assert.equal(ok("近三个月").grain, "month");
});

// ───────────────────────── 区间 ─────────────────────────

test("weekday-to-weekday ranges resolve both ends in the same timezone", () => {
  // 周一起始：本周 = 10-12..10-18，上周 = 10-05..10-11。
  const result = assertSpan("上周一到上周三", "2026-10-05", "2026-10-08");
  assert.equal(result.grain, "day");
  assert.equal(result.calendarDate, null, "a range is not a single day");
  assertSpan("这周一到这周三", "2026-10-12", "2026-10-15");
  assertSpan("周一到周三", "2026-10-12", "2026-10-15");
});

test("date-to-date ranges are inclusive of both ends", () => {
  assertSpan("10月1号到10月7号", "2026-10-01", "2026-10-08");
  assertSpan("10/1 到 10/7", "2026-10-01", "2026-10-08");
  assertSpan("2026-10-01到2026-10-07", "2026-10-01", "2026-10-08");
  // 单日区间退化成一天。
  assertSpan("10月1号到10月1号", "2026-10-01", "2026-10-02");
});

test("a reversed range is normalised, not silently emptied", () => {
  // "10月7号到10月1号" —— 用户可能说反；按时间顺序正过来，并标注。
  const result = assertSpan("10月7号到10月1号", "2026-10-01", "2026-10-08");
  assert.ok(result.assumptions.some((a) => /reversed|swap/iu.test(a)), "the swap must be visible in assumptions");
});

test("N天前到N天前 ranges work, and endpoints are ordered", () => {
  assertSpan("五天前到三天前", "2026-10-07", "2026-10-10");
  assertSpan("三天前到五天前", "2026-10-07", "2026-10-10", {}); // 反着写也归一化
});

test("a range with a non-day endpoint fails rather than guessing", () => {
  // "上个月到昨天"：区间端点必须能落到具体的日；月粒度端点不允许（会悄悄放大范围）。
  fails("上个月到昨天", "no-match");
  fails("上周到本周", "no-match");
});

// ───────────────────────── 未来 ─────────────────────────

test("future expressions resolve forward, and never silently become the past", () => {
  assert.equal(ok("明天").calendarDate, "2026-10-13");
  assert.equal(ok("后天").calendarDate, "2026-10-14");
  assert.equal(ok("大后天").calendarDate, "2026-10-15");
  assert.equal(ok("下周").range.since, sh("2026-10-19"));
  assert.equal(ok("下周三").calendarDate, "2026-10-21");
  assert.equal(ok("下周三").grain, "day");
  // 未来月也不该留洞（实测「下个月」一度是 no-match）。
  assertSpan("下个月", "2026-11-01", "2026-12-01");
  assert.equal(ok("下个月").grain, "month");
  // 未来表达必须真的在未来 —— 用断言把"不许静默当过去"钉住。
  const tomorrow = ok("明天");
  assert.ok(Date.parse(tomorrow.range.since) > Date.parse(NOW), "明天 must start after now");
  for (const text of ["明天", "后天", "大后天", "下周三", "下周", "下个月"]) {
    assert.ok(Date.parse(ok(text).range.since) >= Date.parse(ok("今天").range.since), `${text} must not land in the past`);
  }
});

// ───────────────────────── 口语尾巴 ─────────────────────────

test("colloquial tails are accepted and are exactly equivalent to the bare expression", () => {
  const bare = ok("10/10");
  for (const text of ["10/10 那天", "10/10那天", "10 月 10 号那天", "10月10日那天", "10/10 那天我们聊了什么"]) {
    const result = ok(text);
    assert.equal(result.calendarDate, bare.calendarDate, `${text} must resolve to the same day`);
    assert.deepEqual(result.range, bare.range, `${text} must resolve to exactly the same range`);
  }
  // 也支持"那天"在词尾作用于相对表达。
  assert.deepEqual(ok("三天前那天").range, ok("三天前").range);
});

test("a tail with no date expression still fails", () => {
  fails("那天我们聊了什么", "no-match");
  fails("那天", "no-match");
});

// ───────────────────────── 反例：普通数字不许被吃掉 ─────────────────────────

test("ordinary numbers are never read as dates", () => {
  for (const text of [
    "我买了 3 个苹果", "这个方案有 3 个问题", "3个苹果", "第3个",
    "价格是 3 块", "我有 2 个孩子", "第 5 章", "版本 3.0", "1024 个文件",
  ]) {
    const result = resolve(text);
    assert.equal(result.ok, false, `"${text}" must NOT be read as a date`);
    assert.equal("range" in result, false, `"${text}" must carry no range`);
  }
});

test("N天前 requires the whole candidate to be the expression, not a substring", () => {
  // "3天前" 成立，但 "我3天前买的" 这种带前后文的整句目前**不抽取**（明确失败，不猜）。
  assert.equal(ok("3天前").calendarDate, "2026-10-09");
  fails("我3天前买的", "no-match");
  fails("大概三天前吧", "no-match");
});

// ───────────────────────── 优先级与歧义（单子第 3 条） ─────────────────────────

test("a range beats a single day when both appear in one phrase", () => {
  // 规则：**显式区间优先于单日**；区间两端各自解析。
  const result = ok("上周三到本周一");
  assert.equal(result.range.since, sh("2026-10-07"));
  assert.equal(result.range.untilExclusive, sh("2026-10-13"));
});

test("competing candidates do not silently merge into a wider query", () => {
  // "上周三 最近三天" 是两句时间表达拼在一起。**不许**把并集当答案（会悄悄放大数据量）。
  const result = resolve("上周三 最近三天");
  assert.equal(result.ok, false, "two competing expressions must not be merged");
  assert.equal(result.reason, "ambiguous");
  assert.ok(result.ambiguous.candidates.length >= 2, "both readings must be offered");
});

test("no numeric expression is silently swallowed: 上个月15号 has an explicit month", () => {
  // 判别性：15 是"上个月"的号数，不是独立的"15号"。
  const result = ok("上个月15号");
  assert.equal(result.calendarDate, "2026-09-15");
});

test("the priority rules are documented in one place and covered by tests", () => {
  const rules = listSupportedDateExpressions();
  assert.ok(rules.length >= 25, `expected the broader grammar to be listed, got ${rules.length}`);
  assert.ok(rules.every((entry) => entry.pattern && entry.example && entry.grain));
  // 单子里点名要有的形态必须在表里。
  for (const example of ["三天前", "上上周", "最近三天", "近一周", "上个月15号", "上周一到上周三", "下周三", "明天", "10/10 那天", "下个月"]) {
    assert.ok(rules.some((entry) => entry.example === example), `grammar list is missing: ${example}`);
  }
});

// ───────────────────────── 显式区间入口 ─────────────────────────

test("resolveDateRangeText exposes the same grammar through an explicit range entry", () => {
  const result = resolveDateRangeText({ text: "最近三天", now: NOW, timezone: TZ });
  assert.equal(result.ok, true);
  assert.equal(result.range.since, sh("2026-10-10"));
  assert.equal(result.range.untilExclusive, sh("2026-10-13"));
});

// ───────────────────────── 硬规则不许回退 ─────────────────────────

test("the M2.1-B1 hard rules still hold alongside the broader grammar", () => {
  // 半开区间
  assertSpan("最近三天", "2026-10-10", "2026-10-13");
  // 严格日历校验
  fails("2/30", "invalid-date");
  fails("上个月31号", "invalid-date", { now: "2026-10-12T04:00:00.000Z" }); // 9 月只有 30 天
  // 时区必须是显式且合法的
  fails("三天前", "invalid-timezone", { timezone: "Not/AZone" });
  fails("三天前", "invalid-now", { now: "nonsense" });
  // 歧义给候选、不合并
  fails("10/11", "ambiguous", { locale: null });
  // 认不出 ⇒ 明确失败且不带 range
  const unknown = fails("随便聊聊", "no-match");
  assert.equal("range" in unknown, false);
});
