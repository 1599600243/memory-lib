// M2.1-B1 真实数据端到端读数（**只读**）。
//
// 用途：单子要求证明「10/10 我们聊了什么」这条链在**真实库**上走得通，而不只在自造 fixture 上。
// 本脚本：
//   ① 用**纯规则**解析「10/10 我们聊了什么」→ 绝对范围（钉死 now，保证可复跑/可审计）；
//   ② 用该范围调**已有的按天枚举**（keyset 翻页直到 nextCursor=null），数那一共多少条；
//   ③ 打印每条的 id 与 capturedAt，便于独立核对"是不是那一天的"。
//
// 安全边界（红线）：
//   - **只读**：只用 search/get 身份的读路径；不调用任何写方法；不建索引、不落盘、不调模型。
//   - 以生产身份注册表里**真实存在的只读角色**（默认 pilot-01/reader，actions 只有 search/get）构造 principal。
//   - 默认数据根 = 生产 `D:\MemoryLib\data\memory`；可用 `--data-root` 指向副本。
//
// 用法：
//   node scripts/m2-1-b1-live-evidence.mjs
//   node scripts/m2-1-b1-live-evidence.mjs --text "10/10" --now 2026-10-15T00:00:00.000Z --timezone Asia/Shanghai
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
const TEXT = arg("text", "10/10 我们聊了什么");
// 默认取**真实当前时刻**（可用 `--now` 钉死以便复跑/审计）。
// 单子的措辞是"now = 现在的本地时间"；之所以必须由调用方显式传进来，
// 正是因为平台**不许**在底层猜"现在" —— 这个"现在"要能写进证据、能被重放。
const NOW = arg("now", new Date().toISOString());
const TIMEZONE = arg("timezone", "Asia/Shanghai");
const AGENT = arg("agent", "pilot-01");
const ROLE = arg("role", "reader");
const PAGE = Number(arg("limit", "3"));

// 数据根不存在 ⇒ 明确报错退出，绝不"静默返回 0 条"（那会把"没读到"伪装成"那天没聊过"）。
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
// 只读守卫：万一有人把脚本指向了可写角色，这里直接拦下。
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

// ① 纯规则解析（零模型）。
const resolved = resolveDateText({ text: TEXT, now: NOW, timezone: TIMEZONE });

// ② 只读枚举（keyset 翻页直到取完）。
const lib = createMemoryLib({
  dataRoot: DATA_ROOT,
  workspaceRoot: path.dirname(DATA_ROOT),
  principal,
  scopes: null,
  vectorLane: { probe: false },
});

let enumeration = null;
if (resolved.ok) {
  const collected = [];
  let cursor = null;
  let pages = 0;
  let resolvedRange = null;
  do {
    const page = await lib.timeline({
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
      ...(resolved.calendarDate
        ? { calendarDate: resolved.calendarDate, calendarTimezone: resolved.timezone }
        : { since: resolved.range.since, until: resolved.range.inclusiveEnd }),
    });
    resolvedRange = page.resolvedRange;
    collected.push(...(page.results ?? []).map((item) => ({ id: item.id, capturedAt: item.capturedAt, path: item.path })));
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 500) { console.error("traversal did not terminate within 500 pages; aborting"); break; }
  } while (cursor);
  enumeration = {
    pages,
    count: collected.length,
    ids: collected.map((item) => item.id),
    firstCapturedAt: collected[0]?.capturedAt ?? null,
    lastCapturedAt: collected.at(-1)?.capturedAt ?? null,
    allWithinRange: collected.every((item) => {
      const ms = Date.parse(item.capturedAt);
      return Number.isFinite(ms) && ms >= Date.parse(resolved.range.since) && ms < Date.parse(resolved.range.untilExclusive);
    }),
    evidencePaths: collected.map((item) => item.path),
    resolvedRange,
  };
}

console.log(JSON.stringify({
  script: "m2-1-b1-live-evidence.mjs",
  readOnly: true,
  dataRoot: DATA_ROOT,
  registry: REGISTRY,
  principal,
  input: { text: TEXT, now: NOW, timezone: TIMEZONE, pageSize: PAGE },
  resolution: resolved,
  enumeration,
  supportedExpressions: listSupportedDateExpressions().map((entry) => entry.example),
}, null, 2));
