// DAYRECALL-1 evidence script.
//
// 为什么有这个脚本：验收岗**不采信开发写的测试当唯一证据**（`ACCEPTANCE.md` §4 第 ⑥ 条）。
// 这里的两个勘验都**不依赖** memory-lib 的日期实现：
//   ① `expected`  段只用 `Intl.DateTimeFormat` 与算术，独立算出「某时区某个本地日」的
//      UTC 半开窗口，用来对照被测代码给出的 `resolvedRange`；
//   ② `tail` 段用 `Intl` 直接判定「某个 capturedAt 落在哪个本地日」，
//      用来对照 code 实际把条目归入哪一天。
// 两个勘验都只读：自己建临时 dataRoot，不碰 `.\data`。
//
// 用法：node scripts/dayrecall-evidence.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- ① 独立算出本地日的 UTC 窗口（不使用被测代码） ----------------------------
function offsetMsAt(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function expectedWindow(day, timezone) {
  const [year, month, date] = day.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, date, 0, 0, 0, 0);
  let start = wallClockAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) start = wallClockAsUtc - offsetMsAt(start, timezone);
  const nextDay = Date.UTC(year, month - 1, date + 1, 0, 0, 0, 0);
  let nextStart = nextDay;
  for (let attempt = 0; attempt < 3; attempt += 1) nextStart = nextDay - offsetMsAt(nextStart, timezone);
  return { since: new Date(start).toISOString(), until: new Date(nextStart - 1).toISOString() };
}

function expectedLocalDay(instant, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

// ---- ② 用被测代码取同一天的 resolvedRange，并核对条目归属 ----------------------
const CASES = [
  { calendarDate: "2026-10-10", timezone: "UTC" },
  { calendarDate: "2026-10-10", timezone: "Asia/Shanghai" },
  { calendarDate: "2026-10-10", timezone: "America/Los_Angeles" },
  { calendarDate: "2026-10-10", timezone: "Australia/Lord_Howe" },
  { calendarDate: "2026-03-08", timezone: "America/Los_Angeles" },
];

// 三条 capturedAt：跨 UTC/上海/洛杉矶的日界，用来判断「同一瞬时不同时区归不同本地日」。
const INSTANTS = [
  "2026-10-09T23:30:00.000Z",
  "2026-10-10T00:30:00.000Z",
  "2026-10-10T07:30:00.000Z",
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dayrecall-evidence-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });
for (const [index, instant] of INSTANTS.entries()) {
  await fs.writeFile(path.join(root, `item-${index}.md`), [
    "---", `id: item-${index}`, "type: conversation", `capturedAt: ${instant}`,
    'groupId: "g"', 'userId: "u"', "---", "", `body-${index}`,
  ].join("\n"), "utf8");
}

const lib = createMemoryLib({
  dataRoot: tmp, workspaceRoot: tmp,
  principal: { group_id: "g", user_id: "u" },
  resolvedRoots: [root], vectorLane: { probe: false },
});

const windows = [];
for (const testCase of CASES) {
  const page = await lib.timeline({ calendarDate: testCase.calendarDate, calendarTimezone: testCase.timezone, limit: 100 });
  const expected = expectedWindow(testCase.calendarDate, testCase.timezone);
  windows.push({
    calendarDate: testCase.calendarDate,
    timezone: testCase.timezone,
    codeResolvedRange: { since: page.resolvedRange.since, until: page.resolvedRange.until },
    independentlyComputed: expected,
    matches: page.resolvedRange.since === expected.since && page.resolvedRange.until === expected.until,
    matchedIds: page.results.map((item) => item.id),
    matchedIdsIndependentlyExpected: INSTANTS
      .map((instant, index) => ({ id: `item-${index}`, day: expectedLocalDay(instant, testCase.timezone) }))
      .filter((item) => item.day === testCase.calendarDate)
      .map((item) => item.id),
  });
}

// 同一瞬时在不同时区归入不同本地日 —— 逐条列出来，而不是只给一个总数。
const perInstant = INSTANTS.map((instant) => ({
  instant,
  localDayByTimezone: Object.fromEntries(CASES.map((c) => [c.timezone, expectedLocalDay(instant, c.timezone)])),
}));

console.log(JSON.stringify({
  script: "dayrecall-evidence.mjs",
  note: "独立勘验：expected* 字段不来自被测代码，只用 Intl 与算术；codeResolvedRange / matchedIds 来自 createMemoryLib().timeline()。",
  generatedAt: new Date().toISOString(),
  perInstantLocalDay: perInstant,
  windows,
  allWindowsMatch: windows.every((w) => w.matches),
  allMembershipsMatch: windows.every((w) => JSON.stringify(w.matchedIds) === JSON.stringify(w.matchedIdsIndependentlyExpected)),
}, null, 2));

await fs.rm(tmp, { recursive: true, force: true });
