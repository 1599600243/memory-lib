// RANK-1：检索排序（可数属性问法）+ 打包预算（整条进/整条出，绝不半句）。
//
// 守的六件事：
//   ① 问「几层」这类可数属性时，**直接给出那个数量**的句子必须排第 1（改前排在 5–6）；
//   ② 通用性：换个名词/量词（条、个）同一套机制也成立，且**不同数字**都要能命中
//      ⇒ 证明不是写死 8、也不是对某条 id 特判（C5）；
//   ③ 非可数问法的排序与改前逐字一致（不许为了这条把别的问法搞退化）；
//   ④ 预算不够时**整条丢弃、换下一条**：注入文本里每一行都是完整句子，绝不句中断开（C3）；
//   ⑤ 单条超硬上限 ⇒ 整条不进（不是切一半）；整块装不下 ⇒ 也不切断；
//   ⑥ 可观测：`dropped`（含 reason）/`count_unit`/`answer_first`/`rank` 都在回执里。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecall } from "../src/recall.mjs";

const PRINCIPAL = { framework_id: "f1", tenant_id: "default", agent_id: "agent-1", role_id: "role-1", group_id: "g1", user_id: "u1" };
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function memoryFile({ id, calendarDate, visibility = "platform", status = "active", fact }) {
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
group_id: "unknown"
user_id: "unknown"
kind: "decision"
---
${fact}

> 原话：原话略
`;
}

async function makeWorld(memories) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rank1-"));
  const dataRoot = path.join(root, "memory");
  const sharedDir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(sharedDir, { recursive: true });
  for (const [name, spec] of Object.entries(memories)) {
    await fs.writeFile(path.join(sharedDir, `${name}.md`), memoryFile({ id: name, ...spec }), "utf8");
  }
  return { root, dataRoot };
}

async function brief(dataRoot, root, opts = {}) {
  const recall = createRecall({ dataRoot, workspaceRoot: root });
  return recall.recallBrief({ principal: PRINCIPAL, format: "prompt", memory_only: true, ...opts });
}

/** 注入文本的每一行都必须是**完整句子**：以句末标点结尾、且不含省略号（半句的两个特征）。 */
function assertNoHalfSentence(text, label = "注入文本") {
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    if (line.trim() === "（明确的无）") continue;
    assert.ok(/[。；！？!?;]$/u.test(line), `${label} 出现半句（行尾不是句末标点）：${JSON.stringify(line)}`);
    assert.ok(!/…|\.\.\./u.test(line), `${label} 出现省略号（说明被截断）：${JSON.stringify(line)}`);
  }
}

/** 一条注入行里，除标题/日期前缀外的主体。 */
function bodyOf(line) {
  return String(line).replace(/^- \[[^\]]*\]\s*/u, "");
}

test("RANK-1 ①：问「几层」时，含「数字+层」的答案句排第 1（只提名词的长句后面去）", async () => {
  // 干扰项：**逐字复用问法里的词**（记忆/忆库/库一/一共）却不给数字 ⇒ 改前词面权重更高
  const noise = {
    "curated-shared-noise-1": { calendarDate: "2026-10-06", fact: "记忆库库一共的历史里，记忆库一共改过三次口径，每次都要重跑一遍统计。" },
    "curated-shared-noise-2": { calendarDate: "2026-10-05", fact: "记忆库库里那条记忆库一共的旧备注还没清理，先留着当对照。" },
  };
  const answerNumber = 7; // 故意不是 8：证明没有写死任何数字
  const w = await makeWorld({
    ...noise,
    "curated-shared-answer": { calendarDate: "2026-10-04", fact: `用户决定：记忆库一共收敛为${answerNumber}层（A、B、C），写入一次到位。` },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "记忆库一共 几层", memory_limit_chars: 600, memories: 6 });
    assert.equal(b.count_unit, "层", "问法里要认出量词");
    assert.equal(b.answer_first, "curated-shared-answer", "answer_first 要指向答出数量的那条");
    assert.equal(b.included[0].id, "curated-shared-answer", `答案句必须排第 1，实际 ${JSON.stringify(b.included.map((x) => x.id))}`);
    assert.ok(b.text.includes(`${answerNumber}层`), "注入文本里要能看到那个数量");
    assertNoHalfSentence(b.text);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ②/⑤ 通用性：换名词、换量词（条 / 个）、换数字，同一机制都命中（不是特判）", async () => {
  const cases = [
    { query: "验收清单一共 几条", unit: "条", number: 12, noun: "验收清单", fact: "验收清单最后定为12条，每条都要有原始证据。" },
    { query: "网关现在有 几个", unit: "个", number: 3, noun: "网关", fact: "网关现在有3个：入口、回源、旁路。" },
    { query: "归档目录分 几层", unit: "层", number: 6, noun: "归档目录", fact: "归档目录分成6层：冷热两级各三层。" },
  ];
  for (const c of cases) {
    const w = await makeWorld({
      // 干扰项：复述问法、不给数字
      "curated-shared-noise": { calendarDate: "2026-10-06", fact: `${c.noun}${c.noun}的旧口径还没定，${c.noun}到底算不算一条也要再讨论。` },
      "curated-shared-answer": { calendarDate: "2026-10-04", fact: c.fact },
    });
    try {
      const b = await brief(w.dataRoot, w.root, { query: c.query, memory_limit_chars: 600, memories: 6 });
      assert.equal(b.count_unit, c.unit, `${c.query} 应认出量词 ${c.unit}`);
      assert.equal(b.included[0].id, "curated-shared-answer", `${c.query}：答案句必须排第 1，实际 ${JSON.stringify(b.included.map((x) => x.id))}`);
      assert.ok(b.text.includes(`${c.number}${c.unit}`), `${c.query}：注入文本要含 ${c.number}${c.unit}`);
      assertNoHalfSentence(b.text, c.query);
    } finally {
      await fs.rm(w.root, { recursive: true, force: true });
    }
  }
});

test("RANK-1 ③：非可数问法的排序不许变（词面权重优先；同分时仍按改前的日期方向、再按 id）", async () => {
  const w = await makeWorld({
    // 权重最高：把问法里的 6 个 token 全命中
    "curated-shared-strong": { calendarDate: "2026-10-01", fact: "部署流程怎么走：先跑冒烟，再放量。" },
    // 权重最低：只命中一个 token
    "curated-shared-weak": { calendarDate: "2026-10-07", fact: "流程文档放在仓库根目录。" },
    // 同权重两条：只命中 部署/署流/流程 ⇒ 断言"同分按日期（旧在前）"
    "curated-shared-tie-new": { calendarDate: "2026-10-05", fact: "部署流程的旧版是手工拷贝，冒烟环节没有。" },
    "curated-shared-tie-old": { calendarDate: "2026-10-02", fact: "部署流程先跑冒烟再放量，回滚脚本现成可用。" },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "部署流程怎么走", memory_limit_chars: 600, memories: 6 });
    assert.equal(b.count_unit, null, "这不是可数问法，不该认出量词");
    assert.equal(b.answer_first, null);
    const ids = b.included.map((x) => x.id);
    assert.equal(ids[0], "curated-shared-strong", `词面权重最高的排第 1，实际 ${JSON.stringify(ids)}`);
    // 只命中一个 2 字 token 的那条过不了相关度门槛（改前的"宁可少注入"规则，本单不动它）
    assert.ok(!ids.includes("curated-shared-weak"), `够不上门槛的条目仍不许进，实际 ${JSON.stringify(ids)}`);
    const tie = ids.filter((x) => x.startsWith("curated-shared-tie-"));
    assert.deepEqual(tie, ["curated-shared-tie-old", "curated-shared-tie-new"], `同分仍按改前的日期方向（旧在前），实际 ${JSON.stringify(tie)}`);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ④：预算不够就整条丢弃、换下一条 —— 注入文本里不许有半句（C3）", async () => {
  // 8 条都相关、每条首句约 90 字；300 字预算只装得下 3 条 ⇒ 其余必须整条丢、且不切断
  const facts = {};
  for (let i = 0; i < 8; i += 1) {
    facts[`curated-shared-long-${i}`] = {
      calendarDate: `2026-10-0${i + 1}`,
      fact: `记忆库第${i}号事实：${"这一条写得啰嗦，预算不够时应当整条丢掉而不是切成半句".repeat(2)}。`,
    };
  }
  const w = await makeWorld(facts);
  try {
    const b = await brief(w.dataRoot, w.root, { query: "记忆库事实", memory_limit_chars: 300, memories: 8 });
    assert.ok(b.text.length <= 300, `注入文本 ≤300，实际 ${b.text.length}`);
    assertNoHalfSentence(b.text);
    assert.ok(Array.isArray(b.dropped) && b.dropped.length >= 1, `必须有 dropped 回执，实际 ${JSON.stringify(b)}`);
    assert.ok(
      b.dropped.every((d) => ["budget", "top-limit", "too-long", "empty"].includes(d.reason)),
      `dropped 的 reason 要可读：${JSON.stringify(b.dropped)}`,
    );
    // 被预算/上限丢掉的那条，它的正文一个字都不许出现在注入文本里（不是"切了一半"）
    for (const d of b.dropped) {
      const idx = d.id.split("-").at(-1);
      assert.ok(!b.text.includes(`记忆库第${idx}号事实`), `被丢弃的 ${d.id}（${d.reason}）不该有任何片段出现在注入文本里`);
    }
    assert.equal(b.memory_truncated, true, "有丢弃就要打 truncated");
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ④b：首句 90~260 字时也必须**整句**注入（改前会按 90 字切一半再补「…」）", async () => {
  // 一句到底、没有中间句号的长句（约 120 字）：改前 excerpt 上限 90 ⇒ 会被切成半句
  const fact = `记忆库的归档规则：入口、索引、存储、归档四段各有一个独立开关，归档段还有月度与日度两种触发方式，两种触发都必须能单独关掉、也必须能单独触发，不许互相牵连，不许把两段合成一个开关，也不许因为某一段出问题就整体停摆。`;
  assert.ok(fact.length > 90 && fact.length < 260, `夹具长度要在 90~260 之间，实际 ${fact.length}`);
  const w = await makeWorld({ "curated-shared-onesentence": { calendarDate: "2026-10-04", fact } });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "记忆库归档规则", memory_limit_chars: 600, memories: 6 });
    assert.equal(b.included.length, 1);
    assert.ok(b.text.includes("也不许因为某一段出问题就整体停摆。"), `整句必须在，实际 ${JSON.stringify(b.text)}`);
    assert.ok(!b.text.includes("…"), "不许出现截断省略号");
    assert.equal(b.included[0].excerpt, fact, "excerpt 必须是完整那一句");
    assertNoHalfSentence(b.text);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ⑤：单条超硬上限 ⇒ 整条不进（绝不给半句），并记 too-long", async () => {
  const huge = `记忆库超长事实：${"很长的描述".repeat(60)}。`; // 首句 > 260 字
  const w = await makeWorld({
    "curated-shared-huge": { calendarDate: "2026-10-08", fact: huge },
    "curated-shared-small": { calendarDate: "2026-10-02", fact: "记忆库的短事实：一条就够。" },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "记忆库", memory_limit_chars: 600, memories: 6 });
    const hugeDrop = b.dropped.find((d) => d.id === "curated-shared-huge");
    assert.ok(hugeDrop, "超长的那条要出现在 dropped 里");
    assert.equal(hugeDrop.reason, "too-long");
    assert.ok(!b.text.includes("很长的描述"), "超长条一个字都不许进注入文本");
    assert.ok(b.text.includes("记忆库的短事实"), "短的那条照常注入");
    assertNoHalfSentence(b.text);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ⑤b：连第 1 名都装不下 ⇒ 整条不给（宁可不给，也不给半句）", async () => {
  const w = await makeWorld({
    "curated-shared-a": { calendarDate: "2026-10-04", fact: `记忆库分${5}层，${"细节描述".repeat(30)}。` },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "记忆库分几层", memory_limit_chars: 80, memories: 6 });
    assert.equal(b.text, "（明确的无）", `装不下就该明说没有，实际 ${JSON.stringify(b.text)}`);
    assert.ok(!/记忆库分5层/u.test(b.text), "不许露出半句");
    assert.equal(b.included.length, 0);
    assert.ok(b.dropped.some((d) => ["budget", "too-long"].includes(d.reason)), "要记下为什么没给");
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ⑥：回执可观测（rank/chars/answersCount + dropped + used_chars）", async () => {
  const w = await makeWorld({
    "curated-shared-x": { calendarDate: "2026-10-04", fact: "记忆库共9层，A/B/C 三层是检索面。" },
    "curated-shared-y": { calendarDate: "2026-10-03", fact: "记忆库的巡检脚本每周跑一次。" },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "记忆库共几层", memory_limit_chars: 600, memories: 6 });
    assert.equal(b.included[0].rank, 1);
    assert.equal(b.included[0].answersCount, true, "答案条要标记出来");
    assert.ok(b.included[0].chars > 0);
    assert.ok(b.memory_used_chars > 0 && b.memory_used_chars <= 600);
    assert.deepEqual(b.first_pick, { id: "curated-shared-x", chars: b.included[0].chars });
    assert.equal(b.count_unit, "层");
    // sections 与 text 对齐（memory_only 只有一段）
    assert.equal(b.sections["近期记忆"], b.text);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ⑦：答案句不是首句时，注入的是**含数字的那一句**（不是机械取第一句）", async () => {
  const w = await makeWorld({
    "curated-shared-two": {
      calendarDate: "2026-10-04",
      fact: "先记一下背景：这个话题讨论过很多轮。最终结论是检索库一共分4层：入口、索引、存储、归档。后续还要补文档。",
    },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { query: "检索库一共分几层", memory_limit_chars: 600, memories: 6 });
    assert.ok(b.text.includes("4层"), `要挑出答案那一句，实际 ${JSON.stringify(b.text)}`);
    assert.ok(!b.text.includes("先记一下背景"), "不要机械取第一句");
    assertNoHalfSentence(b.text);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});

test("RANK-1 ⑧：没有 query 时行为不变（按近 N 天、整句、不半句）", async () => {
  const w = await makeWorld({
    "curated-shared-recent": { calendarDate: TODAY, fact: `今天记下的事实：${"描述".repeat(50)}。` },
  });
  try {
    const b = await brief(w.dataRoot, w.root, { memory_limit_chars: 600, memories: 6 });
    assert.equal(b.count_unit, null);
    assert.equal(b.included.length, 1);
    assertNoHalfSentence(b.text);
    assert.ok(b.text.length <= 600);
  } finally {
    await fs.rm(w.root, { recursive: true, force: true });
  }
});
