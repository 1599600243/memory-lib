// M2.1-B2 真实数据端到端读数（**只读**）。
//
// 单子要求：
//   "昨天聊了什么"      → 解析出范围 → 按天枚举 → 取回那一天的**全部**原文（条数）
//   "最近三天聊了什么"  → 解析出范围（3 天）→ **逐日**枚举 → 给出三天各自的条数
//   + 给出**不该被解析**的反例
//
// 安全边界（红线）：
//   - **只读**：只用 search/get 身份的读路径；不调用任何写方法；不建索引、不落盘、不调模型。
//   - 用生产身份注册表里**真实存在的只读角色**（默认 pilot-01/reader，actions 只有 search/get）。
//   - 默认数据根 = 生产 `.\data\memory`；可用 `--data-root` 指向副本。
//
// 用法：
//   node scripts/m2-1-b2-live-evidence.mjs
//   node scripts/m2-1-b2-live-evidence.mjs --now 2026-10-15T00:00:00.000Z
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { resolveDateText, listSupportedDateExpressions } from "../src/date-query.mjs";

function arg(name, fallback = null) {
  const hit = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const DATA_ROOT = arg("data-root", "D:\\MemoryLib\\data\\memory");
const REGISTRY = arg("registry", "D:\\MemoryLib\\data\\runtime\\identity.json");
// 默认取**真实当前时刻**（可用 --now 钉死以便复跑/审计）。平台自己不许猜"现在"。
const NOW = arg("now", new Date().toISOString());
const TIMEZONE = arg("timezone", "Asia/Shanghai");
const AGENT = arg("agent", "pilot-01");
const ROLE = arg("role", "reader");
const PAGE = Number(arg("limit", "50"));

const stat = await fs.stat(DATA_ROOT).catch(() => null);
if (!stat?.isDirectory()) {
  console.error(`data root not found: ${DATA_ROOT}`);
  process.exit(2);
}

const registry = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
const framework = (registry.frameworks ?? []).find((item) => (item.agents ?? []).some((agent) => (agent.roles ?? []).some((role) => role.role_id === ROLE)));
const role = framework?.agents.find((agent) => agent.agent_id === AGENT)?.roles.find((item) => item.role_id === ROLE);
if (!role) {
  console.error(`role ${AGENT}/${ROLE} not found in ${REGISTRY}`);
  process.exit(2);
}
const actions = Array.isArray(role.actions) ? role.actions : [];
if (actions.some((action) => ["propose", "promote", "deprecate", "review", "admin"].includes(action))) {
  console.error(`refusing to run with a write-capable role (actions=${JSON.stringify(actions)}); this script is read-only by design`);
  process.exit(2);
}

const principal = {
  framework_id: framework.framework_id,
  agent_id: AGENT,
  role_id: ROLE,
  group_id: role.group_id ?? "unknown",
  user_id: role.user_id ?? "unknown",
  tenant_id: role.tenant_id ?? null,
};

const lib = createMemoryLib({
  dataRoot: DATA_ROOT,
  workspaceRoot: path.dirname(DATA_ROOT),
  principal,
  scopes: null,
  vectorLane: { probe: false },
});

// 枚举一个绝对区间内的**全部**条目（keyset 翻页直到取完）。
async function enumerate(range) {
  const collected = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await lib.timeline({
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
      since: range.since,
      until: range.inclusiveEnd,
    });
    collected.push(...(page.results ?? []).map((item) => ({ id: item.id, capturedAt: item.capturedAt })));
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 500) { console.error("traversal did not terminate; aborting"); break; }
  } while (cursor);
  return {
    pages,
    count: collected.length,
    firstCapturedAt: collected[0]?.capturedAt ?? null,
    lastCapturedAt: collected.at(-1)?.capturedAt ?? null,
    allWithinRange: collected.every((item) => {
      const ms = Date.parse(item.capturedAt);
      return Number.isFinite(ms) && ms >= Date.parse(range.since) && ms <= Date.parse(range.inclusiveEnd);
    }),
  };
}

