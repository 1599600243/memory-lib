// SCENARIO-1：把「随口问」接上平台 —— 参考接入实现的契约测试（**红测试先行**）。
//
// 用户场景：过了几天随口问「10/10 我们聊了什么」，要能说出**那天全部**的内容。
//
// 本文件固定四件事（都是单子点名的硬要求）：
//   ① 必须先 resolve 再检索（不许拿原话去关键词检索）；
//   ② 失败/歧义**如实处理**：歧义给候选请用户确认，认不出时间表达就明说"没有时间范围"，
//      **不许**瞎猜日期、**不许**替用户合并两天；
//   ③ 「取全」= 翻页直到 nextCursor 为 null，且**取回条数 == total_count**
//      （limit 只决定每页大小，不许因此少给）；
//   ④ 输出里**只复述库里真实存在的内容**，且要能看出"这是检索到的原文摘要"，
//      而不是生成的 —— 平台**零模型**。
import assert from "node:assert/strict";
import test from "node:test";
import { recallScenario } from "../src/scenario-recall.mjs";

const NOW = "2026-10-12T04:00:00.000Z"; // 上海本地 2026-10-12（周一）12:00
const TZ = "Asia/Shanghai";

// ── 一个假平台：记录每一次请求，并按脚本回话 ──
function fakePlatform({ resolveResponses = [], searchPages = [] } = {}) {
  const calls = [];
  let resolveIndex = 0;
  let searchIndex = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/v1/date/resolve")) {
      const payload = resolveResponses[Math.min(resolveIndex, resolveResponses.length - 1)];
      resolveIndex += 1;
      return { status: payload.status ?? (payload.ok === false ? 422 : 200), json: async () => payload };
    }
    if (String(url).endsWith("/v1/search")) {
      const payload = searchPages[Math.min(searchIndex, searchPages.length - 1)];
      searchIndex += 1;
      return { status: 200, json: async () => payload };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { calls, fetchImpl };
}

const RESOLVED_ONE_DAY = {
  ok: true,
  calendarDate: "2026-10-10",
  grain: "day",
  timezone: TZ,
  resolvedRange: { since: "2026-10-09T16:00:00.000Z", until: "2026-10-10T15:59:59.999Z", untilExclusive: "2026-10-10T16:00:00.000Z", calendarTimezone: TZ },
  range: { since: "2026-10-09T16:00:00.000Z", untilExclusive: "2026-10-10T16:00:00.000Z", inclusiveEnd: "2026-10-10T15:59:59.999Z" },
  yearInferred: true,
  assumptions: ["year = 2026 (from now)"],
};

function item(id, capturedAt, excerpt) {
  return { id, path: `evidence/conversations/${id}.md`, capturedAt, updatedAt: capturedAt, excerpt, result_type: "evidence" };
}

const DAY_ITEMS = [
  item("c1", "2026-10-09T16:30:00.000Z", "先聊了游戏的主线"),
  item("c2", "2026-10-10T04:00:00.000Z", "然后是装备搭配"),
  item("c3", "2026-10-10T15:30:00.000Z", "最后约了下次的时间"),
];

// ─────────────────── ① 先 resolve 再检索 ───────────────────

test("the original sentence goes to resolve FIRST, never straight into a keyword search", async () => {
  const platform = fakePlatform({
    resolveResponses: [RESOLVED_ONE_DAY],
    searchPages: [{ total_count: 3, count: 3, nextCursor: null, hasMore: false, results: DAY_ITEMS }],
  });
  const result = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x" });

  assert.equal(platform.calls[0].url.endsWith("/v1/date/resolve"), true, "第一个请求必须是 date/resolve");
  assert.equal(platform.calls[0].body.text, "10/10 我们聊了什么");
  assert.equal(platform.calls[0].body.now, NOW);
  assert.equal(platform.calls[0].body.timezone, TZ);
  // 检索请求**不许**把原话当关键词
  const searchCalls = platform.calls.filter((call) => call.url.endsWith("/v1/search"));
  assert.ok(searchCalls.length > 0);
  for (const call of searchCalls) {
    assert.equal(call.body.query, "", "按天枚举必须用空 query，不许拿原话去关键词检索");
    assert.equal(call.body.calendarDate, "2026-10-10");
    assert.equal(call.body.calendarTimezone, TZ);
  }
  assert.equal(result.kind, "answer", "解析成功且有内容 ⇒ 给出答复素材");
});

// ─────────────────── ③ 取全：条数 == total_count ───────────────────

