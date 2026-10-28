// REFINE-LOOP-1 单元测试：去重 / 状态机 / 重试上限 / 死信 / 首败不整队 / status 可查
// 运行：node --test .\scripts\refine-worker.test.mjs
// 全部用注入的假 extract/write，不联网、不碰生产 data。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeText,
  contentHash,
  bigramJaccard,
  splitEvidenceFile,
  summarizeState,
  runRefine,
  loadState,
  isNearDuplicate,
  normalizeReason,
  NEAR_DUP_THRESHOLD,
  requeueEntries,
  eventInstantOf,
  zonedDayStartIso,
  // REFINE-LOOP-3：最近优先 + 防饿死
  computeOldSlots,
  planRefineOrder,
  compareNewestFirst,
  compareOldestFirst,
  parseNewestFirst,
  parseOldQuota,
} from "./refine-worker.mjs";

const evidence = (eventId, day, userText) => `---
eventId: ${eventId}
calendarDate: ${day}
capturedAt: ${day}T10:00:00.000Z
---

## 用户
${userText}

## 助手
好的，我记下了。
`;

async function makeWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "refine-loop-1-"));
  const evidenceDir = path.join(root, "evidence");
  const dataRoot = path.join(root, "memory");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(path.join(dataRoot, "curated", "shared"), { recursive: true });
  return { root, evidenceDir, dataRoot, stateFile: path.join(root, "state", "refine-state.json") };
}

// 足够长（>120 字门槛）、且不是告警前缀，才能进入"该提炼"分支
const LONG = "我们决定把提炼 worker 改成每次起新进程，状态全部落在 state 文件里，不做常驻内存队列，这样重启不会丢进度也不会重复写。另外重试上限定三次，超了就进死信，失败原因要记下来，且第一条失败绝对不许打断整队处理。提炼失败的三次都要留下原因，不许静默跳过，也不许把整队卡住。";

// 逐字原话：必须是上面 LONG 里的**原样子串**（worker 会校验，编的原话会被丢掉）
const QUOTE = "重试上限定三次，超了就进死信";

// 平凡改写：只换标点/加一个"的"，用来验证确定性近义层（≥0.92）确实生效
const TRIVIAL_A = LONG.replace("，状态全部落在", "；状态全部落在");
const TRIVIAL_B = TRIVIAL_A.replace("不做常驻内存队列", "不做常驻的内存队列");

test("normalizeText / contentHash：空白与标点不敏感，语义不同的句子不撞哈希", () => {
  assert.equal(normalizeText("甲，乙。丙！"), normalizeText("甲 乙 丙"));
  assert.equal(contentHash("甲，乙。丙！"), contentHash("甲 乙 丙"));
  assert.notEqual(contentHash("用户偏好中文回答"), contentHash("用户偏好英文回答"));
});

test("bigramJaccard 校准：平凡改写≥阈值，中度改写落在阈值下（所以语义判重交给模型）", (t) => {
  const trivial = TRIVIAL_B;
  const moderate = "提炼器改成每轮起一个新进程，进度全存在 state 文件，不用常驻内存队列，重启不丢进度也不重复写，失败三次就进死信并记原因。";
  const unrelated = "明天下午三点在三楼会议室开季度复盘会，记得带上上季度的数据报表和人员名单。";
  const identical = bigramJaccard(LONG, LONG);
  const trivialScore = bigramJaccard(LONG, trivial);
  const moderateScore = bigramJaccard(LONG, moderate);
  const unrelatedScore = bigramJaccard(LONG, unrelated);
  t.diagnostic(`identical=${identical.toFixed(3)} trivial=${trivialScore.toFixed(3)} moderate=${moderateScore.toFixed(3)} unrelated=${unrelatedScore.toFixed(3)} threshold=${NEAR_DUP_THRESHOLD}`);
  assert.equal(identical, 1);
  assert.ok(trivialScore >= NEAR_DUP_THRESHOLD, `平凡改写 ${trivialScore.toFixed(3)} 应高于阈值 ${NEAR_DUP_THRESHOLD}`);
  assert.ok(moderateScore < NEAR_DUP_THRESHOLD, `中度改写 ${moderateScore.toFixed(3)} 应低于阈值 ${NEAR_DUP_THRESHOLD}（字符相似度判不动语义）`);
  assert.ok(unrelatedScore < 0.2, `不相关 ${unrelatedScore.toFixed(3)} 应远低于阈值`);

  // 决定性的一条：一字之差的**不同事实**（三次 vs 五次）在长句里相似度高达 0.97 ——
  // 光看相似度会把两个不同的决定并成一条。所以相似度达标后还要过"决定性 token"这一关。
  const differentFact = LONG.replace("重试上限定三次", "重试上限定五次");
  const differentScore = bigramJaccard(LONG, differentFact);
  const differentVerdict = isNearDuplicate(LONG, differentFact);
  t.diagnostic(`different-fact score=${differentScore.toFixed(3)} duplicate=${differentVerdict.duplicate} reason=${differentVerdict.reason}`);
  assert.ok(differentScore >= NEAR_DUP_THRESHOLD, "长句里改一个数字，相似度仍会高过阈值（这就是必须加决定性 token 守卫的原因）");
  assert.equal(differentVerdict.duplicate, false, "三次 vs 五次 是两个不同决定，绝不能被判成重复");
  assert.equal(differentVerdict.reason, "decisive-token-differs");

  // 同一事实的平凡改写：相似度达标且决定性 token 一致 ⇒ 判重
  assert.equal(isNearDuplicate(LONG, TRIVIAL_B).duplicate, true);
  // 同一事实、但否定词不同 ⇒ 语义相反，绝不判重
  assert.equal(isNearDuplicate("用户要求报告首行必须写 STATUS: READY", "用户要求报告首行不必写 STATUS: READY").duplicate, false);
});

