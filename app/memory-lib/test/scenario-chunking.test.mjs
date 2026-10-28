// SCENARIO-2：大日子 —— 「取全」+「分批素材」（**红测试先行**）。
//
// 真实数据里一天可能上百条（本机实测 2026-10-07 的本地日 **177** 条，每条 excerpt 400 字符
// ⇒ 全天素材约 7 万字符）。于是有两条风险必须钉死：
//   ① **取全**不能因为分页/上限而少给；
//   ② 取全**不等于**一次全塞给模型 —— 平台要能按**显式预算**把一天切成接入方直接可用的批次，
//      而且**一条都不许丢**。
//
// 分批只做**切分**：不摘要、不改写、不生成（零模型）。
import assert from "node:assert/strict";
import test from "node:test";
import { chunkItems, recallScenario } from "../src/scenario-recall.mjs";

const NOW = "2026-10-12T04:00:00.000Z";
const TZ = "Asia/Shanghai";

function item(index, { chars = 400, id = null } = {}) {
  return {
    id: id ?? `item-${String(index).padStart(3, "0")}`,
    path: `evidence/conversations/item-${index}.md`,
    capturedAt: new Date(Date.parse("2026-10-06T16:00:00.000Z") + index * 60_000).toISOString(),
    excerpt: "x".repeat(chars),
  };
}

// ─────────────────── ① 分批：并集必须等于当天取全 ───────────────────

test("chunking preserves EVERY item: union equals the day, no loss and no duplication", () => {
  const items = Array.from({ length: 177 }, (_, index) => item(index));
  const chunks = chunkItems(items, { maxCharsPerChunk: 8_000 });
  const flattened = chunks.flatMap((chunk) => chunk.items.map((entry) => entry.id));

  assert.equal(flattened.length, items.length, "块内条目总数必须等于当天条目数");
  assert.equal(new Set(flattened).size, items.length, "不许重复");
  assert.deepEqual(flattened, items.map((entry) => entry.id), "顺序也必须保持一致");
  assert.equal(chunks.length, Math.ceil(177 * 400 / 8_000), "177×400 字符 / 8000 ⇒ 9 块");
});

test("every chunk reports its own count, size, time span and item identity", () => {
  const items = Array.from({ length: 10 }, (_, index) => item(index));
  const chunks = chunkItems(items, { maxCharsPerChunk: 1_200 });
  for (const chunk of chunks) {
    assert.equal(chunk.count, chunk.items.length, "块内条数要自洽");
    assert.equal(chunk.chars, chunk.items.reduce((sum, entry) => sum + entry.excerpt.length, 0), "块字符数要自洽");
    assert.ok(chunk.since, "要有时间跨度下界");
    assert.ok(chunk.until, "要有时间跨度上界");
    for (const entry of chunk.items) {
      assert.ok(entry.id && entry.capturedAt && typeof entry.excerpt === "string", "块内条目要带 id/时间/摘要");
    }
  }
});

test("the explicit character budget is honoured for every chunk", () => {
  const items = Array.from({ length: 50 }, (_, index) => item(index, { chars: 300 }));
  const budget = 1_000;
  const chunks = chunkItems(items, { maxCharsPerChunk: budget });
  for (const chunk of chunks) {
    assert.ok(chunk.chars <= budget, `块字符数 ${chunk.chars} 超过预算 ${budget}`);
    assert.equal(chunk.oversized, undefined, "正常块不该被标成超限");
  }
});

// ─────────────────── ④ 单条本身超限：不许静默截断 ───────────────────

test("an entry larger than the budget gets its own chunk and is flagged, never truncated", () => {
  const items = [item(0, { chars: 100 }), item(1, { chars: 5_000 }), item(2, { chars: 100 })];
  const chunks = chunkItems(items, { maxCharsPerChunk: 1_000 });
  const oversizedChunks = chunks.filter((chunk) => chunk.oversized);
  assert.equal(oversizedChunks.length, 1, "超限的那条要**单独成块**并标注");
  assert.equal(oversizedChunks[0].items.length, 1);
  assert.equal(oversizedChunks[0].items[0].id, "item-001");
  assert.equal(oversizedChunks[0].items[0].excerpt.length, 5_000, "**不许截断**原文摘要");
  // 并集依旧完整
  assert.equal(chunks.flatMap((chunk) => chunk.items).length, 3);
});

// ─────────────────── ③ 空日 / 极少条目：退化成 1 块，不许产生空块 ───────────────────

test("an empty day produces no chunks at all, not one empty chunk", () => {
  assert.deepEqual(chunkItems([], { maxCharsPerChunk: 1_000 }), []);
});

test("a single entry produces exactly one chunk", () => {
  const chunks = chunkItems([item(0, { chars: 50 })], { maxCharsPerChunk: 1_000 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].count, 1);
  assert.equal(chunks[0].oversized, undefined);
});

// ─────────────────── ① 取全：单日条目数 > 一页上限时仍要取全 ───────────────────

