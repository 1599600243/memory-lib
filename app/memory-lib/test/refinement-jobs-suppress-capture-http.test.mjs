// MEMORY-LOOP-1 修复批次 —— suppressRefinement 捕获仍必须产生待办 + 无 workspace 待办必须可用（公开 HTTP）。
//
// 两条被修的语义，都只有在**公开路径**上才有判别力：
//   ① 单子写的是"每当一段对话证据落盘（capture 完成）⇒ 自动产生一张可追踪的提炼待办"。
//      `suppressRefinement` 是 pet-command 自动捕获的既有开关，它原本抑制的是**旧的巡检观测**
//      （refinement-observability 的巡检报告）。它**不**是"这段证据不要求提炼"。
//      所以：`POST /v1/pet/command`（真实自动捕获入口，source=pet-command，suppressRefinement=true）
//      之后，待办**必须已经存在**；同时巡检报告仍然不写 —— 旧语义照旧，新语义补上。
//   ② 没有 workspace 的待办（自动捕获本来就不带 workspace）必须**能走完生命周期**：
//      领取 → 零输出（no_durable_fact）⇒ completed，且这条路径**不需要任何写作用域**；
//      领取 → 一条 curated-shared 结论 ⇒ 真的落盘、真的读得回。
//
// 夹具身份刻意选 `pet-assistant`：它持有 `pet` + `propose`，但**只有** `{memory, shared}` 一个作用域，
// 一个项目作用域都没有。于是"零输出不需要写作用域"与"共享层写入只需要共享作用域"这两条，
// 靠夹具的身份就足以证伪（旧实现给所有提交都要求 project 作用域 ⇒ 这里必然 403）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { DEFAULT_INSPECTION_REPORT_RELATIVE_PATH } from "../src/refinement-observability.mjs";

// REFINE-LOOP-1-REJECT1b：巡检报告的落点只有一处真值（模块导出的常量），
// 测试一律从这里派生，别再硬编码 —— 否则路径再挪一次就留下一堆过期断言。
const INSPECTION_REPORT_REL = DEFAULT_INSPECTION_REPORT_RELATIVE_PATH.split(path.sep).join("/");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// pet-assistant：pet + propose + search，作用域只有 {memory, shared}（没有 project 作用域）。
const PET = { agent_id: "pilot-01", role_id: "pet-assistant" };
const GROUP = "group-ml1r";
const USER = "user-ml1r";
const SESSION_A = "ml1-suppress-session-a";
const SESSION_B = "ml1-suppress-session-b";
const SHARED_ID = "ml1-suppress-shared-1";
// 确定性假 LLM（与 pet 的既有测试同款）：pet-command 真的会被触发，但这里不需要联网
// —— 本测试关心的是"捕获 ⇒ 待办"的接线，不是回复质量。没有它，一次 pet 命令会去连
// 不存在的本地端点并等满超时（83 秒），把一次判别测试拖成一分钟。
const fakeLlm = {
  async chat() { return "记下了：提炼待办与巡检观测是两件事。"; },
  async *chatStream() { yield "记下了："; yield "提炼待办与巡检观测是两件事。"; },
};