test("证据内容变了（partial→complete）必须重新提炼；内容没变不重复劳动", async () => {
  const w = await makeWorld();
  const file = path.join(w.evidenceDir, "a.md");
  await fs.writeFile(file, evidence("ev-a", "2026-10-10", LONG));
  let calls = 0;
  const extract = async () => { calls += 1; return { memories: [{ text: `记忆-${calls}`, evidence_quote: QUOTE, kind: "fact" }] }; };
  const write = async ({ memory }) => ({ id: `m-${contentHash(memory.text)}` });
  const base = { evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot, extract, write, log: () => {} };

  await runRefine(base);
  assert.equal(calls, 1);
  await runRefine(base);
  assert.equal(calls, 1, "内容没变不该再调模型");

  // 补全：同一个 eventId，正文变长了
  await fs.writeFile(file, evidence("ev-a", "2026-10-10", LONG + "补全：还要求死信里的条目不许阻塞后续新证据的处理。"));
  const third = await runRefine(base);
  assert.equal(calls, 2, "内容变了必须重新提炼");
  assert.equal(third.reprocessed, 1);
});

test("老状态没有 evidence_hash 时不重跑历史 done（升级安全）", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.mkdir(path.dirname(w.stateFile), { recursive: true });
  await fs.writeFile(w.stateFile, JSON.stringify({ version: 1, evidence: { "ev-a": { status: "done", attempts: 0, at: "2026-10-18T00:00:00.000Z", memories: 1 } }, memories: {} }), "utf8");
  let calls = 0;
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => { calls += 1; return { memories: [] }; },
    write: async () => ({ id: "x" }),
    log: () => {},
  });
  assert.equal(calls, 0, "没有指纹的老条目按 done 处理，不重跑");
  assert.equal(result.skipped, 1);
});

test("逐条落盘：处理第二条时，第一条的 done 已经写进 state 文件（进程被杀也不丢进度）", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  let observed = "未观察到";
  const order = [];
  await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async ({ id }) => {
      order.push(id);
      // REFINE-LOOP-3 之后默认是"最近优先"，所以先从哪条开始不再固定。
      // 这条测试要守的是"**前一条**处理完必须已经落盘"，与顺序无关 —— 因此按实际顺序取前一条。
      if (order.length === 2) {
        const first = order[0];
        observed = (await loadState(w.stateFile)).evidence[first]?.status ?? "缺失";
      }
      return { memories: [{ text: `记忆-${id}-乙`, evidence_quote: QUOTE, kind: "fact" }] };
    },
    write: async ({ evidenceId }) => ({ id: `m-${evidenceId}` }),
    log: () => {},
  });
  assert.equal(order.length, 2, "两条都要处理");
  assert.equal(observed, "done", "前一条处理完必须立刻落盘，否则进程被杀就白跑");
});

test("写入侧失败：状态记 failed + 原因，其他证据照常写", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async ({ id }) => ({ memories: [{ text: `记忆-${id}-甲`, evidence_quote: QUOTE, kind: "fact" }] }),
    write: async ({ evidenceId }) => { if (evidenceId === "ev-a") throw new Error("HTTP 401: invalid credential"); return { id: `m-${evidenceId}` }; },
    log: () => {},
  });
  assert.equal(result.written, 1, "ev-b 必须照常写进去");
  assert.equal(result.failed, 1);
  const state = await loadState(w.stateFile);
  assert.equal(state.evidence["ev-a"].status, "failed");
  assert.match(state.evidence["ev-a"].reason, /write: HTTP 401/);
  assert.equal(state.evidence["ev-b"].status, "done");
});

test("日期口径：capturedAt 的 UTC 瞬时要按 Asia/Shanghai 落到本地日", () => {
  // 20:02Z 在上海已是次日 —— 直接切字符串会差一天
  const raw = "---\nid: conversation-x\neventId: 39304809-723f-481b-9e31-c4643599d0ae#turn-1\ncapturedAt: 2026-09-15T20:02:49.132Z\n---\n\n## 用户\n\n" + LONG;
  assert.equal(splitEvidenceFile(raw).calendarDate, "2026-09-16", "默认时区必须是 Asia/Shanghai");
  assert.equal(splitEvidenceFile(raw, { timeZone: "UTC" }).calendarDate, "2026-09-15");
  // 有 calendarDate 字段时以它为准，不做二次换算
  const explicit = raw.replace("capturedAt:", "calendarDate: 2026-10-07\ncapturedAt:");
  assert.equal(splitEvidenceFile(explicit).calendarDate, "2026-10-07");
});