test("a day larger than one page is still taken whole (total_count is the referee)", async () => {
  const total = 177;
  const pageSize = 100; // 服务端上限
  const all = Array.from({ length: total }, (_, index) => ({ ...item(index), path: `p${index}` }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/v1/date/resolve")) {
      return { status: 200, json: async () => ({ ok: true, calendarDate: "2026-10-07", grain: "day", timezone: TZ, resolvedRange: { since: "2026-10-06T16:00:00.000Z", until: "2026-10-07T15:59:59.999Z", untilExclusive: "2026-10-07T16:00:00.000Z", calendarTimezone: TZ }, range: { since: "2026-10-06T16:00:00.000Z", untilExclusive: "2026-10-07T16:00:00.000Z", inclusiveEnd: "2026-10-07T15:59:59.999Z" } }) };
    }
    const cursor = body.cursor ?? null;
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + pageSize);
    const next = start + slice.length < all.length ? String(start + slice.length) : null;
    return { status: 200, json: async () => ({ total_count: total, count: slice.length, nextCursor: next, hasMore: next !== null, results: slice }) };
  };

  const result = await recallScenario({ text: "10/7 我们聊了什么", now: NOW, timezone: TZ, fetchImpl, baseUrl: "http://x", pageSize });

  const searchCalls = calls.filter((call) => call.url.endsWith("/v1/search"));
  assert.equal(searchCalls.length, 2, "177 条 / 每页 100 ⇒ 两页");
  assert.equal(result.count, 177, "取回条数必须等于 total_count");
  assert.equal(result.totalCount, 177);
  assert.equal(result.complete, true);
  assert.equal(new Set(result.items.map((entry) => entry.id)).size, 177, "不许重复");
});

// ─────────────────── 与召回结果联动：分批接在取全之后 ───────────────────

test("recallScenario can hand back chunks alongside the items, with the same completeness", async () => {
  const total = 12;
  const all = Array.from({ length: total }, (_, index) => ({ ...item(index), path: `p${index}` }));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/v1/date/resolve")) {
      return { status: 200, json: async () => ({ ok: true, calendarDate: "2026-10-07", grain: "day", timezone: TZ, resolvedRange: { since: "2026-10-06T16:00:00.000Z", until: "2026-10-07T15:59:59.999Z", untilExclusive: "2026-10-07T16:00:00.000Z", calendarTimezone: TZ }, range: { since: "2026-10-06T16:00:00.000Z", untilExclusive: "2026-10-07T16:00:00.000Z", inclusiveEnd: "2026-10-07T15:59:59.999Z" } }) };
    }
    return { status: 200, json: async () => ({ total_count: total, count: total, nextCursor: null, hasMore: false, results: all }) };
  };
  const result = await recallScenario({ text: "10/7 我们聊了什么", now: NOW, timezone: TZ, fetchImpl, baseUrl: "http://x", chunkChars: 1_200 });
  assert.equal(result.complete, true);
  assert.ok(Array.isArray(result.chunks), "带上分批后的素材");
  assert.equal(result.chunks.flatMap((chunk) => chunk.items).length, result.count, "分批并集必须等于当天取全");
  assert.equal(result.chunkChars, 1_200, "回显预算参数，接入方知道按什么切的");
  // 分批只是切分：内容仍与 items 逐条一致
  assert.deepEqual(result.chunks.flatMap((chunk) => chunk.items.map((entry) => entry.id)), result.items.map((entry) => entry.id));
});

test("real-scale day: 177 entries x 400 chars chunk losslessly at the documented budget", () => {
  // 这批数字**来自真实库实测**（2026-10-07 的本地日 = 177 条，每条 excerpt 恰好 400 字符，
  // 全天 70,397 字符）。用真实规模跑一遍，避免"小样本通过、真实规模静默少给"。
  const items = Array.from({ length: 177 }, (_, index) => item(index, { chars: 400 }));
  const chunks = chunkItems(items, { maxCharsPerChunk: 8_000 });
  assert.equal(chunks.length, 9, "实测：默认预算下 177 条 = 9 块");
  assert.equal(chunks.flatMap((chunk) => chunk.items).length, 177, "一条都不许丢");
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.chars, 0), 70_800, "字符总量守恒（177×400）");
  assert.equal(chunks.filter((chunk) => chunk.oversized).length, 0, "400 字符远小于预算，不该有超限块");
});

test("the documented budget/block-count table is reproduced exactly", () => {
  // 契约文档 §5.1 那张表就是这些数字；一旦实现变化，这张表必须跟着被发现。
  const items = Array.from({ length: 177 }, (_, index) => item(index, { chars: 400 }));
  const expected = { 2000: 36, 4000: 18, 8000: 9, 16000: 5, 32000: 3 };
  for (const [budget, blocks] of Object.entries(expected)) {
    const chunks = chunkItems(items, { maxCharsPerChunk: Number(budget) });
    assert.equal(chunks.length, Number(blocks), `chunkChars=${budget} 应切成 ${blocks} 块`);
    assert.equal(chunks.flatMap((chunk) => chunk.items).length, 177, `chunkChars=${budget} 下不许丢条目`);
  }
});

test("chunking never rewrites the material (it is slicing, not summarising)", () => {
  const items = Array.from({ length: 5 }, (_, index) => item(index, { chars: 40 }));
  const chunks = chunkItems(items, { maxCharsPerChunk: 100 });
  for (const chunk of chunks) {
    for (const entry of chunk.items) {
      const original = items.find((candidate) => candidate.id === entry.id);
      assert.equal(entry.excerpt, original.excerpt, "摘要必须逐字节来自原条目");
    }
  }
});
