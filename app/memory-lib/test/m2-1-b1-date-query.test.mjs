// M2.1-B1：人话日期解析（纯规则、零模型）契约测试。
//
// 这批测试有意先写、先跑红：把「不认得的表达必须失败」「2/30 必须失败」「半开区间边界」
// 「歧义不许替用户选」「周起始必须显式」这些**产品级约定**先固定住，再实现。
//
// 参考：research/time-tagging-and-relative-date-parsing.md（一手来源调查）
import assert from "node:assert/strict";
import test from "node:test";
import { resolveDateText, toWindowsTimezoneMap, listSupportedDateExpressions } from "../src/date-query.mjs";

// 固定的参考瞬时：2026-10-10 09:00 Asia/Shanghai（= 01:00Z）。
// 选它是因为它同时落在上海本地 10-10 上午、UTC 10-10 凌晨、以及洛杉矶本地 10-09 ——
// 用它当 now，任何"拿本地日去比 UTC"的实现都会露馅。
const NOW = "2026-10-10T01:00:00.000Z";
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

// ───────────────────────── 绝对日期（无歧义形式） ─────────────────────────

test("absolute dates resolve: 2026-10-10 / 2026/10/10 / 2026年10月10日", () => {
  for (const text of ["2026-10-10", "2026/10/10", "2026年10月10日"]) {
    const result = ok(text);
    assert.equal(result.calendarDate, "2026-10-10", `wrong date for ${text}`);
    assert.equal(result.yearInferred, false, `${text} states its year explicitly`);
    assert.equal(result.range.inclusiveEnd, "2026-10-10T15:59:59.999Z", `wrong range for ${text}`);
  }
});

test("a local day is a half-open interval: [startOfDay, nextDayStartOfDay)", () => {
  const result = ok("2026-10-10");
  assert.equal(result.range.since, "2026-10-09T16:00:00.000Z");
  assert.equal(result.range.untilExclusive, "2026-10-10T16:00:00.000Z");
  // 半开区间的两个端点必须与区间口径自洽。
  assert.equal(result.range.inclusiveEnd, "2026-10-10T15:59:59.999Z");
  assert.equal(new Date(result.range.untilExclusive) - new Date(result.range.inclusiveEnd), 1);
  // 明确不许"固定 24 小时"：上海 2026-10-10 是 24 小时，但算法不能依赖这一点（见 DST 用例）。
  assert.equal(result.grain, "day");
});

// ───────────────────────── 硬规则 2：半开区间，且不许假设一天 24 小时 ─────────────────────────

test("the window is derived from adjacent local midnights, so a DST day is not 24 hours", () => {
  // 2026-03-08 是美西春季调时当天：本地一天只有 23 小时。
  // 任何"start + 固定 86400000ms"或"23:59:59.999 硬编码"的实现在这里必然露馅。
  const dst = resolveDateText({ text: "2026-03-08", now: NOW, timezone: "America/Los_Angeles" });
  assert.equal(dst.ok, true);
  const dstMs = Date.parse(dst.range.untilExclusive) - Date.parse(dst.range.since);
  assert.equal(dstMs / 3_600_000, 23, "the spring-forward local day is 23 hours, not 24");
  assert.equal(dst.range.since, "2026-03-08T08:00:00.000Z"); // PST (UTC-8)
  assert.equal(dst.range.untilExclusive, "2026-03-09T07:00:00.000Z"); // PDT (UTC-7)

  // 相邻的普通日是 24 小时 —— 说明上面不是巧合，而是真的按本地午夜推出来的。
  const normal = resolveDateText({ text: "2026-03-07", now: NOW, timezone: "America/Los_Angeles" });
  assert.equal((Date.parse(normal.range.untilExclusive) - Date.parse(normal.range.since)) / 3_600_000, 24);
});

test("the same local day yields different UTC windows per timezone", () => {
  const windows = {};
  for (const zone of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Australia/Lord_Howe"]) {
    const result = resolveDateText({ text: "2026-10-10", now: NOW, timezone: zone });
    assert.equal(result.calendarDate, "2026-10-10", `${zone} must still be the 10th locally`);
    windows[zone] = result.range.since;
  }
  assert.deepEqual(windows, {
    "UTC": "2026-10-10T00:00:00.000Z",
    "Asia/Shanghai": "2026-10-09T16:00:00.000Z",
    "America/Los_Angeles": "2026-10-10T07:00:00.000Z",
    "Australia/Lord_Howe": "2026-10-09T13:00:00.000Z",
  });
});