test("splitEvidenceFile：解出 eventId/日期/角色消息", () => {
  const parsed = splitEvidenceFile(evidence("ev-1", "2026-10-10", LONG));
  assert.equal(parsed.id, "ev-1");
  assert.equal(parsed.calendarDate, "2026-10-10");
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].role, "user");
  assert.match(parsed.userText, /提炼 worker/);
});

test("首败不整队 + 失败带原因：一条炸了，后面的照做", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  await fs.writeFile(path.join(w.evidenceDir, "c.md"), evidence("ev-c", "2026-10-12", LONG + "乙"));

  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async ({ id }) => {
      if (id === "ev-a") throw new Error("LLM HTTP 401: invalid api key");
      return { memories: [{ text: `记忆-${id}`, evidence_quote: QUOTE, kind: "fact" }] };
    },
    write: async ({ memory }) => ({ id: `m-${contentHash(memory.text)}` }),
    maxAttempts: 3,
    log: () => {},
  });

  assert.equal(result.failed, 1, "应有 1 条失败");
  assert.equal(result.written, 2, "另外 2 条必须照常写入（首败不许 break 整队）");
  const state = await loadState(w.stateFile);
  assert.equal(state.evidence["ev-a"].status, "failed");
  assert.equal(state.evidence["ev-a"].attempts, 1);
  assert.match(state.evidence["ev-a"].reason, /401/);
  assert.equal(state.evidence["ev-b"].status, "done");
  assert.equal(state.evidence["ev-c"].status, "done");
});

test("重试上限 3：第 4 次不再尝试，转死信；仍不阻塞其他条目", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));

  let aAttempts = 0;
  const extract = async ({ id }) => {
    if (id === "ev-a") { aAttempts += 1; throw new Error("LLM HTTP 500: boom"); }
    return { memories: [{ text: `记忆-${id}`, evidence_quote: QUOTE, kind: "fact" }] };
  };
  const write = async ({ memory }) => ({ id: `m-${contentHash(memory.text)}` });
  const base = { evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot, extract, write, maxAttempts: 3, log: () => {} };

  for (let i = 0; i < 3; i += 1) await runRefine(base);
  let state = await loadState(w.stateFile);
  assert.equal(state.evidence["ev-a"].attempts, 3);
  assert.equal(state.evidence["ev-a"].status, "dead", "超上限必须进死信");
  assert.match(state.evidence["ev-a"].reason, /500/);
  assert.equal(state.evidence["ev-b"].status, "done");

  await runRefine(base);
  assert.equal(aAttempts, 3, "第 4 次不许再调模型");
  state = await loadState(w.stateFile);
  assert.equal(state.evidence["ev-b"].status, "done");
});

test("内容哈希去重：抽出同一句话，第二条不再写库", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  const writes = [];
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => ({ memories: [{ text: "用户要求报告首行必须写 STATUS: READY。", evidence_quote: QUOTE, kind: "preference" }] }),
    write: async ({ memory }) => { writes.push(memory.text); return { id: `m-${writes.length}` }; },
    log: () => {},
  });
  assert.equal(writes.length, 1, "同一句话只许写一次");
  assert.equal(result.dedupedHash, 1);
});

test("近义去重（确定性层）：只差标点/个别字的平凡改写也不再写第二条", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  const texts = [TRIVIAL_A, TRIVIAL_B];
  let i = 0;
  const writes = [];
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => ({ memories: [{ text: texts[Math.min(i++, 1)], evidence_quote: QUOTE, kind: "decision" }] }),
    write: async ({ memory }) => { writes.push(memory.text); return { id: `m-${writes.length}` }; },
    log: () => {},
  });
  assert.equal(writes.length, 1, "平凡改写的同一件事只许写一次");
  assert.equal(result.dedupedNear, 1);
});

test("近义去重（模型层）：模型判 duplicate_of 时不写第二条", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  const writes = [];
  let call = 0;
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => {
      call += 1;
      // 第二次给一句"换个说法"的事实，字符相似度只有 0.6 左右 —— 只能靠模型判重
      if (call === 1) return { memories: [{ text: "提炼 worker 每次起新进程，进度全部落在 state 文件，不做常驻内存队列，重试上限三次超了进死信。", evidence_quote: QUOTE, kind: "decision" }] };
      return { memories: [{ text: "提炼器一轮一个新进程，进度存在 state 文件，不用内存队列，失败三次进死信。", evidence_quote: QUOTE, kind: "decision", duplicate_of: "m-1" }] };
    },
    write: async ({ memory }) => { writes.push(memory.text); return { id: `m-${writes.length}` }; },
    log: () => {},
  });
  assert.equal(writes.length, 1, "模型判了重复就不许再写");
  assert.equal(result.dedupedModel, 1);
});

test("已有的 curated 文件也进去重基线（不只比 state 里的）", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.dataRoot, "curated", "shared", "curated-shared-old.md"), `---\nid: curated-shared-old\nlayer: long-term\nvisibility: shared\n---\n\n提炼 worker 改成每次起新进程，状态全部落在 state 文件里，不做常驻内存队列。\n`);
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  const writes = [];
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => ({ memories: [{ text: "提炼 worker 改成每次起新进程，状态全部落在 state 文件里，不做常驻内存队列。", evidence_quote: QUOTE, kind: "decision" }] }),
    write: async ({ memory }) => { writes.push(memory.text); return { id: "x" }; },
    log: () => {},
  });
  assert.equal(writes.length, 0, "与既有 curated 重复的不许再写");
  assert.equal(result.dedupedHash + result.dedupedNear, 1, "既有 curated 已记过同一件事，必须被哈希或近义挡住");
});