test("paging goes to exhaustion and the returned count EQUALS total_count", async () => {
  // 每页 2 条、共 5 条 ⇒ 必须翻 3 页，且最终条数必须是 5（不是第一页的 2）
  const platform = fakePlatform({
    resolveResponses: [RESOLVED_ONE_DAY],
    searchPages: [
      { total_count: 5, count: 2, nextCursor: "CUR1", hasMore: true, results: [DAY_ITEMS[0], DAY_ITEMS[1]] },
      { total_count: 5, count: 2, nextCursor: "CUR2", hasMore: true, results: [DAY_ITEMS[2], item("c4", "2026-10-10T06:00:00.000Z", "第四条")] },
      { total_count: 5, count: 1, nextCursor: null, hasMore: false, results: [item("c5", "2026-10-10T07:00:00.000Z", "第五条")] },
    ],
  });
  const result = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x", pageSize: 2 });

  const searchCalls = platform.calls.filter((call) => call.url.endsWith("/v1/search"));
  assert.equal(searchCalls.length, 3, "必须一直翻到没有下一页");
  assert.equal(searchCalls[0].body.cursor, undefined, "首页不带游标");
  assert.equal(searchCalls[1].body.cursor, "CUR1", "第二页带上上一页给的游标");
  assert.equal(searchCalls[2].body.cursor, "CUR2");
  assert.equal(searchCalls[1].body.offset, undefined, "取全必须用 keyset 游标，不许用 offset 兜");

  assert.equal(result.count, 5, "取回条数必须等于 total_count");
  assert.equal(result.totalCount, 5);
  assert.equal(result.complete, true, "取全断言要能被调用方检查");
  assert.equal(result.items.length, 5);
  // 不重复
  assert.equal(new Set(result.items.map((entry) => entry.id)).size, 5);
});

test("a page that repeats an entry is detected rather than silently double-counted", async () => {
  const platform = fakePlatform({
    resolveResponses: [RESOLVED_ONE_DAY],
    searchPages: [
      { total_count: 2, count: 2, nextCursor: "CUR1", hasMore: true, results: [DAY_ITEMS[0], DAY_ITEMS[1]] },
      // 第二页把第一条又给了一次 —— 这是**缺陷信号**，必须被发现
      { total_count: 2, count: 2, nextCursor: null, hasMore: false, results: [DAY_ITEMS[0], DAY_ITEMS[1]] },
    ],
  });
  const result = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x", pageSize: 2 });
  assert.equal(result.complete, false, "出现重复 ⇒ 不许声称取全");
  assert.ok(result.problems.some((problem) => /duplicate/iu.test(problem)), `problems 里要说清重复：${JSON.stringify(result.problems)}`);
});

test("falling short of total_count is reported as INCOMPLETE, not as a complete day", async () => {
  const platform = fakePlatform({
    resolveResponses: [RESOLVED_ONE_DAY],
    // total_count 说 9 条，但只有一页 2 条且没有下一页 ⇒ 不许声称取全
    searchPages: [{ total_count: 9, count: 2, nextCursor: null, hasMore: false, results: [DAY_ITEMS[0], DAY_ITEMS[1]] }],
  });
  const result = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x", pageSize: 2 });
  assert.equal(result.count, 2);
  assert.equal(result.totalCount, 9);
  assert.equal(result.complete, false, "取回 2 条而总数 9 条 ⇒ 必须标为未取全");
});

// ─────────────────── ② 失败与歧义如实处理 ───────────────────

