// INJECT-1 第一段：recallBrief 必须读 curated/shared，否则注入是空壳。
//
// 背景（范围单实测）：recallBrief 原来只读 projectStates/activePlans/tools/recentEpisodes/myExperience，
// 而 688 条记忆全在 curated/shared ⇒ 六个段落全是「（明确的无）」，注入等于没注入。
//
// 这条测试守的是：有记忆就必须出现在「近期记忆」段里，且带 included 回执、≤600 字、可截断标记。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecall } from "../src/recall.mjs";

const PRINCIPAL = { framework_id: "f1", tenant_id: "default", agent_id: "agent-1", role_id: "role-1", group_id: "g1", user_id: "u1" };
// 无 query 时走「近 7 天」窗口，所以这些用例的日期必须落在窗口内（用今天，别写死一个未来会过期的日子）
const DEFAULT_RECENT_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;
const SHANGHAI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const FIXTURE_NOW = Date.now();

function relativeDay(offsetDays) {
  return SHANGHAI_DAY.format(new Date(FIXTURE_NOW + offsetDays * DAY_MS));
}

const TODAY = relativeDay(0);

function assertFixtureInsideDefaultWindow(memories, anchorOffsetDays = 0) {
  const dates = Object.values(memories).map((memory) => memory.calendarDate).sort();
  const earliest = dates[0];
  const latest = dates.at(-1);
  const windowStart = relativeDay(anchorOffsetDays - (DEFAULT_RECENT_DAYS - 1));
  const windowEnd = relativeDay(anchorOffsetDays);
  assert.equal(dates.length, 20, `预算 fixture 必须恰有 20 条，实际 ${dates.length} 条；最早/最晚 ${earliest} → ${latest}`);
  assert.equal(earliest, windowStart, `fixture 最早日期必须等于默认窗口起点 ${windowStart}；实际 ${earliest}，最晚 ${latest}`);
  assert.equal(latest, windowEnd, `fixture 最晚日期必须等于默认窗口终点 ${windowEnd}；实际 ${latest}，最早 ${earliest}`);
  assert.equal(new Set(dates).size, DEFAULT_RECENT_DAYS, `fixture 必须覆盖默认窗口的 ${DEFAULT_RECENT_DAYS} 个日历日；实际 ${new Set(dates).size} 个，${earliest} → ${latest}`);
}

function budgetMemories(anchorOffsetDays = 0) {
  const memories = {};
  for (let i = 0; i < 20; i += 1) {
    memories[`curated-shared-${String(i).padStart(3, "0")}`] = {
      calendarDate: relativeDay(anchorOffsetDays - (i % DEFAULT_RECENT_DAYS)),
      fact: `第${i}条事实：`.padEnd(120, "很长的正文内容用来把预算撑爆"),
    };
  }
  return memories;
}

function memoryFile({ id, calendarDate, visibility = "platform", group_id = "unknown", status = "active", fact }) {
  return `---
id: "${id}"
layer: "long-term"
container: "long-term"
visibility: "${visibility}"
type: "memory"
status: "${status}"
occurred_at: "${calendarDate}T05:00:00.000Z"
valid_from: "${calendarDate}T05:00:00.000Z"
calendarDate: "${calendarDate}"
group_id: "${group_id}"
user_id: "unknown"
kind: "decision"
---
${fact}

> 原话：这是原话
> 日期：${calendarDate}
`;
}

async function makeWorld(memories) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inject1-brief-"));
  const dataRoot = path.join(root, "memory");
  const sharedDir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(sharedDir, { recursive: true });
  for (const [name, spec] of Object.entries(memories)) {
    await fs.writeFile(path.join(sharedDir, `${name}.md`), memoryFile({ id: name, ...spec }), "utf8");
  }
  return { root, dataRoot };
}