test("死链与短文本：跳过并记原因，不算失败", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "short.md"), evidence("ev-short", "2026-10-10", "嗯"));
  await fs.writeFile(path.join(w.evidenceDir, "alert.md"), evidence("ev-alert", "2026-10-10", "【触发器告警】poller 停止 记住这条"));
  await fs.writeFile(path.join(w.evidenceDir, "ok.md"), evidence("ev-ok", "2026-10-10", LONG));
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => ({ memories: [{ text: "一条真记忆。", evidence_quote: QUOTE, kind: "fact" }] }),
    write: async () => ({ id: "id-1" }),
    log: () => {},
  });
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 0);
  const state = await loadState(w.stateFile);
  assert.equal(state.evidence["ev-short"].status, "skipped");
  assert.equal(state.evidence["ev-alert"].status, "skipped");
  assert.match(state.evidence["ev-alert"].reason, /skip-/);
});

test("dry 模式：一条都不写，也不改 state", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  let writes = 0;
  await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot, dry: true,
    extract: async () => ({ memories: [{ text: "一条真记忆。", evidence_quote: QUOTE, kind: "fact" }] }),
    write: async () => { writes += 1; return { id: "x" }; },
    log: () => {},
  });
  assert.equal(writes, 0);
  const exists = await fs.access(w.stateFile).then(() => true, () => false);
  assert.equal(exists, false, "dry 不落 state");
});

test("normalizeReason：不同 request_id 的同一类失败必须聚成一行", () => {
  const a = normalizeReason('extract: LLM HTTP 401: {"error":{"message":"Auth Fails","request_id": 3ef38e5e-9af9-4e47-8146-f7a10b1cffd9}}');
  const b = normalizeReason('extract: LLM HTTP 401: {"error":{"message":"Auth Fails","request_id": c8facdea-48be-4259-8644-2f95c1926594}}');
  assert.equal(a, b);
});

test("last_success_at：一整轮全是去重命中（没写新记忆）也算成功，全失败则不更新", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  const quota = [
    { memories: [{ text: "同一句话。", evidence_quote: QUOTE, kind: "fact" }] }, // 第 1 次真写
    { memories: [{ text: "同一句话。", evidence_quote: QUOTE, kind: "fact" }] }, // 第 2 次撞哈希
  ];
  let call = 0;
  const base = {
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => ({ memories: quota[Math.min(call++, 1)].memories }),
    write: async ({ memory, evidenceId }) => ({ id: `m-${evidenceId}-${contentHash(memory.text)}` }),
    log: () => {},
  };
  await runRefine(base);
  const first = (await loadState(w.stateFile)).last_success_at;
  assert.ok(first, "第一次有写入，必须记成功时间");

  // 第二轮：同一条证据已完成 → 不该再抽；换成新证据但内容重复 ⇒ 全是去重命中
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  const second = await runRefine(base);
  assert.equal(second.written, 0, "这一轮没有新写入");
  assert.equal(second.dedupedHash, 1, "靠内容哈希挡住");
  const afterDedupe = await loadState(w.stateFile);
  assert.ok(afterDedupe.last_success_at, "没有失败的一轮仍要更新成功时间（否则运维误判卡住）");

  // 第三轮：全失败 ⇒ 不更新
  await fs.writeFile(path.join(w.evidenceDir, "c.md"), evidence("ev-c", "2026-10-12", LONG + "乙"));
  await runRefine({ ...base, extract: async () => { throw new Error("LLM HTTP 500"); } });
  const afterFail = await loadState(w.stateFile);
  assert.equal(afterFail.last_success_at, afterDedupe.last_success_at, "整轮有失败时不算成功");
});

test("证据水位线：库里已有该证据的记忆 ⇒ 换个 state 也不重抽（跨 state 幂等）", async () => {
  const w = await makeWorld();
  // 库里已有一条记忆，evidence_refs 指向 ev-a
  await fs.writeFile(path.join(w.dataRoot, "curated", "shared", "curated-shared-old.md"), `---\nid: curated-shared-old\nlayer: long-term\nvisibility: platform\ntags: ["refined"]\nevidence_refs: ["ev-a"]\n---\n\n早先提炼过的一条事实。\n`);
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  await fs.writeFile(path.join(w.evidenceDir, "b.md"), evidence("ev-b", "2026-10-11", LONG + "甲"));
  let calls = 0;
  const result = await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async ({ id }) => { calls += 1; return { memories: [{ text: `记忆-${id}-丙`, evidence_quote: QUOTE, kind: "fact" }] }; },
    write: async ({ evidenceId }) => ({ id: `m-${evidenceId}` }),
    log: () => {},
  });
  assert.equal(calls, 1, "ev-a 已有记忆 ⇒ 不许再调模型；只有 ev-b 该处理");
  assert.equal(result.watermarked, 1);
  const state = await loadState(w.stateFile);
  assert.match(state.evidence["ev-a"].reason, /already-refined/);
  assert.equal(state.evidence["ev-b"].status, "done");
});