test("year-less dates take the year of `now` in the given timezone and say so", () => {
  for (const text of ["10/10", "10-10", "10月10日"]) {
    const result = ok(text);
    assert.equal(result.calendarDate, "2026-10-10", `wrong date for ${text}`);
    assert.equal(result.yearInferred, true, `${text} omits the year, so it must be flagged`);
    assert.ok(result.assumptions.includes("year = 2026 (from now)"), `missing year assumption for ${text}`);
  }
});

test("the inferred year comes from `now` in the target timezone, not from UTC", () => {
  // 2026-12-31 23:30Z 在上海已是 2027-01-01 07:30 ⇒ "1/1" 应补 2027，不是 2026。
  const result = resolveDateText({ text: "1/1", now: "2026-12-31T23:30:00.000Z", timezone: TZ });
  assert.equal(result.ok, true);
  assert.equal(result.calendarDate, "2027-01-01");
  assert.equal(result.yearInferred, true);
  assert.ok(result.assumptions.includes("year = 2027 (from now)"));
});

// ───────────────────────── 相对日 ─────────────────────────

test("今天 / 昨天 / 前天 resolve relative to `now` in the target timezone", () => {
  assert.equal(ok("今天").calendarDate, "2026-10-10");
  assert.equal(ok("昨天").calendarDate, "2026-10-09");
  assert.equal(ok("前天").calendarDate, "2026-10-08");
  for (const text of ["今天", "昨天", "前天"]) {
    assert.equal(ok(text).yearInferred, false, `${text} computes a full date, nothing is inferred`);
    assert.equal(ok(text).grain, "day");
  }
});

test("昨天 follows the local date even when the UTC date differs", () => {
  // 上海本地 2026-10-10 07:30（UTC 还是 10-09 23:30）⇒ 昨天 = 2026-10-09。
  const result = resolveDateText({ text: "昨天", now: "2026-10-09T23:30:00.000Z", timezone: TZ });
  assert.equal(result.calendarDate, "2026-10-09");
  // 同一瞬时在洛杉矶还是 10-09，昨天应是 10-08。
  const la = resolveDateText({ text: "昨天", now: "2026-10-09T23:30:00.000Z", timezone: "America/Los_Angeles" });
  assert.equal(la.calendarDate, "2026-10-08");
});

// ───────────────────────── 周语义 ─────────────────────────

test("week expressions honour weekStartsOn and report it back", () => {
  // 2026-10-10 是星期六。周一为一周之始 ⇒ 本周 = 10-05(一) .. 10-11(日)。
  const thisWeek = ok("本周", { weekStartsOn: 1 });
  assert.equal(thisWeek.calendarDate, null, "a week is not a single day");
  assert.equal(thisWeek.grain, "week");
  assert.equal(thisWeek.weekStartsOn, 1);
  assert.equal(thisWeek.range.since, "2026-10-04T16:00:00.000Z"); // 上海 10-05 00:00
  assert.equal(thisWeek.range.untilExclusive, "2026-10-11T16:00:00.000Z"); // 上海 10-12 00:00
  assert.ok(thisWeek.assumptions.some((a) => /week starts on Monday/u.test(a)));

  const lastWeek = ok("上周", { weekStartsOn: 1 });
  assert.equal(lastWeek.range.since, "2026-09-27T16:00:00.000Z"); // 上海 09-28 00:00
  assert.equal(lastWeek.range.untilExclusive, "2026-10-04T16:00:00.000Z"); // 上海 10-05 00:00
});

test("weekStartsOn defaults to Monday and is echoed, and Sunday-first shifts the answer", () => {
  assert.equal(ok("本周").weekStartsOn, 1, "default must be explicit in the response");
  // 周日为一周之始 ⇒ 本周 = 10-04(日) .. 10-10(六)。
  const sunday = ok("本周", { weekStartsOn: 0 });
  assert.equal(sunday.weekStartsOn, 0);
  assert.equal(sunday.range.since, "2026-10-03T16:00:00.000Z"); // 上海 10-04 00:00
  assert.equal(sunday.range.untilExclusive, "2026-10-10T16:00:00.000Z"); // 上海 10-11 00:00
});

