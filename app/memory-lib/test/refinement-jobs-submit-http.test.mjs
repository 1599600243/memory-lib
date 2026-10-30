// MEMORY-LOOP-1（第二垂直切片）——"领取者提交结论 ⇒ 正式记忆落盘 + 可立即读回"，公开 HTTP 判别测试。
//
// 为什么必须打在 HTTP 这一层：本切片要的是**公开接口**能力 —— POST /v1/refinement/jobs/submit
// 必须真挂在真实服务上、真受认证与租户作用域约束、真的用**服务端那个** memoryWriter 落盘
// （而不是自己 new 一个 writer 绕过索引/图事件），并且成功之后 POST /v1/get 能立刻按 id 读回同一份内容。
//
// 夹具刻意是**非空**的正常对话：空夹具区分不了"因为没内容所以没写"和"因为没接线所以没写"。
// 期望值全部来自**独立真值源**：请求里发出去的值、夹具 registry 里的身份、以及本测试自己的时钟；
// 不用被测代码的算法重算一遍期望值（那是同义反复，永远不会红）。
//
// 负向控制（每一条都必须**零正式记忆写入** —— 用前后两次"正式记忆文件清单"比对证明，不是靠"接口回 4xx"自证）：
//   ① 既没有 conclusions 也没有 no_durable_fact；② 两者同时给；③ 空 conclusions；
//   ④ 无 evidence_refs / 空 evidence_refs；⑤ 不存在的证据 id；⑥ 跨租户（真实存在但别人的）证据 id；
//   ⑦ 结论声明的 project 与待办 project 不一致；⑧ 非领取者提交。
// 其中 ⑤ 与 ⑥ 必须回**同一个**公开错误（不区分"不存在"与"不是你的"）：不能把证据 id 变成探测器。
//
// 证据**兼容性**（修复批次补上：只判 Boolean 是不够的，每一条证据都要逐个看内容）：
//   ⑦-4' 同主体、**另一个 workspace** 的证据 ⇒ 400 EVIDENCE_INCOMPATIBLE，零写入；
//   ⑦-4'' 证据 frontmatter 里**没有 workspace** ⇒ 不能支撑项目层结论，也不能支撑"项目待办"的
//         非项目层结论（证据本身不指向那个项目）；无 workspace 的待办更不许自报 project。
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
const OWNER = { agent_id: "pilot-01", role_id: "researcher" };
// same-tenant 的第二个角色：同组同用户、不同角色 —— 用来验"本租户内非领取者也不许提交"。
const SAME_TENANT = { agent_id: "pilot-01", role_id: "steward" };
// 另一个租户：用来造"真实存在但本主体读不到"的证据（跨租户）。
const OTHER_TENANT = { agent_id: "pilot-01", role_id: "pet-steward" };
const WORKSPACE = "D:/MemoryLib/app/memory-lib";
const PROJECT = "d-memorylib-app-memory-lib";
// 同一主体的**另一个项目**：用来证明"证据的 workspace 与待办的项目必须兼容"。
const ALT_WORKSPACE = "D:/MemoryLib/app/memory-lib-6-alt";
const ALT_PROJECT = "d-memorylib-app-memory-lib-6-alt";
const NO_DURABLE_FACT_REASONS = ["no_durable_fact", "already_covered", "out_of_scope", "insufficient_context", "duplicate"];

