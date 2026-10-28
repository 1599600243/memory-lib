// MEMORY-LOOP-1（第二垂直切片）—— 提炼提交的**写入失败**分支。
//
// 为什么这个分支必须单独测、而且只能在模块这一层测：
//   "整包校验通过、真正落盘时写失败"要触发，只能靠暂时性的 OS 级写入故障（磁盘满、权限、占用）。
//   公开 HTTP 接缝上无法确定性地造出它 —— 能造出来的失败（形状、时间串、证据、项目）全都属于
//   **计划阶段**，那部分已经在 refinement-jobs-submit-http.test.mjs 里逐条钉死。
//   所以这里直接注入一个会抛错的 writeMemory 协作者，钉三件事：
//     ① 全失败 ⇒ failed（且回执里带结构化原因）；
//     ② 部分成功 ⇒ needs_review（已写的那条**不回滚**，回执如实报出写了什么、漏了什么）；
//     ③ needs_review / failed **不是死结**：领取者可以带修正后的载荷重提并最终 completed。
//   不钉"部分原子性"：本实现明确**不**回滚已写条目（见 refinement-jobs.mjs 内注释），测试也不假装它是原子的。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRefinementJobs } from "../src/refinement-jobs.mjs";

const PRINCIPAL = { tenant_id: "default", framework_id: "deepseek-harness", group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" };

test("ML1 切片2：写入失败 ⇒ failed / needs_review 且可重提，已写条目不回滚", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-writefail-"));
  try {
    const jobs = createRefinementJobs({ dataRoot: tmp });
    const job = await jobs.recordCapture({ evidenceId: "conversation-0123456789abcdef01234567", conversationId: "c1", workspace: "D:/work/proj", principal: PRINCIPAL });
    assert.equal(job.state, "pending");
    assert.equal(job.project, "d-work-proj");
    await jobs.claim({ job_id: job.job_id, principal: PRINCIPAL });

    const conclusions = (ids) => ({ conclusions: ids.map((id) => ({ layer: "project-state", body: `结论 ${id}`, evidence_refs: ["conversation-0123456789abcdef01234567"], id })) });
    // 证据协作者返回的是**那一条证据本身**（修复批次：提交要逐个检查证据的 workspace/身份，
    // 只回 true 已经不足以让一条结论合法）。这里给的形状与请求作用域库实例的 lib.get 一致。
    const evidence = {
      id: "conversation-0123456789abcdef01234567",
      path: path.join(tmp, "evidence", "conversations", "conversation-0123456789abcdef01234567.md"),
      frontmatter: {
        id: "conversation-0123456789abcdef01234567",
        type: "conversation",
        workspace: JSON.stringify("D:/work/proj"),
        groupId: JSON.stringify(PRINCIPAL.group_id),
        userId: JSON.stringify(PRINCIPAL.user_id),
      },
      body: "# 原始对话记录\n",
    };
    const collaborators = (writeMemory) => ({
      assertion: () => {},
      verifyEvidence: async () => evidence,
      writeMemory,
    });

    // ① 全失败 ⇒ failed（不是 needs_review）：一条都没落盘时，回执不许说"部分完成"。
    const allFailed = await jobs.submit({
      job_id: job.job_id,
      principal: PRINCIPAL,
      body: conclusions(["w1", "w2"]),
      ...collaborators(async () => { throw new Error("EACCES: permission denied"); }),
    });
    assert.equal(allFailed.ok, true, `submit should still answer, got ${JSON.stringify(allFailed)}`);
    assert.equal(allFailed.job.state, "failed");
    assert.equal(allFailed.receipt.outcome, "failed");
    assert.deepEqual(allFailed.receipt.writes, []);
    assert.equal(allFailed.receipt.failures.length, 2, `every unwritten conclusion must be accounted for, got ${JSON.stringify(allFailed.receipt.failures)}`);
    assert.match(allFailed.receipt.failures[0].error, /EACCES/u, `the failure must keep the real reason, got ${JSON.stringify(allFailed.receipt.failures[0])}`);
    assert.equal(allFailed.job.submissions.length, 1, "the failed attempt must still be recorded in the durable history");

    // ② 部分成功 ⇒ needs_review：第 1 条写了（不回滚），第 2 条失败，第 3 条连试都没试。
    const written = [];
    const partial = await jobs.submit({
      job_id: job.job_id,
      principal: PRINCIPAL,
      body: conclusions(["p1", "p2", "p3"]),
      ...collaborators(async (input) => {
        if (input.id === "p2") throw new Error("EBUSY: file is locked");
        written.push(input.id);
        return { ok: true, id: input.id, layer: input.layer, path: path.join(tmp, "project-state", "d-work-proj", "current-state.md"), created: true };
      }),
    });
    assert.equal(partial.job.state, "needs_review", `a partial write must be flagged for review, got ${partial.job.state}`);
    assert.equal(partial.receipt.outcome, "needs_review");
    assert.equal(partial.receipt.reason, "partial_write");
    assert.deepEqual(written, ["p1"], `only the first conclusion may have been written, got ${JSON.stringify(written)}`);
    assert.deepEqual(partial.receipt.writes.map((item) => item.id), ["p1"], "the receipt must report what actually landed");
    assert.deepEqual(partial.receipt.writes[0].created, true);
    assert.deepEqual(partial.receipt.failures.map((item) => item.index), [1, 2], `the receipts must name the failed and the never-attempted conclusions, got ${JSON.stringify(partial.receipt.failures)}`);
    assert.match(partial.receipt.failures[1].error, /not attempted/u, "the never-attempted conclusion must be distinguishable from the failed one");
    assert.equal(partial.job.submissions.length, 2, "both attempts must stay in the durable history");

    // ③ 重提：needs_review 不是终点。同样的载荷 + 这次能写，应当最终 completed，且历史累积三条。
    const recovered = await jobs.submit({
      job_id: job.job_id,
      principal: PRINCIPAL,
      body: conclusions(["p1", "p2", "p3"]),
      ...collaborators(async (input) => ({ ok: true, id: input.id, layer: input.layer, path: path.join(tmp, "project-state", "d-work-proj", "current-state.md"), updated: true })),
    });
    assert.equal(recovered.ok, true, `a needs_review job must be re-submittable, got ${JSON.stringify(recovered)}`);
    assert.equal(recovered.job.state, "completed");
    assert.equal(recovered.receipt.outcome, "written");
    assert.deepEqual(recovered.receipt.writes.map((item) => item.id), ["p1", "p2", "p3"]);
    assert.equal(recovered.job.submissions.length, 3, "the retry must be appended to the history, not replace it");
    // 落盘即真相：三次提交都在 job 文件里（换一个实例读回也一致）。
    const reloaded = await createRefinementJobs({ dataRoot: tmp }).get({ job_id: job.job_id, principal: PRINCIPAL });
    assert.equal(reloaded.state, "completed");
    assert.equal(reloaded.submissions.length, 3, `the history must be durable, got ${JSON.stringify(reloaded.submissions)}`);
    assert.equal(reloaded.submissions[1].state, "needs_review");
    assert.equal(reloaded.submissions[0].state, "failed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
