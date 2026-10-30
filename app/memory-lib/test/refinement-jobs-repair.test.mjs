// MEMORY-LOOP-1 修复批次 —— 模块层判别测试（并发串行化 / 状态机导出 / 同文件取代护栏）。
//
// 为什么这几条必须打在模块层：
//   ① 状态机枚举是**导出常量**，公开 HTTP 只能看见"某个状态被接受"，看不见"枚举本身是否完整"；
//   ② "并发提交同一 stable_key 不许长出两个 active 版本" 需要**确定性地**把第一个提交卡在
//      writer 里，再放第二个提交进来 —— 公开 HTTP 上没有钩子能做到这件事（只能靠运气撞时序）；
//   ③ 同文件取代护栏（project-state 一个项目一份 current-state.md）的失败面是 generic writer
//      的**跨调用方**行为，不是提炼入口的行为（提炼入口另有自己的写前判定，见切片4 的 HTTP 测试）。
//
// 判别力来源：期望值全部来自**独立真值源** —— 盘上真实的文件、请求里发出去的值、测试自己造的正文；
// 不用被测代码重算一遍期望值。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REFINEMENT_JOB_STATES, createRefinementJobs } from "../src/refinement-jobs.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";

const PRINCIPAL = { tenant_id: "default", framework_id: "deepseek-harness", group_id: "g-repair", user_id: "u-repair", agent_id: "a-repair", role_id: "r-repair" };
const WORKSPACE = "D:/MemoryLib/app/memory-lib";
const PROJECT = "d-memorylib-app-memory-lib";
const CONCURRENT_KEY = "memory-loop-1-repair-concurrent-key";