test("本周三 / 上周三 resolve to a single local day inside the right week", () => {
  assert.equal(ok("本周三").calendarDate, "2026-10-07", "the Wednesday of the Monday-first week 10-05..10-11");
  assert.equal(ok("上周三").calendarDate, "2026-09-30", "the Wednesday of 09-28..10-04");
  assert.equal(ok("本周三").grain, "day");
  // 周起始只移动"周"的边界，不移动"周三"这个事实：
  // 周日起始时含 10-10 的那一周是 10-04..10-10，其周三仍是 10-07；
  // 而"上周"退到 09-27..10-03，其周三是 09-30。
  assert.equal(ok("本周三", { weekStartsOn: 0 }).calendarDate, "2026-10-07",
    "Sunday-first keeps 本周 = 10-04..10-10, whose Wednesday is 10-07");
  assert.equal(ok("上周三", { weekStartsOn: 0 }).calendarDate, "2026-09-30",
    "Sunday-first pushes 上周 to 09-27..10-03, whose Wednesday is 09-30");
});

// ───────────────────────── 月语义 ─────────────────────────

test("这个月 / 上个月 use calendar months, never a fixed 30 days", () => {
  const thisMonth = ok("这个月");
  assert.equal(thisMonth.grain, "month");
  assert.equal(thisMonth.calendarDate, null);
  assert.equal(thisMonth.range.since, "2026-09-30T16:00:00.000Z"); // 上海 10-01 00:00
  assert.equal(thisMonth.range.untilExclusive, "2026-10-31T16:00:00.000Z"); // 上海 11-01 00:00

  const lastMonth = ok("上个月");
  assert.equal(lastMonth.range.since, "2026-08-31T16:00:00.000Z"); // 上海 09-01 00:00
  assert.equal(lastMonth.range.untilExclusive, "2026-09-30T16:00:00.000Z"); // 上海 10-01 00:00
});

test("上个月 across a year boundary is a calendar step, not 30 days", () => {
  // now 在上海是 2026-01-15 ⇒ 上个月 = 2025-12。
  const result = resolveDateText({ text: "上个月", now: "2026-01-15T04:00:00.000Z", timezone: TZ });
  assert.equal(result.range.since, "2025-11-30T16:00:00.000Z"); // 上海 2025-12-01 00:00
  assert.equal(result.range.untilExclusive, "2025-12-31T16:00:00.000Z"); // 上海 2026-01-01 00:00
});

// ───────────────────────── 硬规则 1：严格日历校验 ─────────────────────────

test("impossible dates fail instead of rolling over into the next month", () => {
  for (const text of ["2/30", "13/45", "2026-02-30", "2026年2月30日", "0/10", "10/0", "4/31", "2026-13-01"]) {
    const result = fails(text, "invalid-date");
    assert.equal(result.ok, false);
    assert.ok(result.message, `${text} must carry a human-readable reason`);
  }
});

test("leap years are validated properly", () => {
  assert.equal(ok("2024-02-29").calendarDate, "2024-02-29", "2024 is a leap year");
  fails("2026-02-29", "invalid-date"); // 2026 不是闰年
  fails("2025-02-29", "invalid-date");
  assert.equal(ok("2000-02-29").calendarDate, "2000-02-29", "2000 is a leap year (÷400)");
  fails("1900-02-29", "invalid-date"); // 1900 不是闰年（÷100 但 not ÷400）
});

test("a rejected date never silently becomes another day", () => {
  // 原生 Date 会把 2/30 滚到 3-02；我们必须报错而不是返回 3-02。
  const result = fails("2/30", "invalid-date");
  assert.equal(result.calendarDate, undefined);
  assert.equal(result.range, undefined);
});

// ───────────────────────── 硬规则 4：歧义不替用户选 ─────────────────────────

test("10/11 with an unknown locale is ambiguous and offers both candidates", () => {
  const result = fails("10/11", "ambiguous", { locale: null });
  assert.equal(result.ambiguous.candidates.length, 2, "both readings must be offered");
  const dates = result.ambiguous.candidates.map((c) => c.calendarDate).sort();
  assert.deepEqual(dates, ["2026-10-11", "2026-11-10"]);
  for (const candidate of result.ambiguous.candidates) {
    assert.equal(candidate.range.since < candidate.range.untilExclusive, true);
    assert.ok(candidate.rationale, "each candidate must explain itself");
  }
});