test("证据水位线可关掉（--no-evidence-watermark 的场景）", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.dataRoot, "curated", "shared", "curated-shared-old.md"), `---\nid: curated-shared-old\nevidence_refs: ["ev-a"]\n---\n\n早先提炼过的一条事实。\n`);
  await fs.writeFile(path.join(w.evidenceDir, "a.md"), evidence("ev-a", "2026-10-10", LONG));
  let calls = 0;
  await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot, evidenceWatermark: false,
    extract: async () => { calls += 1; return { memories: [] }; },
    write: async () => ({ id: "x" }),
    log: () => {},
  });
  assert.equal(calls, 1, "关掉水位线后允许重抽");
});

test("requeueEntries：死信可人工恢复，done 不受影响，剩余死信数如实报", () => {
  const state = {
    version: 1,
    evidence: {
      "ev-done": { status: "done", attempts: 1 },
      "ev-dead-a": { status: "dead", attempts: 3, reason: "LLM HTTP 401" },
      "ev-dead-b": { status: "dead", attempts: 3, reason: "LLM HTTP 500" },
      "ev-failed": { status: "failed", attempts: 1, reason: "boom" },
    },
  };
  const all = requeueEntries(state, { all: true });
  assert.deepEqual(all.requeued.sort(), ["ev-dead-a", "ev-dead-b"]);
  assert.equal(all.remaining_dead, 0);
  assert.equal(state.evidence["ev-done"].status, "done", "done 不许被动");
  assert.equal(state.evidence["ev-failed"].status, "failed", "--requeue-dead 只管死信");

  const one = requeueEntries(state, { id: "ev-failed" });
  assert.deepEqual(one.requeued, ["ev-failed"]);
  assert.equal(state.evidence["ev-failed"], undefined, "退回待处理 = 删条目（重试计数归零）");

  assert.deepEqual(requeueEntries(state, { id: "不存在的 id" }).requeued, []);
});

test("summarizeState：能一条命令回答 待提炼/失败/最近一次成功", async () => {
  const w = await makeWorld();
  await fs.mkdir(path.dirname(w.stateFile), { recursive: true });
  await fs.writeFile(path.join(w.stateFile), JSON.stringify({
    version: 1,
    last_success_at: "2026-10-19T04:00:00.000Z",
    evidence: {
      "ev-a": { status: "done", attempts: 0, at: "2026-10-19T04:00:00.000Z" },
      "ev-b": { status: "failed", attempts: 1, reason: "LLM HTTP 401", at: "2026-10-19T04:05:00.000Z" },
      "ev-c": { status: "dead", attempts: 3, reason: "LLM HTTP 500", at: "2026-10-19T04:06:00.000Z" },
      "ev-d": { status: "skipped", attempts: 0, reason: "skip-short", at: "2026-10-19T04:06:00.000Z" },
    },
  }), "utf8");
  const state = await loadState(w.stateFile);
  const summary = summarizeState(state, { evidenceTotal: 10 });
  assert.equal(summary.done, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.dead, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.pending, 6, "10 - 4 条已处理 = 6 待提炼");
  assert.equal(summary.last_success_at, "2026-10-19T04:00:00.000Z");
});

// ---------------------------------------------------------------------------
// REFINE-LOOP-2：记忆必须落在**事件日**，不能落在"提炼时刻"
// ---------------------------------------------------------------------------
test("事件时刻：capturedAt 优先；缺 capturedAt 时用事件日零点（Asia/Shanghai）", () => {
  assert.equal(eventInstantOf("2026-10-04", "2026-10-04T15:30:00.000Z"), "2026-10-04T15:30:00.000Z");
  // 上海 2026-10-04 00:00 = UTC 2026-10-03T16:00:00Z（不是 UTC 零点）
  assert.equal(zonedDayStartIso("2026-10-04", "Asia/Shanghai"), "2026-10-03T16:00:00.000Z");
  assert.equal(eventInstantOf("2026-10-04", ""), "2026-10-03T16:00:00.000Z");
  assert.equal(eventInstantOf("2026-10-04", "not-a-date"), "2026-10-03T16:00:00.000Z");
  assert.equal(eventInstantOf("", ""), null, "两样都没有时不许自己编一个时刻");
  // 不同时区的同一个"日"零点不同（防硬编码 +8）
  assert.equal(zonedDayStartIso("2026-10-04", "UTC"), "2026-10-04T00:00:00.000Z");
});

test("splitEvidenceFile 带出事件轴：calendarDate 与 eventInstant 都来自证据，不是 now()", () => {
  const raw = "---\nid: conversation-x\neventId: ev-x#turn-3\ncapturedAt: 2026-10-04T16:30:00.000Z\ngroupId: \"g1\"\nuserId: \"u1\"\n---\n\n## 用户\n\n" + LONG;
  const parsed = splitEvidenceFile(raw);
  assert.equal(parsed.calendarDate, "2026-10-05", "上海本地日：16:30Z = 上海次日 00:30");
  assert.equal(parsed.capturedAt, "2026-10-04T16:30:00.000Z");
  assert.equal(parsed.eventInstant, "2026-10-04T16:30:00.000Z", "事件时刻 = capturedAt");
  // 只有 calendarDate 没有 capturedAt 的证据，也要给出当日零点
  const onlyDay = "---\nid: conversation-y\neventId: ev-y#turn-1\ncalendarDate: 2026-10-04\n---\n\n## 用户\n\n" + LONG;
  assert.equal(splitEvidenceFile(onlyDay).eventInstant, "2026-10-03T16:00:00.000Z");
});