function delay(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

// 一条"可读的证据"。形状与请求作用域库实例的 lib.get 一致（{id, path, frontmatter, body}）：
// 提炼提交拿到的就是这个对象，兼容性校验要逐个看它的 workspace/身份，而不是只看"非空"。
function evidenceItem(dataRoot, evidenceId) {
  return {
    id: evidenceId,
    path: path.join(dataRoot, "evidence", "conversations", `${evidenceId}.md`),
    frontmatter: {
      id: evidenceId,
      type: "conversation",
      workspace: JSON.stringify(WORKSPACE),
      groupId: JSON.stringify(PRINCIPAL.group_id),
      userId: JSON.stringify(PRINCIPAL.user_id),
    },
    body: "# 原始对话记录\n\n## 用户\n\n并发修复夹具。\n",
  };
}

test("ML1 修复④：导出的状态机枚举覆盖 pending/claimed/completed/needs_review/failed 五个状态", () => {
  // 期望值是**状态机自身**规定的五个格（不是"当前代码返回了什么"）：任何一个漏掉，
  // 调用方（度量、清单、接入方）都会把该状态当成"未知"。
  assert.deepEqual([...REFINEMENT_JOB_STATES], ["pending", "claimed", "completed", "needs_review", "failed"]);
});

test("ML1 修复⑤：并发提交同一 stable_key 只留一条 active 版本（进程内按写作用域串行化）", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-concurrent-"));
  try {
    const writer = createMemoryWriter({ dataRoot: tmp });
    const jobs = createRefinementJobs({ dataRoot: tmp });
    const evidenceA = "conversation-0123456789abcdef0123456a";
    const evidenceB = "conversation-0123456789abcdef0123456b";

    const jobA = await jobs.recordCapture({ evidenceId: evidenceA, conversationId: "repair-conv-a", workspace: WORKSPACE, principal: PRINCIPAL });
    const jobB = await jobs.recordCapture({ evidenceId: evidenceB, conversationId: "repair-conv-b", workspace: WORKSPACE, principal: PRINCIPAL });
    assert.equal(jobA.project, PROJECT, "夹具待办的 project 必须由 workspace 派生");
    assert.equal((await jobs.claim({ job_id: jobA.job_id, principal: PRINCIPAL })).ok, true);
    assert.equal((await jobs.claim({ job_id: jobB.job_id, principal: PRINCIPAL })).ok, true);

    // 两个提交写的是同一件事（同 layer / 同 project / 同 stable_key / 同正文），只是各带自己的证据 ⇒
    // 正确结局是"一条 active 记忆 + 证据并集"，错误结局是"两条 active 版本"。
    const conclusionFor = (id, evidenceId) => ({
      layer: "project-decision",
      id,
      body: "稳定键并发修复：同一件事只能有一条 active 记忆。",
      evidence_refs: [evidenceId],
      stable_key: CONCURRENT_KEY,
    });

    // 确定性交织：第一个提交进入 writer 后**卡住**，第二个提交在这段时间里完整跑一遍。
    // 没有串行化时，第二个提交在第一个落盘前查 stable_key ⇒ 查不到 ⇒ 也去写 ⇒ 两个 active 版本。
    let signalFirstWriteEntered;
    const firstWriteEntered = new Promise((resolve) => { signalFirstWriteEntered = resolve; });
    let releaseFirstWrite;
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    let writeCalls = 0;
    const writeMemory = async (input) => {
      writeCalls += 1;
      if (writeCalls === 1) { signalFirstWriteEntered(); await firstWriteGate; }
      return writer.write(input);
    };
    const collaborators = {
      assertion: () => {},
      verifyEvidence: async (evidenceId) => evidenceItem(tmp, evidenceId),
      writeMemory,
      findActiveMemory: (query) => writer.findActiveByStableKey(query),
      readableMemory: async () => true,
      mergeMemory: (input) => writer.mergeEvidenceRefs(input),
      supersedeMemory: (input) => writer.supersede(input),
      targetPathOf: (input) => writer.targetPathFor(input),
    };

    const first = jobs.submit({ job_id: jobA.job_id, principal: PRINCIPAL, body: { conclusions: [conclusionFor("repair-kv-a", evidenceA)] }, ...collaborators });
    await firstWriteEntered;
    const second = jobs.submit({ job_id: jobB.job_id, principal: PRINCIPAL, body: { conclusions: [conclusionFor("repair-kv-b", evidenceB)] }, ...collaborators });
    // 给第二个提交足够的时间跑完它**本来**会做的一切（查同键 / 写盘）：串行化时它只会等在门口。
    await delay(200);
    releaseFirstWrite();
    const [resultA, resultB] = await Promise.all([first, second]);

    assert.equal(resultA.ok, true, `the first submission must succeed, got ${JSON.stringify(resultA)}`);
    assert.equal(resultB.ok, true, `the second submission must succeed (as a merge), got ${JSON.stringify(resultB)}`);

    const decisionsDir = path.join(tmp, "project-state", PROJECT, "decisions");
    const files = (await fs.readdir(decisionsDir).catch(() => [])).filter((name) => name.endsWith(".md"));
    assert.deepEqual(files.sort(), ["repair-kv-a.md"], `concurrent submissions of one stable_key must leave exactly one active version, got ${JSON.stringify(files)}`);
    const onDisk = parseFrontmatterTyped(await fs.readFile(path.join(decisionsDir, files[0]), "utf8")).frontmatter;
    assert.equal(onDisk.stable_key, CONCURRENT_KEY, `the surviving version must carry the stable_key, got ${JSON.stringify(onDisk.stable_key)}`);
    assert.equal(onDisk.status, "active");
    assert.deepEqual(onDisk.evidence_refs, [evidenceA, evidenceB], `the second submission must merge its evidence into the first version, got ${JSON.stringify(onDisk.evidence_refs)}`);

    // 回执如实报出两种动作：先写的 written，后到的 merged（不是两个 written）。
    const actions = [resultA.receipt.writes[0].action ?? "written", resultB.receipt.writes[0].action ?? "written"].sort();
    assert.deepEqual(actions, ["merged", "written"], `one submission writes and the other merges, got ${JSON.stringify(actions)}`);
    assert.equal(resultA.job.state, "completed");
    assert.equal(resultB.job.state, "completed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("ML1 修复⑧：generic writer 拒绝 project-state 同文件取代，取代链不会被物理覆盖", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-samefile-"));
  try {
    const writer = createMemoryWriter({ dataRoot: tmp });
    const first = await writer.write({ layer: "project-state", project: "repair-project", id: "repair-ps-1", body: "项目现状第一版：唯一且不可被新版覆盖。", evidence_refs: ["evidence:repair-1"], principal: PRINCIPAL });
    const beforeText = await fs.readFile(first.path, "utf8");
    const before = parseFrontmatterTyped(beforeText).frontmatter;
    assert.equal(before.id, "repair-ps-1");
    assert.equal(before.status, "active");

    // 没有这条护栏时会发生什么（基线行为，必须显式拒绝而不是让它悄悄发生）：
    //   write() 把新版正文写进**同一个** current-state.md ⇒ 旧正文当场消失；
    //   随后 supersede 又把旧正文 + status=superseded 写回同一个文件 ⇒ 新版正文也消失；
    //   结果链指向一个**不存在**的新 id，两个版本都没了。
    let refusal = null;
    try {
      await writer.supersede({ oldId: "repair-ps-1", layer: "project-state", project: "repair-project", id: "repair-ps-2", body: "项目现状第二版：不该覆盖第一版。", evidence_refs: ["evidence:repair-2"], principal: PRINCIPAL });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, "a same-file supersede must fail loudly instead of silently overwriting the chain");
    assert.match(String(refusal.message), /SUPERSEDE_SAME_FILE/u, `the refusal must name the rule, got ${String(refusal.message)}`);

    // 旧文件逐字节不变；链上没有指向虚无的 superseded_by；新版正文没有落盘。
    assert.equal(await fs.readFile(first.path, "utf8"), beforeText, "a refused same-file supersede must leave the old file byte-identical");
    const after = parseFrontmatterTyped(await fs.readFile(first.path, "utf8")).frontmatter;
    assert.equal(after.status, "active");
    assert.equal(after.superseded_by, null, `a refused supersede must not point at a successor, got ${JSON.stringify(after.superseded_by)}`);
    assert.equal(after.valid_to, null, `a refused supersede must not close the memory, got ${JSON.stringify(after.valid_to)}`);
    assert.equal(after.id, "repair-ps-1");
    const projectDir = path.join(tmp, "project-state", "repair-project");
    const files = (await fs.readdir(projectDir)).filter((name) => name.endsWith(".md"));
    assert.deepEqual(files.sort(), ["current-state.md"], `the fix must not create a second file in a one-file layer, got ${JSON.stringify(files)}`);
    assert.match(await fs.readFile(first.path, "utf8"), /项目现状第一版/u, "the old body must survive untouched");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