// 把一个区间按**本地日**逐日拆开，逐日枚举 —— 这样"三天各有几条"是量出来的，不是估的。
// 做法：先解析 since 那一刻落在哪个本地日，然后**用解析器自己**逐日往前推并把每个日区间
// 覆盖起来；只保留**完全落在**总区间内的那些日，保证逐日之和 == 总条数。
// （先前版本用"按小时步进 + 格式化"来推日，实测推出 10-14/15/16 而非 10-13/14/15 —— 已改。）
function localDayOfInstant(instantIso, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instantIso));
}

function enumerateLocalDays(sinceIso, untilExclusiveIso, timezone, nowIso) {
  const days = [];
  const covered = [];
  let day = localDayOfInstant(sinceIso, timezone);
  for (let guard = 0; guard < 400; guard += 1) {
    const resolved = resolveDateText({ text: day, now: nowIso, timezone });
    if (!resolved.ok) break;
    const daySince = Date.parse(resolved.range.since);
    const dayUntil = Date.parse(resolved.range.untilExclusive);
    // 只接受**完整落在**总窗口内的本地日。
    if (daySince >= Date.parse(sinceIso) && dayUntil <= Date.parse(untilExclusiveIso)) {
      days.push({ localDay: day, range: resolved.range });
      covered.push(day);
    }
    const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    if (covered.length && Date.parse(resolved.range.untilExclusive) >= Date.parse(untilExclusiveIso)) break;
    day = next;
  }
  return days;
}

const CASES = [
  { label: "昨天聊了什么", text: "昨天聊了什么", perDay: false },
  { label: "最近三天聊了什么", text: "最近三天聊了什么", perDay: true },
];

const results = [];
for (const testCase of CASES) {
  const resolved = resolveDateText({ text: testCase.text, now: NOW, timezone: TIMEZONE });
  const entry = { input: testCase.label, resolution: resolved.ok ? {
    calendarDate: resolved.calendarDate,
    grain: resolved.grain,
    since: resolved.range.since,
    untilExclusive: resolved.range.untilExclusive,
    assumptions: resolved.assumptions,
  } : { ok: false, reason: resolved.reason, message: resolved.message } };
  if (resolved.ok) {
    entry.total = await enumerate(resolved.range);
    if (testCase.perDay) {
      entry.perDay = [];
      for (const { localDay, range } of enumerateLocalDays(resolved.range.since, resolved.range.untilExclusive, TIMEZONE, NOW)) {
        const enumerated = await enumerate(range);
        entry.perDay.push({ localDay, count: enumerated.count, firstCapturedAt: enumerated.firstCapturedAt, lastCapturedAt: enumerated.lastCapturedAt });
      }
      entry.perDaySum = entry.perDay.reduce((sum, item) => sum + item.count, 0);
      // 判别性：逐日之和必须等于总数，否则"逐日"是错的（会掩盖漏算）。
      entry.perDayMatchesTotal = entry.perDaySum === entry.total.count;
    }
  }
  results.push(entry);
}

// 反例：这些**不许**被解析成日期。
const NON_DATES = ["我买了 3 个苹果", "这个方案有 3 个问题", "第 5 章", "版本 3.0", "上次说的那个", "随便聊聊"];
const rejected = NON_DATES.map((text) => {
  const resolved = resolveDateText({ text, now: NOW, timezone: TIMEZONE });
  return { text, ok: resolved.ok, reason: resolved.ok ? null : resolved.reason, hasRange: "range" in resolved };
});

console.log(JSON.stringify({
  script: "m2-1-b2-live-evidence.mjs",
  readOnly: true,
  dataRoot: DATA_ROOT,
  registry: REGISTRY,
  principal,
  input: { now: NOW, timezone: TIMEZONE, pageSize: PAGE },
  endToEnd: results,
  negativeCases: rejected,
  grammarSize: listSupportedDateExpressions().length,
}, null, 2));