test("runRefine 把事件时刻交给写入口（而不是提炼时刻）", async () => {
  const w = await makeWorld();
  const raw = "---\nid: conversation-z\neventId: ev-z#turn-1\ncapturedAt: 2026-10-04T16:30:00.000Z\n---\n\n## 用户\n\n" + LONG;
  await fs.writeFile(path.join(w.evidenceDir, "z.md"), raw);
  const seen = [];
  await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    extract: async () => ({ memories: [{ text: "一条关于 10-04 的事实。", evidence_quote: QUOTE, kind: "fact" }] }),
    write: async (args) => { seen.push(args); return { id: "m-1" }; },
    log: () => {},
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].calendarDate, "2026-10-05");
  assert.equal(seen[0].eventInstant, "2026-10-04T16:30:00.000Z");
});
// ---------------------------------------------------------------------------
// MAINPATH-2：配错 key 不许把整条线堵住（锁必须在抛错路径上也释放）
//
// 病根：main() 的 try/finally 原来只包住 runRefine，而 loadModelKey / loadWriteCredential
// 在 try 之外。key 配错是最常见故障，一抛错锁就留在盘上，之后每一轮都打印
// "上一轮还在跑"并以 0 退出 —— 看着没报错，其实什么都没干，整条线被堵 15 分钟。
// 这里直接跑 CLI 黑盒验：坏 key 跑两次，两次都必须真的报错，而不是第二次被锁挡掉。
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "refine-worker.mjs");

function runWorkerCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH, ...args], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });
}

