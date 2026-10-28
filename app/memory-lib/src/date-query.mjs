// M2.1-B1 —— 把「10/10」「昨天」「上周三」这类**人话**归一成绝对日期范围。
//
// 设计边界（全部来自 orders/M2.1-B1 与 research/time-tagging-and-relative-date-parsing.md）：
//   ① **零模型、纯规则**。只有几十条确定规则，无网络、无依赖、可完整测试。
//   ② **不在底层猜"现在"**：`now` / `timezone` 必须由调用方显式给出；缺失即报错。
//   ③ **日期只做结构化字段/过滤，绝不写进正文**。本模块只产出边界，不产出任何正文文本。
//   ④ 不认得的表达**明确失败**，且失败结果**不带 range** —— 防止被当成"全库检索"的危险默认。
//   ⑤ 有歧义时**给出候选、不替用户选**；尤其不许把两天合并成一个查询。
//
// 本模块刻意**不 import 仓库其他模块**：它是叶子节点，既避免循环依赖，
// 也让"规则解析"这块能被独立测（研究结论：库负责识别候选，产品策略负责接受与消歧）。

// ───────────────────────── 时区：Windows 名 → IANA，集中一处 ─────────────────────────
//
// 依据：Unicode CLDR windowsZones.xml（Windows 与 IANA 属不同命名体系，不能字符串互换）。
// 按调研建议**只收录常用子集**并集中维护，避免映射散落各处。
const WINDOWS_TO_IANA = Object.freeze({
  "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "India Standard Time": "Asia/Kolkata",
  "SE Asia Standard Time": "Asia/Bangkok",
  "UTC": "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "UTC-11": "Pacific/Pago_Pago",
  "UTC+12": "Pacific/Auckland",
});

export function toWindowsTimezoneMap() {
  return { ...WINDOWS_TO_IANA };
}

const WINDOWS_LOOKUP = new Map(Object.entries(WINDOWS_TO_IANA).map(([windows, iana]) => [windows.toLowerCase(), iana]));

function isValidIanaZone(zone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

// 归一化时区，并回报"是否发生过 Windows→IANA 翻译"，供审计回显。
export function normalizeTimezone(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "invalid-timezone", message: "timezone is required (an IANA name such as Asia/Shanghai)" };
  const value = raw.trim();
  if (isValidIanaZone(value)) return { ok: true, timezone: value, translatedFrom: null };
  const mapped = WINDOWS_LOOKUP.get(value.toLowerCase());
  if (mapped) return { ok: true, timezone: mapped, translatedFrom: value };
  return { ok: false, reason: "invalid-timezone", message: `unknown time zone: ${value} (expected an IANA name such as Asia/Shanghai)` };
}

// ───────────────────────── 日历算术（只用 UTC 数学，不受进程本地时区影响） ─────────────────────────

const DAY_MS = 86_400_000;

function isRealCalendarDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return false;
  const [year, month, date] = day.split("-").map(Number);
  if (month < 1 || month > 12 || date < 1 || date > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, date));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === date;
}

function formatDay(year, month, date) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