async function waitFor(description, probe, { timeoutMs = 20000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  assert.fail(`timed out waiting for ${description}; last observation: ${JSON.stringify(last)}`);
}

test("ML1 修复①③：pet-command（suppressRefinement）仍产生待办；无 workspace 待办可领取、可零输出、可写共享层", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-suppress-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  for (const role of registry.frameworks[0].agents.flatMap((agent) => agent.roles)) {
    role.group_id ??= GROUP;
    role.user_id ??= USER;
  }
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    calendarTimezone: "UTC",
    llm: fakeLlm,
    libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
  });

  async function post(port, url, body) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: PET, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }

  // 正式记忆文件清单（原文证据层与巡检报告不是"这一次提交"的产物，排除掉）。
  const EXCLUDED_RELATIVE_PREFIXES = ["evidence/", INSPECTION_REPORT_REL];
  const relOf = (filePath) => path.relative(dataRoot, filePath).split(path.sep).join("/");
  async function formalMemoryFiles() {
    const found = [];
    const stack = [dataRoot];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
        const relative = relOf(full);
        if (EXCLUDED_RELATIVE_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue;
        found.push(relative);
      }
    }
    return found.sort();
  }

  const inspectionReport = path.join(dataRoot, ...INSPECTION_REPORT_REL.split("/"));
  const reportExists = async () => { try { await fs.access(inspectionReport); return true; } catch { return false; } };

  // 捕获是队列落盘的（入口不阻塞回复）。先等**证据**出现 —— 这一步把"夹具有效"与
  // "待办没建"分开：RED 时它必须成功（证据确实落盘了），失败的只能是"没有待办"。
  async function waitForEvidence(conversationId) {
    return waitFor(`evidence for ${conversationId}`, async () => {
      let index = null;
      try { index = JSON.parse(await fs.readFile(path.join(dataRoot, "evidence", "conversations", "capture-index.json"), "utf8")); } catch { return null; }
      const hit = Object.values(index?.events ?? {}).find((event) => event?.conversationId === conversationId && event?.evidenceId);
      return hit ? hit.evidenceId : null;
    });
  }

  try {
    const port = (await server.listen()).port;

    // ── ① 真实自动捕获入口：pet-command（这一条在修前**不产生**待办） ──────────────
    const command = await post(port, "/v1/pet/command", { input: "下次记得提醒我把提炼待办和巡检观测分开", mode: "assistant", session_id: SESSION_A, history: [] });
    assert.equal(command.status, 200, `pet command must succeed, got ${command.status} ${JSON.stringify(command.body)}`);

    // 捕获是队列落盘的（既有行为：入口不阻塞回复），所以先等**证据**真的落盘，
    // 再断言"落盘即待办"的那一半 —— 否则"没有待办"可能只是"捕获还没跑"。
    const evidenceA = await waitForEvidence(SESSION_A);
    assert.match(evidenceA, /^conversation-[0-9a-f]{24}$/u, `the pet-command capture must land as evidence, got ${evidenceA}`);
    await fs.access(path.join(dataRoot, "evidence", "conversations", `${evidenceA}.md`));
    const job = await waitFor("a refinement job for the suppressRefinement capture", async () => {
      const listed = await post(port, "/v1/refinement/jobs/list", {});
      assert.equal(listed.status, 200, `jobs list must be a real route, got ${listed.status}`);
      return listed.body.jobs.find((item) => item.conversation_id === SESSION_A) ?? null;
    });
    assert.match(job.job_id, /^job-[0-9a-f]{24}$/u, `job_id shape, got ${job.job_id}`);
    assert.equal(job.state, "pending");
    assert.equal(job.trigger_reason, "conversation_capture");
    assert.equal(job.workspace, null, "the pet-command capture carries no workspace");
    assert.equal(job.project, null, "a workspace-less job must not invent a project");
    assert.equal(job.target_layer, "curated-shared", `a workspace-less job targets the shared layer, got ${job.target_layer}`);
    assert.equal(job.evidence_ids.length, 1);
    assert.equal(job.evidence_ids[0], evidenceA, "the job must reference the evidence record that this capture produced");
    assert.deepEqual(
      { group_id: job.principal.group_id, user_id: job.principal.user_id, agent_id: job.principal.agent_id, role_id: job.principal.role_id },
      { group_id: GROUP, user_id: USER, agent_id: "pilot-01", role_id: "pet-assistant" },
      `the job must carry the capturing principal, got ${JSON.stringify(job.principal)}`,
    );

    // suppressRefinement 的**既有**语义必须原样保留：旧的巡检观测不被触发（不写巡检报告）。
    assert.equal(await reportExists(), false, "suppressRefinement must still suppress the legacy refinement inspection report");
    // 反向控制：一条**普通**捕获会写巡检报告 ⇒ 上一行的 false 确实来自 suppressRefinement，而不是"报告从不写入"。
    const plain = await post(port, "/v1/conversations/capture", {
      messages: [{ role: "user", content: "普通捕获（不带 suppressRefinement）用来做观测抑制的反向控制。" }],
      conversation_id: "ml1-suppress-plain-conv",
      event_id: "ml1-suppress-plain-event",
      source: "ml1-suppress-http-test",
    });
    assert.equal(plain.status, 200, `plain capture must succeed, got ${plain.status} ${JSON.stringify(plain.body)}`);
    assert.equal(await reportExists(), true, "a non-suppressed capture must still write the legacy inspection report");

    // ── ② 无 workspace 待办：领取 → 零输出 ⇒ completed，且不需要任何写作用域 ──────────
    const claimedA = await post(port, "/v1/refinement/jobs/claim", { job_id: job.job_id });
    assert.equal(claimedA.status, 200, `claim must succeed on a workspace-less job, got ${claimedA.status} ${JSON.stringify(claimedA.body)}`);
    assert.equal(claimedA.body.job.state, "claimed");
    const beforeZero = await formalMemoryFiles();
    const zero = await post(port, "/v1/refinement/jobs/submit", { job_id: job.job_id, no_durable_fact: { reason: "no_durable_fact", note: "这一段只是寒暄" } });
    assert.equal(zero.status, 200, `a zero-output completion must not need a write scope, got ${zero.status} ${JSON.stringify(zero.body)}`);
    assert.equal(zero.body.job.state, "completed", `zero output is an accepted completion, got ${JSON.stringify(zero.body.job.state)}`);
    assert.equal(zero.body.receipt.outcome, "no_durable_fact");
    assert.deepEqual(zero.body.receipt.writes, [], "a zero-output completion writes nothing");
    assert.deepEqual(await formalMemoryFiles(), beforeZero, "a zero-output completion must not touch the formal layers");

    // ── ③ 无 workspace 待办：领取 → 一条 curated-shared 结论 ⇒ 真的落盘、真的读得回 ──────
    const second = await post(port, "/v1/pet/command", { input: "顺手把共享层的那条结论记下来", mode: "assistant", session_id: SESSION_B, history: [] });
    assert.equal(second.status, 200, `second pet command must succeed, got ${second.status} ${JSON.stringify(second.body)}`);
    const evidenceB = await waitForEvidence(SESSION_B);
    assert.match(evidenceB, /^conversation-[0-9a-f]{24}$/u, `the second capture must land as evidence, got ${evidenceB}`);
    const jobB = await waitFor("a refinement job for the second pet-command capture", async () => {
      const listed = await post(port, "/v1/refinement/jobs/list", {});
      assert.equal(listed.status, 200);
      return listed.body.jobs.find((item) => item.conversation_id === SESSION_B) ?? null;
    });
    assert.deepEqual(jobB.evidence_ids, [evidenceB], "the second job must reference the second evidence record");
    const claimedB = await post(port, "/v1/refinement/jobs/claim", { job_id: jobB.job_id });
    assert.equal(claimedB.status, 200, `claim must succeed, got ${claimedB.status} ${JSON.stringify(claimedB.body)}`);

    // 项目层结论仍然必须被拒（无 workspace ⇒ 没有可依据的项目）——证明"放开零输出"没有放开项目写入。
    const beforeReject = await formalMemoryFiles();
    const projectLayer = await post(port, "/v1/refinement/jobs/submit", {
      job_id: jobB.job_id,
      conclusions: [{ layer: "project-state", project: null, id: "ml1-suppress-ps", body: "无 workspace 的待办不许写项目层。", evidence_refs: jobB.evidence_ids }],
    });
    assert.equal(projectLayer.status, 400, `a project-layer conclusion must be refused without a workspace, got ${projectLayer.status} ${JSON.stringify(projectLayer.body)}`);
    assert.equal(projectLayer.body.error.code, "PROJECT_MISMATCH", `error code, got ${JSON.stringify(projectLayer.body.error)}`);
    assert.deepEqual(await formalMemoryFiles(), beforeReject, "a refused project-layer conclusion must write nothing");

    const shared = await post(port, "/v1/refinement/jobs/submit", {
      job_id: jobB.job_id,
      conclusions: [{ layer: "curated-shared", id: SHARED_ID, body: "无 workspace 的待办也可以产出共享层结论：提炼由接入方负责，平台只负责问责。", evidence_refs: jobB.evidence_ids, tags: ["ml1-repair"] }],
    });
    assert.equal(shared.status, 200, `a shared-layer conclusion from a workspace-less job must be accepted, got ${shared.status} ${JSON.stringify(shared.body)}`);
    assert.equal(shared.body.job.state, "completed", `a written conclusion completes the job, got ${JSON.stringify(shared.body.job.state)}`);
    assert.equal(shared.body.receipt.outcome, "written", `receipt outcome, got ${JSON.stringify(shared.body.receipt)}`);
    const sharedWrite = shared.body.receipt.writes[0];
    assert.equal(sharedWrite.id, SHARED_ID);
    const sharedPath = path.join(dataRoot, "curated", "shared", `${SHARED_ID}.md`);
    assert.equal(sharedWrite.path, sharedPath, `the shared-layer conclusion must land in curated/shared, got ${sharedWrite.path}`);
    const onDisk = parseFrontmatterTyped(await fs.readFile(sharedPath, "utf8")).frontmatter;
    assert.equal(onDisk.layer, "long-term", `curated-shared writes the long-term layer, got ${JSON.stringify(onDisk.layer)}`);
    assert.equal(onDisk.container, "long-term", `container must be long-term, got ${JSON.stringify(onDisk.container)}`);
    assert.equal(onDisk.tenant_id, "default");
    assert.deepEqual(onDisk.evidence_refs, jobB.evidence_ids, `the written memory must cite exactly the submitted evidence, got ${JSON.stringify(onDisk.evidence_refs)}`);

    // 立刻读回：回执指向的那份就是读回来的那份。
    const readBack = await post(port, "/v1/get", { id: SHARED_ID });
    assert.equal(readBack.status, 200, `the written shared memory must be readable, got ${readBack.status}`);
    assert.equal(readBack.body.item.path, sharedPath);
    assert.deepEqual(await formalMemoryFiles(), [`curated/shared/${SHARED_ID}.md`], `only the accepted shared conclusion may exist in the formal layers, got ${JSON.stringify(await formalMemoryFiles())}`);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