test("an unambiguous numeric date resolves even with an unknown locale", () => {
  // 10/10 在 MDY 与 DMY 下同为 10 月 10 日 ⇒ 没有歧义，应当直接解析。
  const result = resolveDateText({ text: "10/10", now: NOW, timezone: TZ, locale: null });
  assert.equal(result.ok, true);
  assert.equal(result.calendarDate, "2026-10-10");
  assert.equal(result.yearInferred, true);
});

test("zh-CN reads M/D as month/day; en-US as month/day; en-GB as day/month", () => {
  assert.equal(ok("10/11", { locale: "zh-CN" }).calendarDate, "2026-10-11");
  assert.equal(ok("10/11", { locale: "en-US" }).calendarDate, "2026-10-11");
  assert.equal(ok("10/11", { locale: "en-GB" }).calendarDate, "2026-11-10");
  assert.equal(ok("10/11", { locale: "zh-CN" }).ambiguous, undefined, "a stated locale removes the ambiguity");
});

test("the default locale is zh-CN and is reported back", () => {
  const result = ok("10/10");
  assert.equal(result.locale, "zh-CN");
  assert.equal(result.timezone, TZ);
  assert.equal(result.sourceText, "10/10");
});

// ───────────────────────── 硬规则 6：不认得的表达必须失败 ─────────────────────────

test("unrecognised text fails explicitly instead of degrading into a wide query", () => {
  // ⚠️ M2.1-B2 取代了本用例的一部分：`三天前` 当时**刻意**不支持（本单第一批范围），
  // 现在 B2 明确把它纳入语法（见 test/m2-1-b2-date-grammar.test.mjs）。
  // 所以这里换成**仍然**不该被认下的表达 —— 判据本身（认不出必须失败、且不带 range）不变。
  for (const text of ["随便聊聊", "上次说的那个", "", "   ", "下下周一下午", "大概三天前吧", "我3天前买的"]) {
    const result = fails(text, "no-match");
    assert.equal(result.range, undefined, `"${text}" must not produce a range`);
  }
  // 判别性：被 B2 接走的那个表达，现在必须**成功**（否则上面那句就成了掩盖）。
  const adopted = resolve("三天前");
  assert.equal(adopted.ok, true, "M2.1-B2 must have adopted 三天前 into the grammar");
});

test("a failure carries no range at all, so it cannot be used as a wildcard", () => {
  const result = fails("随便聊聊", "no-match");
  assert.equal("range" in result, false);
  assert.equal(result.ok, false);
});

test("date-like numbers that are not dates must not be captured (research: 防数字冲突)", () => {
  // research/time-tagging-and-relative-date-parsing.md 明列要排除的形态：
  // 版本号 / 小数 / IP / 章节号 / 金额。这些若被当成日期，就会悄悄改掉用户的问题。
  const notDates = [
    "1.2", "1.2.3", "10.10.2", "3.14",           // 小数 / 版本号
    "192.168.1.1", "10.0.0.1",                    // IPv4
    "v1.2.3", "版本10.10发布", "第10.10节",        // 带前后缀的版本/章节
    "10.10.10", "10:30", "12月", "第3章",          // 其他非日期形态
    "约10.10元", "10.10万元", "section 10.10",     // 金额 / 英文段落
  ];
  for (const text of notDates) {
    const result = resolve(text);
    assert.equal(result.ok, false, `"${text}" must NOT be read as a date, got ${JSON.stringify(result)}`);
    assert.equal(result.reason, "no-match", `"${text}"`);
    assert.equal("range" in result, false, `"${text}" must carry no range`);
  }
});

test("the dot-separated form is deliberately unsupported because it cannot be disambiguated", () => {
  // 单子点名的形式是 10/10、10-10、10月10日 —— 没有 10.10。
  // 点号形式与版本号/小数/章节号冲突最强，且脱离上下文本来就判不出来，
  // 所以刻意不支持：**明确失败**比静默把 3.14 当成 3 月 14 日更安全。
  assert.equal(resolve("10.10").reason, "no-match");
  assert.equal(resolve("3.14").reason, "no-match");
  // 而单子点名要求的形式都仍然成立。
  assert.equal(ok("10/10").calendarDate, "2026-10-10");
  assert.equal(ok("10-10").calendarDate, "2026-10-10");
  assert.equal(ok("10月10日").calendarDate, "2026-10-10");
  // 斜杠形式即使带前缀也不许被"挑出来"当日期。
  assert.equal(resolve("版本10/10发布").ok, false);
});