test("a sentence with no time expression is REFUSED, with no range and no guessing", async () => {
  const platform = fakePlatform({ resolveResponses: [{ ok: false, reason: "no-match", message: "unrecognised time expression: 随便聊聊" }] });
  const result = await recallScenario({ text: "随便聊聊", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x" });

  assert.equal(result.kind, "no-time-range", "必须明确说「这句话里没有时间范围」");
  assert.equal(result.ok, false);
  assert.equal(result.resolvedRange, undefined, "不许产生任何检索范围");
  assert.equal(platform.calls.filter((call) => call.url.endsWith("/v1/search")).length, 0, "认不出时间表达 ⇒ **一次检索都不许发**");
});

test("an ambiguous expression returns the candidates for the user to choose, never a merged range", async () => {
  const candidates = [
    { calendarDate: "2026-10-11", rationale: "month/day (US-style)", range: { since: "2026-10-10T16:00:00.000Z", untilExclusive: "2026-10-11T16:00:00.000Z" } },
    { calendarDate: "2026-11-10", rationale: "day/month (European-style)", range: { since: "2026-11-09T16:00:00.000Z", untilExclusive: "2026-11-10T16:00:00.000Z" } },
  ];
  const platform = fakePlatform({ resolveResponses: [{ ok: false, reason: "ambiguous", message: "can be read two ways", ambiguous: { candidates } }] });
  const result = await recallScenario({ text: "10/11 聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x", locale: null });

  assert.equal(result.kind, "ambiguous");
  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 2, "两种读法都要给出来请用户确认");
  assert.equal(result.resolvedRange, undefined, "**不许**替用户合并成两天");
  assert.equal(platform.calls.filter((call) => call.url.endsWith("/v1/search")).length, 0, "歧义时不许先检索再解释");
});

test("an invalid-but-recognised date is surfaced as an error, not turned into a query", async () => {
  const platform = fakePlatform({ resolveResponses: [{ ok: false, reason: "invalid-date", message: "2/30 is not a real calendar date" }] });
  const result = await recallScenario({ text: "2/30 聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-date");
  assert.equal(platform.calls.filter((call) => call.url.endsWith("/v1/search")).length, 0);
});

// ─────────────────── ④ 只复述库里已有的内容 ───────────────────

test("the answer material restates only what the store returned, with no invented prose", async () => {
  const platform = fakePlatform({
    resolveResponses: [RESOLVED_ONE_DAY],
    searchPages: [{ total_count: 3, count: 3, nextCursor: null, hasMore: false, results: DAY_ITEMS }],
  });
  const result = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x" });

  assert.equal(result.count, 3);
  // 每条素材必须能指回库里那一行，并带上库里的 excerpt 原样
  for (const entry of result.items) {
    assert.ok(entry.capturedAt, "每条要有时间");
    assert.ok(entry.id, "每条要能指回条目 id");
    assert.equal(typeof entry.excerpt, "string");
  }
  assert.deepEqual(result.items.map((entry) => entry.excerpt), DAY_ITEMS.map((entry) => entry.excerpt), "excerpt 必须原样来自库，不许改写");
  // 逐条摘要不许凭空出现库里没有的内容
  const haystack = JSON.stringify(result);
  for (const invented of ["我们后来还聊了", "总结一下", "总之", "大概是"]) {
    assert.equal(haystack.includes(invented), false, `不许出现生成式措辞：${invented}`);
  }
  // 素材里不许混进系统注入的日期词面标签（日期只做结构化字段）
  for (const entry of result.items) {
    assert.doesNotMatch(String(entry.excerpt), /calendarDate|calendarTimezone/u);
  }
  // 零模型：结果对象里不该出现任何模型调用痕迹
  assert.equal(result.modelCalls, 0, "平台零模型：不许有任何模型调用");
});

// ─────────────────── 可见性：拿不到就说拿不到 ───────────────────

test("an empty result is reported as 'nothing visible to me', not as 'nothing happened'", async () => {
  const platform = fakePlatform({
    resolveResponses: [RESOLVED_ONE_DAY],
    searchPages: [{ total_count: 0, count: 0, nextCursor: null, hasMore: false, results: [] }],
  });
  const result = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x" });
  assert.equal(result.count, 0);
  assert.equal(result.complete, true, "0 条也是一种「取全」（总数就是 0）");
  assert.match(result.notice, /看不到|可见|visible/iu, "必须如实说明是「我看不到」，不是「那天没发生」");
});

// ─────────────────── 区间（最近三天） ───────────────────

test("a multi-day range is enumerated day by day so the caller can see the split", async () => {
  const threeDays = {
    ok: true,
    calendarDate: null,
    grain: "day",
    timezone: TZ,
    resolvedRange: { since: "2026-10-09T16:00:00.000Z", until: "2026-10-12T15:59:59.999Z", untilExclusive: "2026-10-12T16:00:00.000Z", calendarTimezone: TZ },
    range: { since: "2026-10-09T16:00:00.000Z", untilExclusive: "2026-10-12T16:00:00.000Z", inclusiveEnd: "2026-10-12T15:59:59.999Z" },
  };
  const platform = fakePlatform({
    resolveResponses: [threeDays],
    searchPages: [{ total_count: 3, count: 3, nextCursor: null, hasMore: false, results: DAY_ITEMS }],
  });
  const result = await recallScenario({ text: "最近三天聊了什么", now: NOW, timezone: TZ, fetchImpl: platform.fetchImpl, baseUrl: "http://x" });
  assert.equal(result.kind, "answer");
  // 区间查询用 since/until（不是 calendarDate）
  const searchCalls = platform.calls.filter((call) => call.url.endsWith("/v1/search"));
  assert.equal(searchCalls[0].body.calendarDate, undefined, "区间要按 since/until 查");
  assert.equal(searchCalls[0].body.since, "2026-10-09T16:00:00.000Z");
  assert.equal(result.range.untilExclusive, "2026-10-12T16:00:00.000Z");
});