test("INJECT-1：brief 必须把 curated/shared 的记忆读出来（原来整段是「明确的无」）", async () => {
  const w = await makeWorld({
    "curated-shared-aaa": { calendarDate: TODAY, fact: "用户决定：记忆库收敛为8层，写入一次到位、零模型直写。" },
    "curated-shared-bbb": { calendarDate: TODAY, fact: "用户要求提炼队列改成最近优先，并给老证据留配额。" },
  });
  try {
    const recall = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root });
    const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt" });

    assert.ok("近期记忆" in brief.sections, "必须新增「近期记忆」段");
    assert.notEqual(brief.sections["近期记忆"], "（明确的无）", "有记忆就不许写「明确的无」");
    assert.match(brief.sections["近期记忆"], /8层/, "事实正文要进段");

    // 回执：id + calendarDate + excerpt
    assert.ok(Array.isArray(brief.included), "必须返回 included 回执");
    assert.equal(brief.included.length, 2);
    const first = brief.included.find((x) => x.id === "curated-shared-aaa");
    assert.ok(first, "回执里要有那条记忆的 id");
    assert.equal(first.calendarDate, TODAY);
    assert.match(first.excerpt, /8层/);
    assert.ok(!("file" in first), "回执不许把本机路径抖出去");

    // 不搬原文全文：excerpt 必须是压过的
    assert.ok(first.excerpt.length <= 120, `excerpt 应当被压缩，实际 ${first.excerpt.length} 字`);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("INJECT-1：≤600 字上限 + 超了要打 truncated", async (t) => {
  const many = budgetMemories();
  assertFixtureInsideDefaultWindow(many);
  const w = await makeWorld(many);
  try {
    const recall = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root });
    const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt", memory_limit_chars: 600 });

    assert.ok(brief.sections["近期记忆"].length <= 600, `记忆段必须 ≤600 字，实际 ${brief.sections["近期记忆"].length}`);
    assert.equal(brief.memory_truncated, true, "撑爆预算时必须打 truncated 标记");
    // 上限内的条数应当是 5~8 之间（范围单要求 top 5~8）
    assert.ok(brief.included.length <= 8, `最多 8 条，实际 ${brief.included.length}`);

    // 整体向未来移动 30 天：fixture 仍相对锚点生成，预算截断判据不随日历腐烂。
    const futureMany = budgetMemories(30);
    assertFixtureInsideDefaultWindow(futureMany, 30);
    const future = await makeWorld(futureMany);
    t.mock.timers.enable({ apis: ["Date"], now: FIXTURE_NOW + 30 * DAY_MS });
    try {
      const futureRecall = createRecall({ dataRoot: future.dataRoot, workspaceRoot: future.root });
      const futureBrief = await futureRecall.recallBrief({ principal: PRINCIPAL, format: "prompt", memory_limit_chars: 600 });
      assert.equal(futureBrief.memory_truncated, true, "系统时钟与 fixture 整体 +30 天后仍必须触发 truncated");
    } finally {
      t.mock.timers.reset();
      await fs.rm(future.root, { recursive: true, force: true });
    }

    // 默认（不撑爆）时不该打 truncated
    const small = await makeWorld({ "curated-shared-one": { calendarDate: "2026-10-03", fact: "一条很短的事实。" } });
    const recall2 = createRecall({ dataRoot: small.dataRoot, workspaceRoot: small.root });
    const brief2 = await recall2.recallBrief({ principal: PRINCIPAL, format: "prompt" });
    assert.equal(brief2.memory_truncated, false, "没超预算就不该打 truncated");
    await fs.rm(small.root, { recursive: true, force: true });
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("INJECT-1：有 query 时按相关度挑，不相关的一条都不许塞进来", async () => {
  const w = await makeWorld({
    "curated-shared-layers": { calendarDate: "2026-10-03", fact: "用户决定：记忆库收敛为8层，写入一次到位、零模型直写。" },
    "curated-shared-food": { calendarDate: "2026-10-05", fact: "用户偏好：午饭喜欢清淡的粤菜，不吃香菜。" },
    "curated-shared-pet": { calendarDate: "2026-10-06", fact: "用户的宠物猫叫豆豆，三岁，怕打雷。" },
  });
  try {
    const recall = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root });
    const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt", query: "我们记忆库是几层？" });

    const ids = brief.included.map((x) => x.id);
    assert.ok(ids.includes("curated-shared-layers"), `必须命中 8 层那条，实际 ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes("curated-shared-food"), "午饭那条与问题无关，不许注入");
    assert.ok(!ids.includes("curated-shared-pet"), "宠物那条与问题无关，不许注入");
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("INJECT-1：没有 query 时按近 7 天取，过期的不进段", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const oldDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(old);
  const w = await makeWorld({
    "curated-shared-new": { calendarDate: today, fact: "今天刚记下的事实，应当出现。" },
    "curated-shared-old": { calendarDate: oldDay, fact: "四十天前的老事实，没有 query 时不该出现。" },
  });
  try {
    const recall = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root });
    const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt", days: 7 });
    const ids = brief.included.map((x) => x.id);
    assert.ok(ids.includes("curated-shared-new"), "7 天内的要出现");
    assert.ok(!ids.includes("curated-shared-old"), "40 天前的不该出现在近 7 天窗口里");
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("INJECT-1：别人的分组记忆不许进段（可见性沿用同一套判据）", async () => {
  const w = await makeWorld({
    "curated-shared-mine": { calendarDate: TODAY, fact: "本组可见的平台记忆。" },
    "curated-shared-other": { calendarDate: TODAY, visibility: "shared", group_id: "another-group", fact: "别的组的私有记忆，不许泄露。" },
    "curated-shared-dead": { calendarDate: TODAY, status: "deprecated", fact: "已废弃的记忆，不许再进段。" },
  });
  try {
    const recall = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root });
    const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt" });
    const ids = brief.included.map((x) => x.id);
    assert.ok(ids.includes("curated-shared-mine"));
    assert.ok(!ids.includes("curated-shared-other"), "跨组 memory 泄漏了");
    assert.ok(!ids.includes("curated-shared-dead"), "deprecated 的不该出现");
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("INJECT-1：一条记忆都没有时，段里必须是「（明确的无）」（不许编）", async () => {
  const w = await makeWorld({});
  try {
    const recall = createRecall({ dataRoot: w.dataRoot, workspaceRoot: w.root });
    const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt" });
    assert.equal(brief.sections["近期记忆"], "（明确的无）");
    assert.deepEqual(brief.included, []);
    assert.equal(brief.memory_truncated, false);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});