test("a full ISO timestamp is not silently truncated to its date", () => {
  // 单子硬规则 2 明写"不许对 UTC 串截前 10 位当本地日"。
  // 本模块只接受**日期**表达；带时刻的串要明确失败，避免"截断成某天"这种静默语义。
  const result = resolve("2026-10-10T05:00:00Z");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-match");
});



test("now and timezone are validated, never guessed", () => {
  fails("10/10", "invalid-now", { now: "not-a-time" });
  fails("10/10", "invalid-now", { now: undefined });
  fails("10/10", "invalid-timezone", { timezone: "Not/AZone" });
  fails("10/10", "invalid-timezone", { timezone: "" });
});

// ───────────────────────── 组合：整句输入 ─────────────────────────

test("a whole question is accepted when only a date expression plus question wrapper remains", () => {
  for (const text of ["10/10 我们聊了什么", "10/10聊了什么", "10/10 那天我们说了什么"]) {
    const result = ok(text);
    assert.equal(result.calendarDate, "2026-10-10", `failed for ${text}`);
    assert.equal(result.range.inclusiveEnd, "2026-10-10T15:59:59.999Z");
  }
});

test("a question with no date expression in it fails", () => {
  fails("我们聊了什么", "no-match");
});

// ───────────────────────── 硬规则 3：Windows→IANA 映射集中一处 ─────────────────────────

test("Windows timezone names map to IANA in one place", () => {
  const map = toWindowsTimezoneMap();
  assert.equal(map["China Standard Time"], "Asia/Shanghai");
  assert.equal(map["Tokyo Standard Time"], "Asia/Tokyo");
  assert.equal(map["Pacific Standard Time"], "America/Los_Angeles");
  // 映射结果必须是 Node 认得的 IANA 名。
  for (const iana of Object.values(map)) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: iana }), `${iana} is not a valid IANA zone`);
  }
});

test("a Windows timezone name is accepted as input and normalised in the response", () => {
  const result = resolveDateText({ text: "2026-10-10", now: NOW, timezone: "China Standard Time" });
  assert.equal(result.ok, true);
  assert.equal(result.timezone, "Asia/Shanghai", "the response must report the normalised IANA zone");
  assert.ok(result.assumptions.some((a) => /China Standard Time/u.test(a)), "the translation must be auditable");
  assert.equal(result.range.since, "2026-10-09T16:00:00.000Z");
});

// ───────────────────────── 审计与回放 ─────────────────────────

test("the same request replayed gives the same range and echoes its context", () => {
  const a = ok("上周三");
  const b = ok("上周三");
  assert.deepEqual(a, b, "resolution must be a pure function of its inputs");
  assert.equal(a.now, NOW);
  assert.equal(a.timezone, TZ);
  assert.equal(a.weekStartsOn, 1);
});

test("grain is reported so callers know what they asked for", () => {
  assert.equal(ok("10/10").grain, "day");
  assert.equal(ok("本周").grain, "week");
  assert.equal(ok("上个月").grain, "month");
});

test("resolvedRange is the ordered output contract, with since/until ready for the day enumerator", () => {
  const result = ok("10/10");
  // 单子点名的输出字段名就是 resolvedRange。
  assert.deepEqual(result.resolvedRange, {
    since: "2026-10-09T16:00:00.000Z",
    until: "2026-10-10T15:59:59.999Z",
    untilExclusive: "2026-10-10T16:00:00.000Z",
    timezone: "Asia/Shanghai",
  });
  // `until` 取闭口径（最后一毫秒），可直接透给按天枚举，调用方不必自己减 1ms。
  assert.equal(new Date(result.resolvedRange.untilExclusive) - new Date(result.resolvedRange.until), 1);
  // 真值仍是半开区间，且与 range 自洽。
  assert.equal(result.resolvedRange.since, result.range.since);
  assert.equal(result.resolvedRange.untilExclusive, result.range.untilExclusive);
  assert.equal(result.resolvedRange.until, result.range.inclusiveEnd);
});

test("the supported-expression list is exposed for docs and drift checks", () => {
  const list = listSupportedDateExpressions();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 12, "the first batch must cover the ordered expressions");
  assert.ok(list.every((entry) => entry.pattern && entry.example && entry.grain));
});