test("MAINPATH-2：模型 key 配错时锁必须释放，下一轮不许被自己的锁挡掉", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "refine-lock-"));
  try {
    const stateFile = path.join(dir, "refine-state.json");
    const noKey = path.join(dir, "nokey.yaml");
    const evidenceDir = path.join(dir, "evidence");
    const dataRoot = path.join(dir, "data");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(noKey, "NOT_A_KEY: placeholder\n", "utf8");

    const args = [
      "--state", stateFile,
      "--model-key-file", noKey,
      "--evidence", evidenceDir,
      "--data-root", dataRoot,
      "--api", "http://127.0.0.1:1",
      "--limit", "1",
    ];

    const first = await runWorkerCli(args);
    assert.notEqual(first, 0, "坏 key 必须以非 0 退出");
    assert.equal(await fs.access(`${stateFile}.lock`).then(() => true).catch(() => false), false, "抛错路径必须放锁");

    // 关键的回归点：第二轮仍然要真的去失败，而不是"上一轮还在跑"然后 exit 0
    const second = await runWorkerCli(args);
    assert.notEqual(second, 0, "第二轮不许被上一轮留下的锁挡成 exit 0");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REFINE-LOOP-3：优先处理最近的对话 + 防饿死
//
// 病根：runRefine 把证据按日历日**升序**排，所以 2026-10-05 的历史证据永远排在今天前面。
// 自动提炼上线后，用户今天聊的话要等几百条历史消化完才变成记忆 —— 与"同一件事不再被问第二遍"直接矛盾。
//
// 目标：最近优先，但**每轮必须留一部分配额把最老的往前推**，否则 pending 永远降不完；
// 且绝不许靠"把老证据标成 skipped"来腾位置（那是丢数据，不是排优先级）。
// ---------------------------------------------------------------------------

function mkItems(days) {
  return days.map((day, i) => ({
    id: `e${String(i).padStart(2, "0")}`, // e00 最老
    calendarDate: day,
    eventInstant: `${day}T03:00:00.000Z`,
    userText: LONG,
    conversationText: LONG,
  }));
}

const DAYS_ASC = [
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10",
  "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
];

test("REFINE-LOOP-3 配额：默认 10 条里留 2 条给老证据；边界值逐个钉死", () => {
  assert.equal(computeOldSlots(10, 0.2), 2, "默认 8 新 : 2 老");
  assert.equal(computeOldSlots(5, 0.2), 1);
  assert.equal(computeOldSlots(10, 0.35), 4, "round(3.5)=4");
  assert.equal(computeOldSlots(2, 0.2), 1, "只剩 2 条配额也至少留 1 条给老证据，否则永远轮不到");
  assert.equal(computeOldSlots(1, 0.2), 0, "只有 1 条配额时分不了，本轮只做最新的");
  assert.equal(computeOldSlots(10, 0), 0, "显式关掉防饿死");
  assert.equal(computeOldSlots(10, 1), 10, "配额=1 等价于全做老证据");
  assert.equal(computeOldSlots(0, 0.2), 0);
});

test("REFINE-LOOP-3 排序：最近优先，同时把最老的两条塞进同一轮（防饿死）", () => {
  const items = mkItems(DAYS_ASC);
  const plan = planRefineOrder(items, { newestFirst: true, limit: 10, oldQuota: 0.2 });

  assert.equal(plan.length, items.length, "所有条目都要在计划里（排后面的不算淘汰）");
  assert.equal(new Set(plan.map((x) => x.id)).size, plan.length, "不许重复");

  const first10 = plan.slice(0, 10).map((x) => x.id);
  // 最新的 8 条：10-15 … 10-08
  assert.deepEqual(first10.slice(0, 8), ["e14", "e13", "e12", "e11", "e10", "e09", "e08", "e07"]);
  // 最老的两条（最老的排前面，让"最老的"先被推进）
  assert.deepEqual(first10.slice(8), ["e00", "e01"]);

  // 剩下的按"最近优先"继续排，且不丢任何一条
  assert.equal(plan.length, 15);
  assert.equal(plan[10].id, "e06", "第 11 条应当是剩下里最新的");
});

test("REFINE-LOOP-3 排序：关掉 newest-first 时逐条等于旧行为（最老的最先）", () => {
  const items = mkItems(DAYS_ASC);
  const plan = planRefineOrder(items, { newestFirst: false, limit: 5, oldQuota: 0.2 });
  assert.deepEqual(plan.slice(0, 5).map((x) => x.id), ["e00", "e01", "e02", "e03", "e04"]);
  // 关掉时配额不起作用（老证据本来就是最先做的）
  assert.equal(computeOldSlots(5, 0.2), 1, "配额算出来是 1，但 newestFirst=off 时不用它");
});

test("REFINE-LOOP-3 排序：待办比配额还少时全部排进去，不许丢掉/重复", () => {
  const items = mkItems(DAYS_ASC.slice(0, 3));
  const plan = planRefineOrder(items, { newestFirst: true, limit: 10, oldQuota: 0.2 });
  assert.equal(plan.length, 3);
  assert.equal(new Set(plan.map((x) => x.id)).size, 3);
  assert.deepEqual(plan.map((x) => x.id), ["e02", "e01", "e00"], "只剩 3 条时按最近优先全做");
});

test("REFINE-LOOP-3 实跑：今天的新证据在这一轮就被提炼，老证据同轮也在推进", async () => {
  const w = await makeWorld();
  // 5 条老 + 1 条今天；limit=3、oldQuota=0.2 ⇒ 2 新 : 1 老
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-19"];
  for (let i = 0; i < days.length; i += 1) {
    await fs.writeFile(path.join(w.evidenceDir, `e${i}.md`), evidence(`e${i}`, days[i], LONG), "utf8");
  }
  const seen = [];
  const run = async () =>
    runRefine({
      evidenceDir: w.evidenceDir,
      stateFile: w.stateFile,
      dataRoot: w.dataRoot,
      limit: 3,
      newestFirst: true,
      oldQuota: 0.2,
      extract: async ({ id }) => {
        seen.push(id);
        return { memories: [] };
      },
      write: async () => ({ id: "never" }),
      log: () => {},
    });

  await run();
  // 最新的一条必须在这一轮就做掉（绝不能排在 5 条老证据后面）
  assert.ok(seen.includes("e5"), `今天那条必须在本次运行里被处理，实际处理了 ${JSON.stringify(seen)}`);
  // 同一轮还要有老证据在推进（最老的 e0）
  assert.ok(seen.includes("e0"), `老证据必须同轮推进，实际处理了 ${JSON.stringify(seen)}`);
  assert.equal(seen.length, 3, "limit=3 就只处理 3 条");

  const state = await loadState(w.stateFile);
  assert.equal(state.evidence.e5.status, "done", "新证据做完就是 done");
  assert.equal(state.evidence.e0.status, "done", "老证据做完也是 done（不是 skipped）");
  // 中间那几条只是"排在后面"，不许被标 skipped
  for (const id of ["e1", "e2", "e3"]) {
    assert.equal(state.evidence[id], undefined, `${id} 只是排在后面，不许被标成任何终态`);
  }
  assert.equal(state.evidence.e4.status, "done", "第 2 新的那条也在配额内（2 新 : 1 老）");
});

test("REFINE-LOOP-3 实跑：连跑多轮不饿死，pending 最终归零", async () => {
  const w = await makeWorld();
  for (let i = 0; i < 6; i += 1) {
    await fs.writeFile(path.join(w.evidenceDir, `e${i}.md`), evidence(`e${i}`, DAYS_ASC[i], LONG), "utf8");
  }
  const rounds = [];
  const runOnce = async () => {
    const seen = [];
    await runRefine({
      evidenceDir: w.evidenceDir,
      stateFile: w.stateFile,
      dataRoot: w.dataRoot,
      limit: 2,
      newestFirst: true,
      oldQuota: 0.5, // 1 新 : 1 老
      extract: async ({ id }) => {
        seen.push(id);
        return { memories: [] };
      },
      write: async () => ({ id: "never" }),
      log: () => {},
    });
    rounds.push(seen);
    return seen;
  };

  for (let r = 0; r < 8; r += 1) {
    const done = await runOnce();
    if (done.length === 0) break;
  }
  const all = rounds.flat();
  assert.equal(new Set(all).size, 6, `六条证据都要被处理到（不饿死），实际 ${JSON.stringify(rounds)}`);
  const state = await loadState(w.stateFile);
  for (let i = 0; i < 6; i += 1) assert.equal(state.evidence[`e${i}`].status, "done", `e${i} 应当最终 done`);
  // 每一轮都同时吃到两头的特征：第一轮 = 最新 + 最老
  assert.deepEqual(rounds[0].sort(), ["e0", "e5"]);
});

test("REFINE-LOOP-3 配置：--newest-first / --old-quota 的四种写法都要认", () => {
  // 默认 = 最近优先 + 20% 老配额
  assert.equal(parseNewestFirst([]), true);
  assert.equal(parseOldQuota([]), 0.2);
  // off 的各种写法
  for (const v of ["off", "false", "0", "no", "disable", "OFF"]) {
    assert.equal(parseNewestFirst(["--newest-first", v]), false, `--newest-first ${v} 应当关掉`);
    assert.equal(parseNewestFirst([`--newest-first=${v}`]), false, `--newest-first=${v} 应当关掉`);
  }
  assert.equal(parseNewestFirst(["--no-newest-first"]), false);
  assert.equal(parseNewestFirst(["--newest-first", "on"]), true);
  assert.equal(parseNewestFirst(["--newest-first"]), true, "裸 --newest-first 视作打开");
  // 配额：夹到 [0,1]，非法值回落默认
  assert.equal(parseOldQuota(["--old-quota", "0.5"]), 0.5);
  assert.equal(parseOldQuota(["--old-quota", "0"]), 0);
  assert.equal(parseOldQuota(["--old-quota", "5"]), 1);
  assert.equal(parseOldQuota(["--old-quota", "-1"]), 0.2);
  assert.equal(parseOldQuota(["--old-quota", "abc"]), 0.2);
});

test("REFINE-LOOP-3 排序：比较器的方向不许写反（倒序 vs 升序）", () => {
  const mk = (id, day) => ({ id, calendarDate: day, eventInstant: `${day}T03:00:00.000Z` });
  const a = mk("e1", "2026-10-01");
  const b = mk("e2", "2026-10-20");
  assert.ok(compareNewestFirst(a, b) > 0, "最近优先：老的排后面");
  assert.ok(compareOldestFirst(a, b) < 0, "旧口径：老的排前面");
  // 同一事件时刻按 id 倒序，保证确定性
  const c = mk("e3", "2026-10-20");
  assert.ok(compareNewestFirst(b, c) > 0);
});

test("REFINE-LOOP-3 实跑：newestFirst=false 真的回到旧口径（最老的最先）", async () => {
  const w = await makeWorld();
  for (let i = 0; i < 4; i += 1) {
    await fs.writeFile(path.join(w.evidenceDir, `e${i}.md`), evidence(`e${i}`, DAYS_ASC[i], LONG), "utf8");
  }
  const seen = [];
  await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    limit: 2, newestFirst: false, oldQuota: 0.2,
    extract: async ({ id }) => { seen.push(id); return { memories: [] }; },
    write: async () => ({ id: "never" }),
    log: () => {},
  });
  assert.deepEqual(seen, ["e0", "e1"], "关掉 newest-first 就是从最老的开始");
});