test("ML1 切片2：领取者提交结论落盘可读回；零输出/负向控制零写入；缺失与越权证据同一公开错误", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-submit-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const pilot = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef).agents.find((item) => item.agent_id === "pilot-01");
  const roleOf = (roleId) => pilot.roles.find((item) => item.role_id === roleId);
  Object.assign(roleOf("researcher"), { group_id: "group-ml1", user_id: "user-ml1" });
  // 带 workspace 的捕获要求角色持有该项目的项目作用域（localhost-server 的捕获路由按
  // workspaceKey(workspace) 派生 project 再校验），所以这里精确授一个同名项目作用域。
  // 另一个项目也要授权，才能造出"同一主体、不同 workspace"的证据。
  roleOf("researcher").scopes = [
    ...roleOf("researcher").scopes,
    { layer: "memory", visibility: "project", project: PROJECT },
    { layer: "memory", visibility: "project", project: ALT_PROJECT },
  ];
  Object.assign(roleOf("steward"), { group_id: "group-ml1", user_id: "user-ml1" });
  Object.assign(roleOf("pet-steward"), { group_id: "group-ml2", user_id: "user-ml2" });
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const libFactory = createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
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
    libFactory,
  });

  async function post(port, url, body, principal = OWNER) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }

  // 正式记忆文件清单：用来证明"校验失败 ⇒ 零正式写入"。
  // 只比"接口回了 4xx"不算数 —— 这里列的是真实存在于 dataRoot 下的 .md 相对路径。
  // 排除两类**不是本次提交产物**的东西，否则清单会把噪声算成"写入"：
  //   evidence/                        = 原文证据层（本切片不碰）
  //   runtime/refinement-inspection.md = 提炼巡检报告（每次捕获由 refinement-observability 自动重写；
  //     它已挪出检索根、落在 runtime/ 下，不再是可检索的正式层记录 —— 按**确切的**新路径排除）
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

  async function capture(port, body, principal) {
    const result = await post(port, "/v1/conversations/capture", body, principal);
    assert.equal(result.status, 200, `capture must succeed, got ${result.status} ${JSON.stringify(result.body)}`);
    return result.body.evidenceId;
  }

  async function jobFor(port, conversationId, principal = OWNER) {
    const listed = await post(port, "/v1/refinement/jobs/list", {}, principal);
    assert.equal(listed.status, 200, `jobs list must be a real route, got ${listed.status}`);
    const job = listed.body.jobs.find((item) => item.conversation_id === conversationId);
    assert.ok(job, `expected a job for ${conversationId}, got ${JSON.stringify(listed.body.jobs.map((item) => item.conversation_id))}`);
    return job;
  }

  async function claimJob(port, jobId, principal = OWNER) {
    const claimed = await post(port, "/v1/refinement/jobs/claim", { job_id: jobId }, principal);
    assert.equal(claimed.status, 200, `claim must succeed, got ${claimed.status} ${JSON.stringify(claimed.body)}`);
    assert.equal(claimed.body.job.state, "claimed");
    return claimed.body.job;
  }

  // 结论草稿的默认形状全部来自**独立真值源**（待办自己的 target_layer / workspace 推导出来的 project）。
  const conclusionFor = (job, evidenceId, overrides = {}) => ({
    layer: job.target_layer,
    project: job.project,
    body: "提炼结论：MEMORY-LOOP-1 切片2 要求领取者提交结论后才算完成，提交即落盘并可立刻读回。",
    evidence_refs: [evidenceId],
    ...overrides,
  });

  // /v1/get 回的是**平文本** frontmatter（既有口径，别改它）：这里按该口径把它还原成类型化的值，
  // 才能对"读回来的 evidence_refs 就是发出去的那一批"下具体断言（而不是拿两个字符串比）。
  const readBackFrontmatterRefs = (raw) => { try { return JSON.parse(String(raw)); } catch { return String(raw); } };

  try {
    const port = (await server.listen()).port;

    // 夹具：owner 自己的一段完成对话（正常结论用）。
    const ownerEvidenceId = await capture(port, {
      messages: [
        { role: "user", content: "这一片做提炼结论提交：领取者提交之后才算完成。" },
        { role: "assistant", content: "记下了：结论要带上证据引用，而且写完必须能立刻读回。" },
      ],
      conversation_id: "ml1s2-owner-conv",
      event_id: "ml1s2-owner-event",
      source: "ml1s2-http-test",
      workspace: WORKSPACE,
    }, OWNER);

    // 夹具：另一个租户的一段完成对话。它的证据**真实存在**，只是本主体读不到 ——
    // 这是"跨租户"与"根本不存在"必须回同一个公开错误的那条负向控制的前提。
    const sub = createLocalhostServer({
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
      libFactory,
    });
    const subPort = (await sub.listen()).port;
    let foreignEvidenceId;
    try {
      foreignEvidenceId = await capture(subPort, {
        messages: [
          { role: "user", content: "另一个租户的对话：这段证据属于 group-ml2 / user-ml2。" },
          { role: "assistant", content: "明白，本租户之外的主体不该能拿它来写记忆。" },
        ],
        conversation_id: "ml1s2-foreign-conv",
        event_id: "ml1s2-foreign-event",
        source: "ml1s2-http-test",
        workspace: WORKSPACE,
      }, OTHER_TENANT);
    } finally {
      await sub.close();
    }
    assert.match(foreignEvidenceId, /^conversation-[0-9a-f]{24}$/u);
    assert.notEqual(foreignEvidenceId, ownerEvidenceId);

    // 夹具：owner 的另外三段完成对话 —— 零输出用例、以及负向控制共用的一个待办（保持 claimed，不被污染）。
    const zeroEvidenceId = await capture(port, {
      messages: [
        { role: "user", content: "这段对话只聊了天气，没有什么值得长期记住的结论。" },
        { role: "assistant", content: "是的，这里没有可提炼的持久事实。" },
      ],
      conversation_id: "ml1s2-zero-conv",
      event_id: "ml1s2-zero-event",
      source: "ml1s2-http-test",
      workspace: WORKSPACE,
    }, OWNER);
    const negativeEvidenceId = await capture(port, {
      messages: [
        { role: "user", content: "这段对话用来跑负向控制，不许写出任何正式记忆。" },
        { role: "assistant", content: "收到：负向控制的每一次调用都必须零写入。" },
      ],
      conversation_id: "ml1s2-negative-conv",
      event_id: "ml1s2-negative-event",
      source: "ml1s2-http-test",
      workspace: WORKSPACE,
    }, OWNER);

    // 夹具：同一主体的**另一个 workspace** 的一段完成对话（"同主体、不同项目"的证据）。
    const altEvidenceId = await capture(port, {
      messages: [
        { role: "user", content: "另一个项目的对话：这段证据属于 memory-lib-6-alt，不属于 memory-lib。" },
        { role: "assistant", content: "明白，跨项目的证据不能被拿来支撑这个项目的结论。" },
      ],
      conversation_id: "ml1s2-alt-conv",
      event_id: "ml1s2-alt-event",
      source: "ml1s2-http-test",
      workspace: ALT_WORKSPACE,
    }, OWNER);
    // 夹具：**没有 workspace** 的一段完成对话（自动捕获入口本来就不带 workspace）。
    const noWorkspaceEvidenceId = await capture(port, {
      messages: [
        { role: "user", content: "不带 workspace 的对话：这段证据不知道属于哪个项目。" },
        { role: "assistant", content: "收到：没有 workspace 的证据不能支撑项目层结论。" },
      ],
      conversation_id: "ml1s2-noworkspace-conv",
      event_id: "ml1s2-noworkspace-event",
      source: "ml1s2-http-test",
    }, OWNER);

    // ① 正向：领取待办 ⇒ 提交一条结论 ⇒ completed + 回执。
    const ownerJob = await claimJob(port, (await jobFor(port, "ml1s2-owner-conv")).job_id);
    assert.equal(ownerJob.evidence_ids[0], ownerEvidenceId, "the job must reference the captured evidence");
    assert.equal(ownerJob.project, PROJECT, "the job project must be derived from the capture workspace");
    assert.equal(ownerJob.target_layer, "project-state");

    const formalBefore = await formalMemoryFiles();
    assert.deepEqual(formalBefore, [], `the fixture must start with zero formal memories, got ${JSON.stringify(formalBefore)}`);

    const submitStart = Date.now();
    const accepted = await post(port, "/v1/refinement/jobs/submit", {
      job_id: ownerJob.job_id,
      conclusions: [conclusionFor(ownerJob, ownerEvidenceId, { id: "ml1s2-conclusion-1", tags: ["ml1-slice2"] })],
    });
    const submitEnd = Date.now();
    assert.equal(accepted.status, 200, `submit must succeed, got ${accepted.status} ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.job.job_id, ownerJob.job_id);
    assert.equal(accepted.body.job.state, "completed", `a written conclusion must complete the job, got ${JSON.stringify(accepted.body.job)}`);
    assert.equal(accepted.body.receipt.outcome, "written", `receipt outcome, got ${JSON.stringify(accepted.body.receipt)}`);
    assert.equal(accepted.body.receipt.writes.length, 1, `one conclusion ⇒ one write record, got ${JSON.stringify(accepted.body.receipt.writes)}`);
    const write = accepted.body.receipt.writes[0];
    assert.equal(write.id, "ml1s2-conclusion-1", `receipt must carry the written id, got ${JSON.stringify(write)}`);
    assert.equal(write.layer, "project-state", `receipt layer must be the job target layer, got ${JSON.stringify(write)}`);
    assert.equal(write.created, true, `a first write must be reported as created, got ${JSON.stringify(write)}`);
    assert.equal(write.updated, undefined, `a created write must not also claim updated, got ${JSON.stringify(write)}`);
    assert.deepEqual(Object.keys(write).sort(), ["created", "id", "layer", "path", "written_at"], `receipt entries must be exactly {id,layer,path,created|updated,written_at}, got ${JSON.stringify(write)}`);
    const expectedPath = path.join(dataRoot, "project-state", PROJECT, "current-state.md");
    assert.equal(write.path, expectedPath, `receipt path must be the file that was actually written, got ${write.path}`);
    const completedAt = Date.parse(accepted.body.receipt.completed_at);
    const writtenAt = Date.parse(write.written_at);
    assert.ok(writtenAt >= submitStart && writtenAt <= submitEnd, `written_at must be the write instant, got ${write.written_at}`);
    assert.ok(completedAt >= writtenAt && completedAt <= submitEnd, `completed_at must follow written_at, got ${accepted.body.receipt.completed_at} vs ${write.written_at}`);

    // ② 落盘即真相：文件真的在，且带着**精确的** evidence_refs（不是"有条目就行"）。
    // frontmatter 的值一律 JSON 引号渲染（renderFrontmatter 的既有口径），所以断言按引号形态钉。
    const onDisk = await fs.readFile(write.path, "utf8");
    assert.match(onDisk, /^---\n/u, "a written memory must carry frontmatter");
    assert.match(onDisk, new RegExp(`^id: "?ml1s2-conclusion-1"?$`, "mu"), `frontmatter id, got:\n${onDisk.slice(0, 400)}`);
    assert.match(onDisk, new RegExp(`^evidence_refs: \\["${ownerEvidenceId}"\\]$`, "mu"), `frontmatter evidence_refs must be exactly the submitted refs, got:\n${onDisk.slice(0, 600)}`);
    assert.match(onDisk, /提炼结论：MEMORY-LOOP-1 切片2/u, "the body must be the submitted conclusion body");
    // 盘上那份与回读那份必须是同一批 ref：用 frontmatter 的既有解析器读回**类型化**的值，
    // 而不是拿字符串比字符串（后者分不清 "["x"]" 与 ["x"]）。
    const onDiskFrontmatter = parseFrontmatterTyped(onDisk).frontmatter;
    assert.deepEqual(onDiskFrontmatter.evidence_refs, [ownerEvidenceId], `on-disk evidence_refs, got ${JSON.stringify(onDiskFrontmatter.evidence_refs)}`);
    assert.deepEqual(onDiskFrontmatter.tags, ["ml1-slice2"], `on-disk tags, got ${JSON.stringify(onDiskFrontmatter.tags)}`);

    // ③ 立刻读回：POST /v1/get 按 id 取到同一份内容与同一批 evidence_refs。
    const readBack = await post(port, "/v1/get", { id: "ml1s2-conclusion-1" });
    assert.equal(readBack.status, 200, `the written memory must be readable immediately, got ${readBack.status} ${JSON.stringify(readBack.body)}`);
    assert.equal(readBack.body.item.id, "ml1s2-conclusion-1");
    assert.equal(readBack.body.item.path, write.path, "the readback must resolve to the same file");
    // /v1/get 的 frontmatter 是**平文本**（既有口径），所以与盘上那份逐字段比字符串：
    // 盘上的类型化值与读回值必须完全一致（这就是"回执指向的那份记忆"与"读回来的那份"是同一份的判据）。
    const diskRaw = parseFrontmatterTyped(await fs.readFile(write.path, "utf8")).frontmatter;
    assert.equal(String(readBack.body.item.frontmatter.evidence_refs), JSON.stringify(diskRaw.evidence_refs), `readback evidence_refs must match the file on disk, got ${JSON.stringify(readBack.body.item.frontmatter.evidence_refs)} vs ${JSON.stringify(diskRaw.evidence_refs)}`);
    assert.equal(JSON.stringify(readBackFrontmatterRefs(readBack.body.item.frontmatter.evidence_refs)), JSON.stringify([ownerEvidenceId]), `readback evidence_refs value, got ${JSON.stringify(readBack.body.item.frontmatter.evidence_refs)}`);
    assert.equal(JSON.stringify(readBackFrontmatterRefs(readBack.body.item.frontmatter.tags)), JSON.stringify(["ml1-slice2"]), `readback tags value, got ${JSON.stringify(readBack.body.item.frontmatter.tags)}`);

    // ④ 完成态是持久的：列表与 get 都反映 completed，且回执留在 job 上（重启服务也要还在）。
    const afterSubmit = await post(port, "/v1/refinement/jobs/get", { job_id: ownerJob.job_id });
    assert.equal(afterSubmit.body.job.state, "completed");
    assert.equal(afterSubmit.body.job.receipt.writes[0].id, "ml1s2-conclusion-1");
    assert.equal(afterSubmit.body.job.submissions.length, 1, `the submission history must be durable, got ${JSON.stringify(afterSubmit.body.job.submissions)}`);
    const formallyAfterAccept = await formalMemoryFiles();
    assert.deepEqual(formallyAfterAccept, [relOf(write.path)], `exactly one new formal memory, got ${JSON.stringify(formallyAfterAccept)}`);

    // ④' 重复提交同一份载荷是幂等的：不重复写，回执逐字段相同（"完成"不许被重做）。
    const replay = await post(port, "/v1/refinement/jobs/submit", {
      job_id: ownerJob.job_id,
      conclusions: [conclusionFor(ownerJob, ownerEvidenceId, { id: "ml1s2-conclusion-1", tags: ["ml1-slice2"] })],
    });
    assert.equal(replay.status, 200, `replaying the same submission must be accepted, got ${replay.status} ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.idempotent, true, `replay must be reported as idempotent, got ${JSON.stringify(replay.body.receipt)}`);
    assert.deepEqual(replay.body.receipt, accepted.body.receipt, "a replay must return the very same receipt");
    assert.deepEqual(await formalMemoryFiles(), formallyAfterAccept, "a replay must not write anything");

    // ⑤ 零输出：no_durable_fact + 闭合枚举原因 ⇒ completed + no_durable_fact 回执，且**零写入**。
    const zeroJob = await claimJob(port, (await jobFor(port, "ml1s2-zero-conv")).job_id);
    const zeroBefore = await formalMemoryFiles();
    const zero = await post(port, "/v1/refinement/jobs/submit", { job_id: zeroJob.job_id, no_durable_fact: { reason: "no_durable_fact", note: "只有天气寒暄" } });
    assert.equal(zero.status, 200, `a structured zero-output submit must be accepted, got ${zero.status} ${JSON.stringify(zero.body)}`);
    assert.equal(zero.body.job.state, "completed", `zero output is an accepted completion, got ${JSON.stringify(zero.body.job.state)}`);
    assert.equal(zero.body.receipt.outcome, "no_durable_fact");
    assert.equal(zero.body.receipt.reason, "no_durable_fact");
    assert.deepEqual(zero.body.receipt.writes, [], `a zero-output completion must write nothing, got ${JSON.stringify(zero.body.receipt.writes)}`);
    assert.deepEqual(await formalMemoryFiles(), zeroBefore, "a zero-output completion must not change the formal memory files");
    const zeroJobState = await post(port, "/v1/refinement/jobs/get", { job_id: zeroJob.job_id });
    assert.equal(zeroJobState.body.job.receipt.outcome, "no_durable_fact", "the zero-output receipt must be durable");

    // ⑥ 闭合枚举之外的原因不许当零输出混过去。
    const zeroBadReason = await post(port, "/v1/refinement/jobs/submit", { job_id: zeroJob.job_id, no_durable_fact: { reason: "whatever" } });
    assert.equal(zeroBadReason.status, 400, `an open-ended reason must be rejected, got ${zeroBadReason.status} ${JSON.stringify(zeroBadReason.body)}`);
    assert.equal(zeroBadReason.body.error.code, "BAD_REQUEST");
    const zeroNoReason = await post(port, "/v1/refinement/jobs/submit", { job_id: zeroJob.job_id, no_durable_fact: {} });
    assert.equal(zeroNoReason.status, 400, `a reason-less no_durable_fact must be rejected, got ${zeroNoReason.status}`);

    // ⑦ 负向控制共用一个仍处于 claimed 的待办 —— 每条都必须 4xx 且**零正式写入**。
    const negativeJob = await claimJob(port, (await jobFor(port, "ml1s2-negative-conv")).job_id);
    const negativeBase = await formalMemoryFiles();
    assert.deepEqual(negativeBase, formallyAfterAccept, "the negative fixture must start from the post-accept file list");

    async function expectRejected(label, body, expectedStatus, expectedCode, principal = OWNER) {
      const result = await post(port, "/v1/refinement/jobs/submit", { job_id: negativeJob.job_id, ...body }, principal);
      assert.equal(result.status, expectedStatus, `${label}: expected ${expectedStatus}, got ${result.status} ${JSON.stringify(result.body)}`);
      assert.notEqual(result.status, 500, `${label}: an expected error must never be reported as 500`);
      assert.equal(result.body.error.code, expectedCode, `${label}: error code, got ${JSON.stringify(result.body.error)}`);
      assert.deepEqual(await formalMemoryFiles(), negativeBase, `${label}: a rejected submission must perform zero formal-memory writes`);
      const current = await post(port, "/v1/refinement/jobs/get", { job_id: negativeJob.job_id });
      assert.equal(current.body.job.state, "claimed", `${label}: a rejected submission must leave the job claimable, got ${current.body.job.state}`);
      return result;
    }

    // ⑦-1 形状：两者都没有 / 两者都给 / conclusions 为空。
    await expectRejected("neither form", {}, 400, "BAD_REQUEST");
    await expectRejected("both forms", { conclusions: [conclusionFor(negativeJob, negativeEvidenceId)], no_durable_fact: { reason: "duplicate" } }, 400, "BAD_REQUEST");
    await expectRejected("empty conclusions", { conclusions: [] }, 400, "BAD_REQUEST");

    // ⑦-2 每条结论必须有非空 evidence_refs。
    await expectRejected("missing evidence_refs", { conclusions: [{ layer: "project-state", project: PROJECT, body: "没有证据引用的结论" }] }, 400, "BAD_REQUEST");
    await expectRejected("empty evidence_refs", { conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { evidence_refs: [], id: "ml1s2-empty-refs" })] }, 400, "BAD_REQUEST");

    // ⑦-2' occurred_at 在**计划阶段**判掉：否则"第 1 条已写盘、第 2 条因时间串不合法抛错"会变成
    // 一个本来完全可以避免的部分写入。
    await expectRejected(
      "unparseable occurred_at",
      { conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { id: "ml1s2-bad-instant", occurred_at: "not-a-date" })] },
      400,
      "BAD_REQUEST",
    );

    // ⑦-3 证据不存在 与 证据是别人租户的 ⇒ **同一个公开错误**（不区分"不存在"与"不是你的"）。
    const foreignProjectDir = path.join(dataRoot, "project-state", PROJECT);
    const foreignDirBefore = await fs.readdir(foreignProjectDir).catch(() => []);
    const missingEvidence = await expectRejected(
      "missing evidence",
      { conclusions: [conclusionFor(negativeJob, "conversation-000000000000000000000000", { id: "ml1s2-missing-evidence" })] },
      404,
      "EVIDENCE_NOT_FOUND",
    );
    const foreignEvidence = await expectRejected(
      "cross-tenant evidence",
      { conclusions: [conclusionFor(negativeJob, foreignEvidenceId, { id: "ml1s2-foreign-evidence" })] },
      404,
      "EVIDENCE_NOT_FOUND",
    );
    assert.deepEqual(foreignEvidence.body.error, missingEvidence.body.error, "missing and unauthorized evidence must be publicly indistinguishable");
    assert.deepEqual(await fs.readdir(foreignProjectDir).catch(() => []), foreignDirBefore, "a refused evidence ref must leave the target project directory untouched");

    // ⑦-4 workspace/project 兼容：结论声明了 project 就必须等于待办的 project，且待办必须有 workspace。
    const mismatch = await expectRejected(
      "project mismatch",
      { conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { id: "ml1s2-project-mismatch", project: "some-other-project" })] },
      400,
      "PROJECT_MISMATCH",
    );
    assert.match(String(mismatch.body.error.message), /project/u, `the mismatch message must name the rule, got ${JSON.stringify(mismatch.body.error)}`);
    await expectRejected(
      "unknown layer",
      { conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { id: "ml1s2-unknown-layer", layer: "curated-bogus", project: undefined })] },
      400,
      "BAD_REQUEST",
    );

    // ⑦-4' 证据**兼容性**：每一条可读证据都要逐个检查内容，而不是"读得到就算"。
    // 同主体（同租户同用户）、但属于**另一个项目**的证据，不能拿来支撑这个项目的结论。
    const crossWorkspace = await expectRejected(
      "cross-workspace evidence",
      { conclusions: [conclusionFor(negativeJob, altEvidenceId, { id: "ml1s2-cross-workspace" })] },
      400,
      "EVIDENCE_INCOMPATIBLE",
    );
    assert.match(String(crossWorkspace.body.error.message), /workspace|project/u, `the incompatibility message must name the rule, got ${JSON.stringify(crossWorkspace.body.error)}`);
    // 没有 workspace 的证据：既不能支撑项目层结论，也不能支撑"有项目的待办"的非项目层结论
    // （证据本身并不指向那个项目 —— 放宽这一条就等于允许跨项目借证据）。
    await expectRejected(
      "workspace-less evidence for a project layer",
      { conclusions: [conclusionFor(negativeJob, noWorkspaceEvidenceId, { id: "ml1s2-noworkspace-project-layer" })] },
      400,
      "EVIDENCE_INCOMPATIBLE",
    );
    await expectRejected(
      "workspace-less evidence for a shared layer of a project job",
      { conclusions: [conclusionFor(negativeJob, noWorkspaceEvidenceId, { id: "ml1s2-noworkspace-shared", layer: "curated-shared", project: undefined })] },
      400,
      "EVIDENCE_INCOMPATIBLE",
    );
    // 无 workspace 的待办不许自报 project（没有可依据的项目就不许借一个）。
    const noWorkspaceJob = await claimJob(port, (await jobFor(port, "ml1s2-noworkspace-conv")).job_id);
    assert.equal(noWorkspaceJob.project, null, "a capture without a workspace must yield a project-less job");
    assert.equal(noWorkspaceJob.target_layer, "curated-shared");
    const declared = await post(port, "/v1/refinement/jobs/submit", {
      job_id: noWorkspaceJob.job_id,
      conclusions: [conclusionFor(noWorkspaceJob, noWorkspaceEvidenceId, { id: "ml1s2-declared-project", project: PROJECT })],
    });
    assert.equal(declared.status, 400, `a project-less job must not accept a declared project, got ${declared.status} ${JSON.stringify(declared.body)}`);
    assert.equal(declared.body.error.code, "PROJECT_MISMATCH", `error code, got ${JSON.stringify(declared.body.error)}`);
    assert.deepEqual(await formalMemoryFiles(), negativeBase, "a refused declared project must perform zero formal-memory writes");

    // ⑦-5 非领取者不许提交：同租户的另一个角色（甚至另一个租户）都拿不到。
    await expectRejected(
      "same-tenant non-claimant",
      { conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { id: "ml1s2-non-claimant" })] },
      403,
      "NOT_CLAIMANT",
      SAME_TENANT,
    );

    // ⑧ 负向控制跑完，待办仍然可被领取者正常完成 —— 证明上面那些拒绝没有把待办弄坏。
    const negativeAccepted = await post(port, "/v1/refinement/jobs/submit", {
      job_id: negativeJob.job_id,
      conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { id: "ml1s2-negative-ok", tags: ["ml1-slice2"] })],
    });
    assert.equal(negativeAccepted.status, 200, `the still-claimed job must still be submittable, got ${negativeAccepted.status} ${JSON.stringify(negativeAccepted.body)}`);
    assert.equal(negativeAccepted.body.job.state, "completed");
    assert.equal(negativeAccepted.body.receipt.writes[0].id, "ml1s2-negative-ok");
    // project-state 是"一个项目一份 current-state.md"（既有写入语义，本切片不改）：第一次写是 created，
    // 之后对这个文件的写入必须是 updated —— 回执要把这个区别如实报出来，调用方才知道自己覆盖了什么。
    const negativeWrite = negativeAccepted.body.receipt.writes[0];
    assert.equal(negativeWrite.path, path.join(dataRoot, "project-state", PROJECT, "current-state.md"));
    assert.equal(negativeWrite.created, undefined, `an overwrite must not claim to have created the file, got ${JSON.stringify(negativeWrite)}`);
    assert.equal(negativeWrite.updated, true, `overwriting an existing file must be reported as updated, got ${JSON.stringify(negativeWrite)}`);
    assert.deepEqual(Object.keys(negativeWrite).sort(), ["id", "layer", "path", "updated", "written_at"], `receipt entries must be exactly {id,layer,path,created|updated,written_at}, got ${JSON.stringify(negativeWrite)}`);
    const negativeReadBack = await post(port, "/v1/get", { id: "ml1s2-negative-ok" });
    assert.equal(negativeReadBack.status, 200, `readback after the negative batch, got ${negativeReadBack.status}`);
    assert.deepEqual(readBackFrontmatterRefs(negativeReadBack.body.item.frontmatter.evidence_refs), [negativeEvidenceId]);
    // 盘上那份文件的主人已经换成这一条结论（不是"接口说 updated 就算数"）：直接读文件核对。
    const negativeOnDisk = parseFrontmatterTyped(await fs.readFile(negativeWrite.path, "utf8"));
    assert.equal(negativeOnDisk.frontmatter.id, "ml1s2-negative-ok", "the file now belongs to the newly written conclusion");
    assert.deepEqual(negativeOnDisk.frontmatter.evidence_refs, [negativeEvidenceId], "and carries exactly that conclusion's evidence");
    // 被覆盖掉的那条结论不再可读 —— 这正是"回执必须报告 updated"的原因（不是本切片的缺陷，是既有层语义）。
    const overwritten = await post(port, "/v1/get", { id: "ml1s2-conclusion-1" });
    assert.equal(overwritten.status, 404, `the superseded project-state id must not resolve any more, got ${overwritten.status} ${JSON.stringify(overwritten.body)}`);

    // ⑨ 零写入的判据复核：只有两条真正被接受的结论落在正式层。
    const finalFiles = await formalMemoryFiles();
    assert.deepEqual(finalFiles, [relOf(write.path)], `only the accepted conclusions may exist in the formal layers, got ${JSON.stringify(finalFiles)}`);

    // ⑩ 非领取者：先领取再让本租户另一个角色提交，同样被拒（本待办已完成 ⇒ 也不能被篡改）。
    const stolen = await post(port, "/v1/refinement/jobs/submit", { job_id: negativeJob.job_id, conclusions: [conclusionFor(negativeJob, negativeEvidenceId, { id: "ml1s2-theft" })] }, SAME_TENANT);
    assert.equal(stolen.status, 403, `a non-claimant must not touch a completed job, got ${stolen.status} ${JSON.stringify(stolen.body)}`);
    assert.equal(stolen.body.error.code, "NOT_CLAIMANT");
    assert.deepEqual(await formalMemoryFiles(), finalFiles, "a refused theft must not write anything");

    // ⑪ 零输出原因的闭合枚举逐项都被接受（不许只实现一个值）。
    for (const reason of NO_DURABLE_FACT_REASONS) {
      const evidenceId = await capture(port, {
        messages: [
          { role: "user", content: `闭合枚举探测 ${reason}：这段对话用来逐项验证零输出的原因取值。` },
          { role: "assistant", content: `收到：原因枚举 ${reason} 必须被接受，并且不写任何正式记忆。` },
        ],
        conversation_id: `ml1s2-reason-${reason}`,
        event_id: `ml1s2-reason-event-${reason}`,
        source: "ml1s2-http-test",
        workspace: WORKSPACE,
      }, OWNER);
      const job = await claimJob(port, (await jobFor(port, `ml1s2-reason-${reason}`)).job_id);
      assert.deepEqual(job.evidence_ids, [evidenceId]);
      const before = await formalMemoryFiles();
      const result = await post(port, "/v1/refinement/jobs/submit", { job_id: job.job_id, no_durable_fact: { reason } });
      assert.equal(result.status, 200, `reason ${reason} must be accepted, got ${result.status} ${JSON.stringify(result.body)}`);
      assert.equal(result.body.receipt.reason, reason, `the receipt must echo the submitted reason, got ${JSON.stringify(result.body.receipt)}`);
      assert.equal(result.body.job.state, "completed");
      assert.deepEqual(await formalMemoryFiles(), before, `reason ${reason} must not write anything`);
    }
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