function addCalendarDays(day, days) {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date) + days * DAY_MS);
  return formatDay(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function addCalendarMonths(day, months) {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return formatDay(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, date);
}

function startOfMonth(day) {
  const [year, month] = day.split("-").map(Number);
  return formatDay(year, month, 1);
}

// 某日在一个 weekStartsOn 约定下的"周内序号"（0 = 周首）。
// getUTCDay()：0=周日..6=周六 —— 这里只在纯日历数字上运算，与进程时区无关。
function dayOfWeek(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

function startOfWeek(day, weekStartsOn) {
  const offset = (dayOfWeek(day) - weekStartsOn + 7) % 7;
  return addCalendarDays(day, -offset);
}

// ───────────────────────── 时区 → UTC 投影 ─────────────────────────

const FORMATTER_CACHE = new Map();

function zonedFormatter(timezone) {
  let formatter = FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

// 某时区在某一瞬时相对 UTC 的偏移（毫秒）。
function zonedOffsetMs(instantMs, timezone) {
  const parts = zonedFormatter(timezone).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  // hour12:false 在部分 i&t 组合下会把午夜格式化成 24 点。
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return localAsUtc - Math.floor(instantMs / 1000) * 1000;
}

// 该时区中 `day` 的 startOfDay 对应的 UTC 瞬时。
// 某些时区的本地午夜可能因 offset transition 不存在 —— 迭代求"该日第一个存在的瞬时"。
function zonedStartOfDay(day, timezone) {
  const [year, month, date] = day.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, date, 0, 0, 0, 0);
  let instant = wallClockAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) instant = wallClockAsUtc - zonedOffsetMs(instant, timezone);
  return instant;
}

// 某一瞬时落在该时区的哪个本地日。
function localDayOf(instantMs, timezone) {
  const parts = zonedFormatter(timezone).formatToParts(new Date(instantMs));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// 半开区间 [startOfDay(day), startOfDay(day+1)) —— 见 §硬规则 2。
// endInclusive 只是给已有调用方的便利派生值（= untilExclusive - 1ms），
// 区间真值始终是半开的，且**不是**由"23:59:59.999"或"固定 24 小时"算出来的。
function projectRange(startDay, endDayExclusive, timezone) {
  const sinceMs = zonedStartOfDay(startDay, timezone);
  const untilMs = zonedStartOfDay(endDayExclusive, timezone);
  return {
    since: new Date(sinceMs).toISOString(),
    untilExclusive: new Date(untilMs).toISOString(),
    inclusiveEnd: new Date(untilMs - 1).toISOString(),
  };
}

// ───────────────────────── 文本归一化 ─────────────────────────

// 全角 → 半角（数字与常见日期分隔符），并折叠空白。
function normalizeText(raw) {
  return String(raw ?? "")
    .replace(/[\uFF10-\uFF19]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF0F]/gu, "/")
    .replace(/[\uFF0D\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\uFF0E]/gu, ".")
    .replace(/\s+/gu, " ")
    .trim()
    // 「10 月 10 号」这类**人话里夹空格**的写法：只在与日期单位/数字相邻时去空格，
    // 不做通用去空格（否则会把「10/10 我们聊了什么」这种空格也吃掉）。
    .replace(/(\d)\s+(?=[年月日号])/gu, "$1")
    .replace(/([年月号])\s+(?=\d)/gu, "$1")
    .replace(/(\d)\s+(?=\d\s*[年月日号])/gu, "$1");
}

// 去掉"问句外壳"与**口语尾巴**，只留时间表达。
// 例：「10/10 我们聊了什么」→「10/10」；「10/10 那天」→「10/10」。
// 注意：外壳必须是**已知词**；去掉后剩下的部分仍要能独立解析，
// 否则整句判为 no-match —— 不允许"从长句里挑一个数字就当日期"。
const QUESTION_WRAPPERS = [
  "那天我们聊了什么", "那天我们说了什么", "我们都聊了什么", "我们都说了什么",
  "我们聊了什么", "我们说了什么", "我们干了什么", "我们做了什么",
  "那天聊了什么", "那天说了什么", "都聊了什么", "都说了什么",
  "聊了什么", "说了什么", "干了什么", "做了什么", "聊了啥", "说了啥",
  "那天", "这天", "当天",
];

function stripQuestionWrapper(text) {
  const candidates = [];
  for (const wrapper of [...QUESTION_WRAPPERS].sort((a, b) => b.length - a.length)) {
    if (text.endsWith(wrapper)) {
      const head = text.slice(0, text.length - wrapper.length).trim();
      if (head) candidates.push(head);
    }
    if (text.startsWith(wrapper)) {
      const tail = text.slice(wrapper.length).trim();
      if (tail) candidates.push(tail);
    }
  }
  // 尾巴词与时间表达之间可能带一个"的"：「三天前的」→「三天前」。
  for (const candidate of [...candidates]) {
    const trimmed = candidate.replace(/的$/u, "").trim();
    if (trimmed && trimmed !== candidate) candidates.push(trimmed);
  }
  return [...new Set(candidates)];
}

// ───────────────────────── 表达式规则表 ─────────────────────────

const MONTH_FIRST_LOCALES = /^(zh|ja|ko|en-US|en-PH|en-CA|en-BZ|en-JM|fil|tl)/iu;
const DAY_FIRST_LOCALES = /^(en-GB|en-AU|en-NZ|en-IE|en-ZA|en-IN|en-SG|de|fr|es|it|pt|nl|ru|pl|sv|da|fi|nb|no|tr|id|vi|th|hi)/iu;

function localeDateOrder(locale) {
  if (typeof locale !== "string" || !locale.trim()) return "unknown";
  const value = locale.trim();
  if (DAY_FIRST_LOCALES.test(value)) return "day-first";
  if (MONTH_FIRST_LOCALES.test(value)) return "month-first";
  return "unknown";
}

const WEEKDAY_TOKENS = Object.freeze({ "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 });
const WEEKDAY_NAMES = Object.freeze({ 0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday" });

// 中文数字 → 阿拉伯数字。只覆盖时间表达的常用范围（一…九十九），
// 用于「三天前」「近两周」这类写法。**不做通用中文数字解析**（那会引入歧义）。
const CN_DIGITS = Object.freeze({ "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 });

function cnNumber(token) {
  if (/^\d+$/u.test(token)) return Number(token);
  if (token === "十") return 10;
  // 十X / X十 / X十Y
  const tenMatch = /^(?:([一二两三四五六七八九])?十([一二三四五六七八九])?)$/u.exec(token);
  if (tenMatch) return (tenMatch[1] ? CN_DIGITS[tenMatch[1]] : 1) * 10 + (tenMatch[2] ? CN_DIGITS[tenMatch[2]] : 0);
  if (Object.hasOwn(CN_DIGITS, token)) return CN_DIGITS[token];
  return null;
}

// 本单支持的**全部**表达（对外暴露，供文档与漂移检查）。
// 顺序即文档顺序：从无歧义的绝对形式，到相对/窗口/区间，最后是未来表达。
export function listSupportedDateExpressions() {
  return [
    // 绝对日期
    { pattern: "YYYY-MM-DD", example: "2026-10-10", grain: "day", yearInferred: false },
    { pattern: "YYYY/M/D", example: "2026/10/10", grain: "day", yearInferred: false },
    { pattern: "YYYY年M月D日", example: "2026年10月10日", grain: "day", yearInferred: false },
    // 缺年
    { pattern: "M/D", example: "10/10", grain: "day", yearInferred: true },
    { pattern: "M-D", example: "10-10", grain: "day", yearInferred: true },
    { pattern: "M月D日/号", example: "10月10日", grain: "day", yearInferred: true },
    // 相对日
    { pattern: "今天", example: "今天", grain: "day", yearInferred: false },
    { pattern: "昨天", example: "昨天", grain: "day", yearInferred: false },
    { pattern: "前天", example: "前天", grain: "day", yearInferred: false },
    { pattern: "大前天", example: "大前天", grain: "day", yearInferred: false },
    { pattern: "N天前", example: "三天前", grain: "day", yearInferred: false },
    // 未来
    { pattern: "明天", example: "明天", grain: "day", yearInferred: false },
    { pattern: "后天", example: "后天", grain: "day", yearInferred: false },
    { pattern: "大后天", example: "大后天", grain: "day", yearInferred: false },
    // 周
    { pattern: "本周X", example: "本周三", grain: "day", yearInferred: false },
    { pattern: "上周X", example: "上周三", grain: "day", yearInferred: false },
    { pattern: "下X / 下周X", example: "下周三", grain: "day", yearInferred: false },
    { pattern: "本周 / 这周", example: "本周", grain: "week", yearInferred: false },
    { pattern: "上周", example: "上周", grain: "week", yearInferred: false },
    { pattern: "上上周", example: "上上周", grain: "week", yearInferred: false },
    { pattern: "下周", example: "下周", grain: "week", yearInferred: false },
    // 月
    { pattern: "这个月 / 本月", example: "这个月", grain: "month", yearInferred: false },
    { pattern: "上个月 / 上上个月", example: "上个月", grain: "month", yearInferred: false },
    { pattern: "下个月", example: "下个月", grain: "month", yearInferred: false },
    { pattern: "上个月N号", example: "上个月15号", grain: "day", yearInferred: false },
    // 滚动窗口
    { pattern: "最近N天 / 近N天", example: "最近三天", grain: "day", yearInferred: false },
    { pattern: "近N周 / 最近N周", example: "近一周", grain: "week", yearInferred: false },
    { pattern: "近N个月 / 最近N个月", example: "近三个月", grain: "month", yearInferred: false },
    // 区间
    { pattern: "A到B（两个日粒度端点）", example: "上周一到上周三", grain: "day", yearInferred: false },
    { pattern: "M月D号到M月D号", example: "10月1号到10月7号", grain: "day", yearInferred: false },
    // 口语尾巴（与裸表达等价）
    { pattern: "表达式 + 那天", example: "10/10 那天", grain: "day", yearInferred: false },
  ];
}

// 用于**竞争表达检测**的锚定模式（只取日/周/月粒度的"整块"时间表达）。
// 只用它来判断"一句话里出现了几个互不相容的时间表达"，不用于取值。
const EXPRESSION_SPOTTERS = Object.freeze([
  /^\d{4}年\d{1,2}月\d{1,2}[日号]?/u,
  /^\d{4}-\d{2}-\d{2}/u,
  /^\d{4}[/.]\d{1,2}[/.]\d{1,2}/u,
  /^\d{1,2}月\d{1,2}[日号]/u,
  /^\d{1,2}[/-]\d{1,2}/u,
  /^(?:上上|上|本|这|下)(?:周|星期|礼拜)[一二三四五六日天]/u,
  /^(?:上上|上|本|这|下)(?:周|星期|礼拜)/u,
  /^(?:大)?(?:今天|昨天|前天|明天|后天)/u,
  /^[0-9一二两三四五六七八九十]+(?:天|周|个月|月)前/u,
  /^(?:最近|近)[0-9一二两三四五六七八九十]+(?:天|周|个月|月)/u,
  /^(?:上上|上)个月[0-9一二两三四五六七八九十]+[日号]/u,
]);

function spotExpressions(text) {
  const found = [];
  let index = 0;
  while (index < text.length) {
    let best = null;
    for (const spotter of EXPRESSION_SPOTTERS) {
      const match = spotter.exec(text.slice(index));
      if (match && match[0] && (!best || match[0].length > best.length)) best = match[0];
    }
    if (!best) { index += 1; continue; }
    found.push({ text: best, start: index, end: index + best.length });
    index += best.length;
  }
  return found;
}

// 显式区间的连接词。
const RANGE_SEPARATORS = /(?:到|至|~|～|-{1,2}>?)/u;

// ───────────────────────── 主入口 ─────────────────────────

function failure(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/**
 * 把一个人话时间表达归一成绝对日期范围。
 *
 * @param {object} input
 * @param {string} input.text      时间表达（也可以是"10/10 我们聊了什么"这类整句）
 * @param {string} input.now       ISO 瞬时，解析相对时间的锚点（**必填，不许猜**）
 * @param {string} input.timezone  IANA 时区名，或已收录的 Windows 名（**必填**）
 * @param {string} [input.locale]  如 "zh-CN"；缺省 zh-CN；显式传 null/"" 表示"locale 未知"
 * @param {number} [input.weekStartsOn] 0=周日, 1=周一（默认）。只影响"本周/上周"的锚点
 */
export function resolveDateText({ text, now, timezone, locale, weekStartsOn } = {}) {
  const zoneResult = normalizeTimezone(timezone);
  if (!zoneResult.ok) return failure(zoneResult.reason, zoneResult.message);
  const zone = zoneResult.timezone;

  if (typeof now !== "string" || !now.trim()) return failure("invalid-now", "now is required (an ISO instant) so relative expressions can be anchored");
  const nowMs = Date.parse(now.trim());
  if (!Number.isFinite(nowMs)) return failure("invalid-now", `now is not a valid ISO instant: ${now}`);

  const resolvedLocale = locale === undefined ? "zh-CN" : (typeof locale === "string" && locale.trim() ? locale.trim() : null);
  const weekStart = weekStartsOn === undefined || weekStartsOn === null ? 1 : Number(weekStartsOn);
  if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
    return failure("invalid-week-start", `weekStartsOn must be an integer 0..6 (0=Sunday, 1=Monday), got: ${weekStartsOn}`);
  }

  const normalized = normalizeText(text);
  if (!normalized) return failure("no-match", "no time expression found in the input");

  const context = { referenceDay: localDayOf(nowMs, zone), locale: resolvedLocale, weekStart, timezone: zone };
  const attempts = [normalized, ...stripQuestionWrapper(normalized)];

  for (const candidate of attempts) {
    // ① 单个表达（含"滚动窗口"这类本身就是区间的表达）。
    const single = parseExpression(candidate, context);
    if (single) {
      if (!single.ok) return single; // 认得出形状但内容非法 ⇒ 如实回报，不继续退化
      return finish({ parsed: single, normalized, zone, translatedFrom: zoneResult.translatedFrom, nowIso: new Date(nowMs).toISOString(), locale: resolvedLocale, weekStart });
    }
    // ② 显式区间 A到B。**区间优先于"把多个表达并起来"**。
    const range = parseExplicitRange(candidate, context);
    if (range) {
      if (!range.ok) return range;
      return finish({ parsed: range, normalized, zone, translatedFrom: zoneResult.translatedFrom, nowIso: new Date(nowMs).toISOString(), locale: resolvedLocale, weekStart });
    }
    // ③ 一句话里有**多个互不相容**的时间表达：给候选，**不许**取并集或随便挑一个
    //    （那会把用户的一个问题悄悄放大成更大的查询）。
    const competing = competingExpressions(candidate);
    if (competing) {
      return failure("ambiguous", `more than one time expression found: ${competing.map((item) => item.text).join(" / ")}; please ask about one of them`, {
        ambiguous: { candidates: competing.map((item) => ({ calendarDate: null, sourceText: item.text, rationale: `expression found at position ${item.start}` })) },
      });
    }
  }
  return failure("no-match", `unrecognised time expression: ${text}`);
}

/**
 * 显式区间入口：与 resolveDateText 同一套语法、同一个响应形状。
 * 存在的意义是让调用方**显式表达"我这次要的是区间"**，而不必依赖优先级规则去推断。
 */
export function resolveDateRangeText(input = {}) {
  return resolveDateText(input);
}

// 找出互相不重叠、且**不是**一个区间两端的多个时间表达。
// 「上周三到本周一」的两端由 range 处理，不会走到这里。
function competingExpressions(text) {
  const found = spotExpressions(text);
  if (found.length < 2) return null;
  const [first, second] = found;
  const gap = text.slice(first.end, second.start);
  // 两端之间有区间连接词 ⇒ 那是区间，不是竞争。
  if (RANGE_SEPARATORS.test(gap)) return null;
  // 同一段文字里出现两个独立表达 ⇒ 竞争。
  return found;
}

// 把解析出的日历结构投影成 UTC 边界并组装响应。
function finish({ parsed, normalized, zone, translatedFrom, nowIso, locale, weekStart }) {
  const range = projectRange(parsed.startDay, parsed.endDayExclusive, zone);
  const assumptions = [...(parsed.assumptions ?? [])];
  if (translatedFrom) assumptions.unshift(`timezone "${translatedFrom}" translated to "${zone}" (CLDR windowsZones)`);
  return {
    ok: true,
    sourceText: normalized,
    now: nowIso,
    timezone: zone,
    locale,
    weekStartsOn: weekStart,
    grain: parsed.grain,
    calendarDate: parsed.calendarDate ?? null,
    yearInferred: Boolean(parsed.yearInferred),
    assumptions,
    // 单子点名的输出字段：绝对时间边界。
    // `until` 取**闭**口径（= 区间最后一毫秒），与仓库既有 since/until 一致，
    // 调用方可直接把这两个值透给按天枚举，不必自己换算。
    // 区间真值仍是半开 `[since, untilExclusive)`；`until` 是它的派生便利值。
    resolvedRange: {
      since: range.since,
      until: range.inclusiveEnd,
      untilExclusive: range.untilExclusive,
      timezone: zone,
    },
    range,
    ruleVersion: "date-query-v1",
  };
}

function parseExpression(token, context) {
  const { referenceDay, locale, weekStart } = context;

  // ① 绝对日期，年份写全 —— 最高优先级，无歧义。
  let match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(token);
  if (match) return absoluteDay(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/u.exec(token);
  if (match) return absoluteDay(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{4})年(\d{1,2})月(\d{1,2})[日号]?$/u.exec(token);
  if (match) return absoluteDay(Number(match[1]), Number(match[2]), Number(match[3]));

  // ② 上（上）个月N号 —— 必须排在裸 `M月D号` 之前，否则"上个月"会被前导吃掉。
  match = /^(上上|上)个月([0-9]{1,2}|[一二两三四五六七八九十]+)[日号]$/u.exec(token);
  if (match) {
    const monthsBack = match[1] === "上上" ? 2 : 1;
    const dayNumber = cnNumber(match[2]);
    if (dayNumber === null) return null;
    const monthStart = addCalendarMonths(startOfMonth(referenceDay), -monthsBack);
    // absoluteDay 会做真实日历校验：该月没有这一天（如 2 月 30 日）就报 invalid-date，
    // **不会**滚到相邻月份。
    return absoluteDay(Number(monthStart.slice(0, 4)), Number(monthStart.slice(5, 7)), dayNumber);
  }

  // ③ 相对日：今天/昨天/前天/大前天 + 未来 明天/后天/大后天。
  const dayOffsets = { "今天": 0, "今日": 0, "昨天": -1, "昨日": -1, "前天": -2, "大前天": -3, "明天": 1, "明日": 1, "后天": 2, "大后天": 3 };
  if (token in dayOffsets) return singleDay(addCalendarDays(referenceDay, dayOffsets[token]));

  // ④ N天前 / N周前 / N个月前（中文数字也认）。
  match = /^([0-9]+|[一二两三四五六七八九十]+)(天|周|个?月)前$/u.exec(token);
  if (match) {
    const amount = cnNumber(match[1]);
    if (amount === null) return null;
    const unit = match[2];
    if (unit === "天") return singleDay(addCalendarDays(referenceDay, -amount));
    if (unit === "周") return daySpan(addCalendarDays(referenceDay, -7 * amount), 1, "day", [`"${token}" anchored at ${referenceDay}`]);
    return daySpan(startOfMonth(addCalendarMonths(startOfMonth(referenceDay), -amount)), 1, "day", [`"${token}" resolved to a calendar month, not a fixed 30 days`]);
  }

  // ⑤ 滚动窗口：最近N天 / 近N周 / 近N个月（含 N=1）。
  match = /^(?:最近|近)([0-9]+|[一二两三四五六七八九十]+)(天|周|个?月)$/u.exec(token);
  if (match) {
    const amount = cnNumber(match[1]);
    if (amount === null) return null;
    if (amount < 1) return failure("invalid-date", `"${token}" needs a positive count`);
    const unit = match[2];
    const rolling = `"${token}" is a rolling window ending today (inclusive)`;
    if (unit === "天") return daySpan(addCalendarDays(referenceDay, -(amount - 1)), amount, "day", [rolling]);
    if (unit === "周") return daySpan(addCalendarDays(referenceDay, -(7 * amount - 1)), 7 * amount, "week", [rolling]);
    // 近N个月 = 含本月在内的 N 个完整日历月。
    const start = addCalendarMonths(startOfMonth(referenceDay), -(amount - 1));
    return daySpan(start, 0, "month", [rolling], addCalendarMonths(startOfMonth(referenceDay), 1));
  }

  // ⑥ 周：上上周X / 上周X / 本周X / 下周X，以及裸 周三。
  match = /^(上上|上|本|这|下)(周|星期|礼拜)([一二三四五六日天])$/u.exec(token);
  if (match) {
    const weekDay = WEEKDAY_TOKENS[match[3]];
    const start = weekStartFor(referenceDay, weekStart, match[1]);
    const day = addCalendarDays(start, (weekDay - weekStart + 7) % 7);
    return singleDay(day, [`week starts on ${WEEKDAY_NAMES[weekStart]}`, `"${match[1]}${match[2]}" anchored at ${start}`]);
  }

  // 裸「周三」= 本周三（记忆检索多数问过去，裸写不推下周）。
  match = /^(?:周|星期|礼拜)([一二三四五六日天])$/u.exec(token);
  if (match) {
    const start = weekStartFor(referenceDay, weekStart, "本");
    const day = addCalendarDays(start, (WEEKDAY_TOKENS[match[1]] - weekStart + 7) % 7);
    return singleDay(day, [`week starts on ${WEEKDAY_NAMES[weekStart]}`, `bare weekday treated as this week's`]);
  }

  // ⑦ 周（整周）与月（整月）。
  if (/^(本周|这周|本星期|这星期|本礼拜|这礼拜)$/u.test(token)) {
    const start = weekStartFor(referenceDay, weekStart, "本");
    return daySpan(start, 7, "week", [`week starts on ${WEEKDAY_NAMES[weekStart]}`]);
  }
  if (/^(上周|上星期|上礼拜)$/u.test(token)) {
    const start = weekStartFor(referenceDay, weekStart, "上");
    return daySpan(start, 7, "week", [`week starts on ${WEEKDAY_NAMES[weekStart]}`]);
  }
  if (/^(上上周|上上星期|上上礼拜)$/u.test(token)) {
    const start = addCalendarDays(weekStartFor(referenceDay, weekStart, "上"), -7);
    return daySpan(start, 7, "week", [`week starts on ${WEEKDAY_NAMES[weekStart]}`, `"上上周" = two whole weeks before this week`]);
  }
  if (/^(下周|下星期|下礼拜)$/u.test(token)) {
    const start = weekStartFor(referenceDay, weekStart, "下");
    return daySpan(start, 7, "week", [`week starts on ${WEEKDAY_NAMES[weekStart]}`]);
  }

  if (/^(这个月|本月|这月|当月)$/u.test(token)) {
    const start = startOfMonth(referenceDay);
    return daySpan(start, 0, "month", [`calendar month of ${referenceDay}`], addCalendarMonths(start, 1));
  }
  if (/^(上个月|上月)$/u.test(token)) {
    const start = addCalendarMonths(startOfMonth(referenceDay), -1);
    return daySpan(start, 0, "month", [`previous calendar month of ${referenceDay}`], addCalendarMonths(start, 1));
  }
  if (/^(上上个月|上上月)$/u.test(token)) {
    const start = addCalendarMonths(startOfMonth(referenceDay), -2);
    return daySpan(start, 0, "month", [`two calendar months before ${referenceDay}`], addCalendarMonths(start, 1));
  }
  // 未来月：与「下周」「明天」同属未来表达，语法上不该留这个洞（实测「下个月」曾是 no-match）。
  if (/^(下个月|下月)$/u.test(token)) {
    const start = addCalendarMonths(startOfMonth(referenceDay), 1);
    return daySpan(start, 0, "month", [`next calendar month after ${referenceDay}`], addCalendarMonths(start, 1));
  }

  // ⑧ 缺年数字日期 —— 最后才认，且受 locale 影响。
  match = /^(\d{1,2})月(\d{1,2})[日号]?$/u.exec(token);
  if (match) return yearLessDay(Number(match[1]), Number(match[2]), context, "month/day (Chinese M月D日)");

  match = /^(\d{1,2})[/-](\d{1,2})$/u.exec(token);
  if (match) return numericAmbiguous(Number(match[1]), Number(match[2]), context);

  // ⚠️ 刻意**不**支持 `M.D`（如 `10.10`）：单子点名的形式只有 `10/10`、`10-10`、`10月10日`。
  // 点号形式与版本号 / 小数 / 章节号 / IP 片段的冲突最强，而脱离上下文时
  // `10.10`、`3.14`、`1.2` 这类**本来就无法判定**是不是日期。
  // 依据 research/time-tagging-and-relative-date-parsing.md「防数字冲突」：
  // 要求边界、排除版本号/小数/IP/金额。宁可**明确失败**（no-match），也不静默把
  // `3.14` 当成 3 月 14 日 —— 那正是"猜"，而本单要求不认得的表达必须失败。
  return null;
}

// 单日结果（供上面各分支复用）。
function singleDay(day, assumptions = []) {
  if (!isRealCalendarDay(day)) return failure("invalid-date", `${day} is not a real calendar date (it must not be rolled over into an adjacent month)`);
  return { ok: true, startDay: day, endDayExclusive: addCalendarDays(day, 1), grain: "day", calendarDate: day, yearInferred: false, assumptions };
}

// 区间结果：默认按「起始日 + N 天」推结束；也可显式给结束日（月粒度用）。
function daySpan(startDay, days, grain, assumptions = [], explicitEndDay = null) {
  if (!isRealCalendarDay(startDay)) return failure("invalid-date", `${startDay} is not a real calendar date`);
  const endDayExclusive = explicitEndDay ?? addCalendarDays(startDay, days);
  if (!isRealCalendarDay(endDayExclusive)) return failure("invalid-date", `${endDayExclusive} is not a real calendar date`);
  return {
    ok: true, startDay, endDayExclusive, grain,
    calendarDate: null, yearInferred: false, assumptions,
  };
}

// week prefix → 该周的周首日。上上周 = 上周再退一周。
function weekStartFor(referenceDay, weekStart, prefix) {
  const thisWeek = startOfWeek(referenceDay, weekStart);
  if (prefix === "下") return addCalendarDays(thisWeek, 7);
  if (prefix === "上") return addCalendarDays(thisWeek, -7);
  if (prefix === "上上") return addCalendarDays(thisWeek, -14);
  return thisWeek;
}

// 区间端点：**必须是日粒度**。周/月粒度端点会悄悄放大范围，一律拒绝。
// 额外支持**裸星期**（「周一到周三」）：两天都取本周内各自的星期几。
function parseDayEndpoint(token, context) {
  const bare = /^(?:周|星期|礼拜)([一二三四五六日天])$/u.exec(token);
  if (bare) {
    const start = weekStartFor(context.referenceDay, context.weekStart, "本");
    const day = addCalendarDays(start, (WEEKDAY_TOKENS[bare[1]] - context.weekStart + 7) % 7);
    return singleDay(day, [`week starts on ${WEEKDAY_NAMES[context.weekStart]}`, "bare weekday treated as this week's"]);
  }
  const spot = spotExpressions(token);
  if (spot.length !== 1 || spot[0].text !== token) return null;
  const parsed = parseExpression(token, context);
  if (!parsed) return null;
  if (!parsed.ok) return parsed;
  if (parsed.grain !== "day" || !parsed.calendarDate) return null;
  return parsed;
}

function firstRangeSeparator(text) {
  // 连接词白名单。⚠️ 单破折号只有在**两边是空白**时才算连接词：
  // 否则 ISO 日期 `2026-10-01` 的内部连字符会被误判成分隔符
  // （实测就是这样把 `2026-10-01到2026-10-07` 拆坏的）。
  const PATTERNS = [
    /\s*(?:到|至)\s*/u,
    /\s*[~～]\s*/u,
    /\s*->\s*/u,
    /\s+-\s+/u,
  ];
  for (let index = 1; index < text.length; index += 1) {
    for (const pattern of PATTERNS) {
      const match = pattern.exec(text.slice(index));
      if (!match || match.index !== 0 || !match[0]) continue;
      const left = text.slice(0, index).trim();
      const right = text.slice(index + match[0].length).trim();
      if (!left || !right) continue;
      return { index, separator: match[0], left, right };
    }
  }
  return null;
}

// 显式区间 A到B：两端各自按**同一个时区**解析；端点必须落到具体某一天。
function parseExplicitRange(token, context) {
  const hit = firstRangeSeparator(token);
  if (!hit) return null;
  const left = hit.left;
  const right = hit.right;
  if (!left || !right) return null;

  const start = parseDayEndpoint(left, context);
  const end = parseDayEndpoint(right, context);
  if (!start || !end) return null;
  if (!start.ok) return start;
  if (!end.ok) return end;

  // 用户可能说反（先写晚的、再写早的）：按时间顺序归一，并把这次交换**写进 assumptions**，
  // 不许静默改语义。
  const reversed = start.calendarDate > end.calendarDate;
  const startDay = reversed ? end.calendarDate : start.calendarDate;
  const endDay = reversed ? start.calendarDate : end.calendarDate;
  const assumptions = [
    `"${left}".."${right}" resolved in ${context.timezone}`,
    ...(reversed ? [`reversed range swapped into chronological order: ${start.calendarDate} <- ${end.calendarDate}`] : []),
  ];
  return {
    ok: true,
    startDay,
    endDayExclusive: addCalendarDays(endDay, 1),
    grain: "day",
    calendarDate: null,
    yearInferred: Boolean(start.yearInferred || end.yearInferred),
    assumptions,
  };
}

function absoluteDay(year, month, date) {
  const day = formatDay(year, month, date);
  if (!isRealCalendarDay(day)) {
    return failure("invalid-date", `${year}-${month}-${date} is not a real calendar date (it must not be rolled over into an adjacent month)`);
  }
  return { ok: true, startDay: day, endDayExclusive: addCalendarDays(day, 1), grain: "day", calendarDate: day, yearInferred: false, assumptions: [] };
}

function currentWeekStart(referenceDay, weekStart, prefix) {
  const thisWeek = startOfWeek(referenceDay, weekStart);
  return prefix === "上" ? addCalendarDays(thisWeek, -7) : thisWeek;
}

function yearLessDay(month, date, context, rationale) {
  const year = Number(context.referenceDay.slice(0, 4));
  const day = formatDay(year, month, date);
  if (!isRealCalendarDay(day)) {
    return failure("invalid-date", `${month}/${date} is not a real calendar date (it must not be rolled over into an adjacent month)`);
  }
  return {
    ok: true, startDay: day, endDayExclusive: addCalendarDays(day, 1), grain: "day",
    calendarDate: day, yearInferred: true,
    assumptions: [`year = ${year} (from now)`, `interpreted as ${rationale}`],
  };
}

function numericAmbiguous(first, second, context) {
  const order = localeDateOrder(context.locale);
  if (order === "day-first") return yearLessDay(second, first, context, "day/month (locale is day-first)");
  if (order === "month-first") return yearLessDay(first, second, context, "month/day (locale is month-first)");

  // locale 未知：两种读法都合法且给出**不同**的日期 ⇒ 有歧义，给候选，不替用户选。
  const asMonthFirst = yearLessDay(first, second, context, "month/day (US-style)");
  const asDayFirst = yearLessDay(second, first, context, "day/month (European-style)");
  const candidates = [asMonthFirst, asDayFirst].filter((candidate) => candidate.ok);
  const dates = [...new Set(candidates.map((candidate) => candidate.calendarDate))];

  if (dates.length === 1) return candidates[0]; // 两种读法落到同一天 ⇒ 其实没有歧义（如 10/10）
  if (dates.length === 0) return asMonthFirst;   // 两种读法都不是真实日期 ⇒ 如实报 invalid-date
  return failure(
    "ambiguous",
    `"${first}/${second}" can be read two ways and no locale was given; please disambiguate`,
    {
      ambiguous: {
        candidates: candidates.map((candidate) => ({
          calendarDate: candidate.calendarDate,
          rationale: candidate.assumptions.at(-1),
          range: projectRange(candidate.startDay, candidate.endDayExclusive, context.timezone ?? "UTC"),
        })),
      },
    },
  );
}