test("REFINE-LOOP-3：last_run 要留下「这轮按什么顺序做的」，便于事后核对", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "e0.md"), evidence("e0", "2026-10-19", LONG), "utf8");
  await runRefine({
    evidenceDir: w.evidenceDir, stateFile: w.stateFile, dataRoot: w.dataRoot,
    limit: 10, newestFirst: true, oldQuota: 0.2,
    extract: async () => ({ memories: [] }),
    write: async () => ({ id: "never" }),
    log: () => {},
  });
  const state = await loadState(w.stateFile);
  assert.equal(state.last_run.order.newestFirst, true);
  assert.equal(state.last_run.order.oldQuota, 0.2);
  assert.equal(state.last_run.order.oldSlots, 2, "limit=10 × 0.2 = 2");
  assert.equal(state.last_run.order.newSlots, 8);
});

test("REFINE-LOOP-3 实跑：去重/幂等不变——同一份证据不会被重复写", async () => {
  const w = await makeWorld();
  await fs.writeFile(path.join(w.evidenceDir, "e0.md"), evidence("e0", "2026-10-19", LONG), "utf8");
  const writes = [];
  const opts = {
    evidenceDir: w.evidenceDir,
    stateFile: w.stateFile,
    dataRoot: w.dataRoot,
    limit: 5,
    newestFirst: true,
    oldQuota: 0.2,
    extract: async () => ({ memories: [{ text: "用户要求提炼进程同一时刻最多一个。", evidence_quote: QUOTE, kind: "fact" }] }),
    write: async (args) => {
      writes.push(args.evidenceId);
      return { id: `m-${writes.length}` };
    },
    log: () => {},
  };

  const first = await runRefine(opts);
  assert.equal(first.written, 1);
  const second = await runRefine(opts);
  assert.equal(second.written, 0, "第二轮不许再写");
  assert.equal(writes.length, 1, "写入口只被调用一次");
  assert.equal(second.processed, 0, "已经 done 的证据不该重新进处理队列");
});
