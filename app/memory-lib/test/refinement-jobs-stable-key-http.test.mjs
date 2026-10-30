// MEMORY-LOOP-1（第四垂直切片）—— stable_key 冲突与取代，**公开 HTTP** 判别测试。
//
// 为什么打在这一层：单子把"冲突与取代"写成公开接口行为 —— 领取者提交结论时，若同 stable_key
// 已经有 active 记忆，一致就合并/刷新证据，冲突就要求显式 supersedes，并且：
//   ① 检索默认只返回当前有效版本；② 能显式看出"有冲突"；③ 取代链可追（旧条目留在盘上）。
// 这三条只有从 HTTP 这一层看才是产品语义（模块层可以自己造 writer、自己造作用域，看不出来）。
//
// 判别力来源：所有期望值都来自**独立真值源**（请求里发出去的值、盘上的文件、夹具身份），
// 不用被测代码重算一遍。每条"拒绝"都用**前后两次正式记忆文件清单**证明零写入，
// 而不是靠"接口回了 4xx"自证。
//
// 本切片钉住的语义（文档化在 src/refinement-jobs.mjs 与 src/write-memory.mjs 的注释里）：
//   1. stable_key 作用域 = (layer, project, tenant_id, group_id, user_id)：
//      跨组/跨用户/跨项目/跨层同 key **不冲突**（各自一条 active 记忆），这正是多租户要求。
//   2. body 等价 = 行尾归一（\r\n|\r → \n）+ 首尾 trim + 严格相等；等价 ⇒ 合并（并集 evidence_refs，
//      保留原 id，不产生第二个文件/版本）；不等价 ⇒ 冲突。
//   3. 冲突且未显式点名当前 active id ⇒ 409 SUPERSEDE_REQUIRED（带 stable_key 与 active_id）。
//   4. 冲突且点名的确是当前 active id ⇒ 走既有 writer.supersede（旧文件 status=superseded、
//      带 superseded_by/valid_to/取代链）。旧内容**不被物理覆盖**。
//   5. 点错/非 active/跨作用域的 supersedes ⇒ 409 且零写入。
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
// 另一个租户（不同 group_id/user_id，同 agent）：用来证明同 stable_key 跨租户**不冲突**。
const FOREIGN = { agent_id: "pilot-01", role_id: "pet-steward" };
const WORKSPACE = "D:/MemoryLib/app/memory-lib";
const PROJECT = "d-memorylib-app-memory-lib";
const WORKSPACE2 = "D:/MemoryLib/app/memory-lib-4-alt";
const PROJECT2 = "d-memorylib-app-memory-lib-4-alt";
// 检索判别标记：**同时**出现在"旧版本正文"和"新版本正文"里，但不出现在任何对话证据里。
// 这样"默认检索不到旧版本"是取代语义造成的，而不是"查询词在旧正文里根本没有"。
const MARKER = "稳定键冲突标记ZQ7";
const STABLE_KEY = "memory-loop-1-slice4-stable-key";
const PROJECT_KEY = "memory-loop-1-slice4-project-key";

// 同一份正文的两种写法：\n vs \r\n，以及行尾空格 —— 归一化后**必须**判为同一份（合并）。
const BODY_A_LINE1 = `提炼结论：MEMORY-LOOP-1 切片4 的${MARKER}说明旧版本要求每条结论都带稳定键。`;
const BODY_A_LINE2 = "第二行：旧版本的措辞。";
const BODY_A = `${BODY_A_LINE1}\n${BODY_A_LINE2}`;
const BODY_A_CRLF = `${BODY_A_LINE1}\r\n${BODY_A_LINE2}   `;
// 冲突正文：第 1 行相同（所以检索能同时匹配两版），第 2 行不同（所以归一化后不等价）。
const BODY_B = `${BODY_A_LINE1}\n第二行：新版本的措辞（冲突后取代）。`;

test("ML1 切片4：stable_key 同体合并 / 冲突要求 supersedes / 取代链可追且默认检索只见新版本", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-stable-key-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const pilot = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef).agents.find((item) => item.agent_id === "pilot-01");
  const roleOf = (roleId) => pilot.roles.find((item) => item.role_id === roleId);
  Object.assign(roleOf("researcher"), { group_id: "group-ml4", user_id: "user-ml4" });
  // 带 workspace 的捕获要求角色持有该项目的项目作用域（localhost-server 按 workspaceKey 派生 project
  // 再校验）；两个项目都要授权，才能造"同 stable_key、不同 project"的不冲突用例。
  roleOf("researcher").scopes = [
    ...roleOf("researcher").scopes.filter((scope) => scope.visibility !== "project"),
    { layer: "memory", visibility: "project", project: PROJECT },
    { layer: "memory", visibility: "project", project: PROJECT2 },
  ];
  Object.assign(roleOf("pet-steward"), { group_id: "group-ml4-foreign", user_id: "user-ml4-foreign" });
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

  // 正式记忆文件清单（排除不是本次提交产物的两处：原文证据层、提炼巡检报告）。
  // 巡检报告已挪出检索根，落在 runtime/ 下（不再是可检索的正式层记录）—— 按**确切的**新路径排除。
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

  const submit = (port, jobId, conclusions, principal = OWNER) => post(port, "/v1/refinement/jobs/submit", { job_id: jobId, conclusions }, principal);

  try {
    const port = (await server.listen()).port;

    async function capture(conversationId, principal = OWNER, workspace = WORKSPACE) {
      const result = await post(port, "/v1/conversations/capture", {
        messages: [
          { role: "user", content: `这一段对话属于 ${conversationId}：用来驱动提炼待办，正文里不含检索判别标记。` },
          { role: "assistant", content: "收到：结论由领取者提交，证据引用必须非空。" },
        ],
        conversation_id: conversationId,
        event_id: `${conversationId}-event`,
        source: "ml1s4-http-test",
        ...(workspace ? { workspace } : {}),
      }, principal);
      assert.equal(result.status, 200, `capture must succeed, got ${result.status} ${JSON.stringify(result.body)}`);
      return result.body.evidenceId;
    }

    async function claimedJob(conversationId, principal = OWNER) {
      const listed = await post(port, "/v1/refinement/jobs/list", {}, principal);
      assert.equal(listed.status, 200, `jobs list must be a real route, got ${listed.status}`);
      const job = listed.body.jobs.find((item) => item.conversation_id === conversationId);
      assert.ok(job, `expected a job for ${conversationId}, got ${JSON.stringify(listed.body.jobs.map((item) => item.conversation_id))}`);
      const claimed = await post(port, "/v1/refinement/jobs/claim", { job_id: job.job_id }, principal);
      assert.equal(claimed.status, 200, `claim must succeed, got ${claimed.status} ${JSON.stringify(claimed.body)}`);
      assert.equal(claimed.body.job.state, "claimed");
      return claimed.body.job;
    }

    const conclusionFor = (id, body, evidenceId, extra = {}) => ({
      layer: "curated-shared",
      id,
      body,
      evidence_refs: [evidenceId],
      stable_key: STABLE_KEY,
      ...extra,
    });

    async function readFrontmatter(id) {
      const readBack = await post(port, "/v1/get", { id });
      assert.equal(readBack.status, 200, `memory ${id} must be readable, got ${readBack.status} ${JSON.stringify(readBack.body)}`);
      return readBack.body.item;
    }
    // /v1/get 回的是**平文本** frontmatter（既有口径，别改它）：值一律 JSON 引号渲染，
    // 所以比较前按同一口径还原成类型化的值（与 write-memory 的 unquote 同一套解析）。
    const plain = (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      try { const parsed = JSON.parse(raw); return typeof parsed === "string" ? parsed : raw; } catch { return raw; }
    };

    // ---------- ① 首次写入：带 stable_key 的结论正常落盘，id 由结论给出 ----------
    const evidence1 = await capture("ml1s4-conv-1");
    const job1 = await claimedJob("ml1s4-conv-1");
    assert.equal(job1.project, PROJECT, "the job project must be derived from the capture workspace");
    const beforeAnyWrite = await formalMemoryFiles();
    assert.deepEqual(beforeAnyWrite, [], `the fixture must start with zero formal memories, got ${JSON.stringify(beforeAnyWrite)}`);

    const first = await submit(port, job1.job_id, [conclusionFor("ml1s4-kv-1", BODY_A, evidence1)]);
    assert.equal(first.status, 200, `the first stable-key conclusion must be accepted, got ${first.status} ${JSON.stringify(first.body)}`);
    assert.equal(first.body.job.state, "completed");
    assert.equal(first.body.receipt.outcome, "written");
    assert.equal(first.body.receipt.writes.length, 1, `one conclusion ⇒ one write record, got ${JSON.stringify(first.body.receipt.writes)}`);
    const firstWrite = first.body.receipt.writes[0];
    assert.equal(firstWrite.id, "ml1s4-kv-1", `receipt must carry the written id, got ${JSON.stringify(firstWrite)}`);
    const kvPath = path.join(dataRoot, "curated", "shared", "ml1s4-kv-1.md");
    assert.equal(firstWrite.path, kvPath, `receipt path must be the file that was actually written, got ${firstWrite.path}`);
    assert.equal(firstWrite.created, true, `a first write must be reported as created, got ${JSON.stringify(firstWrite)}`);
    // 存进 frontmatter 的 stable_key 必须是**发出去的那个值**（下一步的查找全靠它）。
    const firstOnDisk = parseFrontmatterTyped(await fs.readFile(kvPath, "utf8"));
    assert.equal(firstOnDisk.frontmatter.stable_key, STABLE_KEY, `on-disk stable_key, got ${JSON.stringify(firstOnDisk.frontmatter.stable_key)}`);
    assert.equal(firstOnDisk.frontmatter.status, "active", "a freshly written memory is active");
    assert.deepEqual(firstOnDisk.frontmatter.evidence_refs, [evidence1]);
    assert.equal(firstOnDisk.frontmatter.id, "ml1s4-kv-1");
    assert.deepEqual(await formalMemoryFiles(), [relOf(kvPath)], "exactly one formal memory after the first write");

    // ---------- ② 同 stable_key + 归一化后同一份正文 ⇒ 合并证据，不产生第二个文件/版本 ----------
    const evidence2 = await capture("ml1s4-conv-2");
    const job2 = await claimedJob("ml1s4-conv-2");
    const beforeMerge = await fs.readFile(kvPath, "utf8");
    const preMergeUpdatedAt = parseFrontmatterTyped(beforeMerge).frontmatter.updated_at;
    const mergeStart = Date.now();
    // 结论里的 id 与首次不同（ml1s4-kv-1-dup）—— 合并时必须**忽略**它、保留原 id。
    const merged = await submit(port, job2.job_id, [conclusionFor("ml1s4-kv-1-dup", BODY_A_CRLF, evidence2)]);
    const mergeEnd = Date.now();
    assert.equal(merged.status, 200, `a same-body stable-key conclusion must be merged, got ${merged.status} ${JSON.stringify(merged.body)}`);
    assert.equal(merged.body.job.state, "completed", `a merge completes the job, got ${JSON.stringify(merged.body.job.state)}`);
    assert.equal(merged.body.receipt.outcome, "merged", `receipt outcome must say merged, got ${JSON.stringify(merged.body.receipt)}`);
    assert.equal(merged.body.receipt.writes.length, 1);
    const mergeWrite = merged.body.receipt.writes[0];
    assert.equal(mergeWrite.action, "merged", `the receipt must expose action=merged, got ${JSON.stringify(mergeWrite)}`);
    assert.equal(mergeWrite.id, "ml1s4-kv-1", `a merge must preserve the existing id, got ${JSON.stringify(mergeWrite)}`);
    assert.equal(mergeWrite.path, kvPath, `a merge must rewrite the existing file, got ${JSON.stringify(mergeWrite)}`);
    assert.equal(mergeWrite.created, undefined, "a merge must not claim to have created a file");
    assert.ok(Date.parse(mergeWrite.written_at) >= mergeStart && Date.parse(mergeWrite.written_at) <= mergeEnd, `written_at must be the merge instant, got ${mergeWrite.written_at}`);
    assert.equal(mergeWrite.updated_at, parseFrontmatterTyped(await fs.readFile(kvPath, "utf8")).frontmatter.updated_at, "the receipt updated_at must be the value actually written to the file");
    // 盘上：同一个文件、同一个 id、证据并集（先有后加、去重、确定性）、正文与 stable_key 不变。
    const mergedOnDisk = parseFrontmatterTyped(await fs.readFile(kvPath, "utf8"));
    assert.equal(mergedOnDisk.frontmatter.id, "ml1s4-kv-1", "the merged memory keeps its id");
    assert.equal(mergedOnDisk.frontmatter.stable_key, STABLE_KEY);
    assert.deepEqual(mergedOnDisk.frontmatter.evidence_refs, [evidence1, evidence2], `a merge must union the evidence refs in order, got ${JSON.stringify(mergedOnDisk.frontmatter.evidence_refs)}`);
    assert.notEqual(mergedOnDisk.frontmatter.updated_at, preMergeUpdatedAt, `a merge must refresh updated_at, still ${JSON.stringify(preMergeUpdatedAt)}`);
    assert.ok(Date.parse(mergedOnDisk.frontmatter.updated_at) >= mergeStart, `the refreshed updated_at must be the merge instant, got ${mergedOnDisk.frontmatter.updated_at}`);
    assert.equal(parseFrontmatterTyped(beforeMerge).frontmatter.occurred_at, mergedOnDisk.frontmatter.occurred_at, "a merge must not rewrite occurred_at");
    assert.equal(mergedOnDisk.body.trim(), BODY_A.trim(), "a merge must not rewrite the body");
    assert.deepEqual(await formalMemoryFiles(), [relOf(kvPath)], "a merge must not create a second formal memory file");
    // 那个被忽略的 id 没有落盘。
    const dupReadBack = await post(port, "/v1/get", { id: "ml1s4-kv-1-dup" });
    assert.equal(dupReadBack.status, 404, `the ignored conclusion id must not resolve, got ${dupReadBack.status} ${JSON.stringify(dupReadBack.body)}`);
    // 合并结果立刻可读：证据并集就是从 /v1/get 读回来的那批。
    const afterMergeRead = await readFrontmatter("ml1s4-kv-1");
    assert.equal(afterMergeRead.path, kvPath);
    assert.deepEqual(JSON.parse(String(afterMergeRead.frontmatter.evidence_refs)), [evidence1, evidence2], `readback evidence_refs after merge, got ${JSON.stringify(afterMergeRead.frontmatter.evidence_refs)}`);

    // ---------- ③ 同 stable_key + 不同正文 + 未点名 supersedes ⇒ 409 SUPERSEDE_REQUIRED，零写入 ----------
    const evidence3 = await capture("ml1s4-conv-3");
    const job3 = await claimedJob("ml1s4-conv-3");
    const beforeConflict = await formalMemoryFiles();
    const beforeConflictText = await fs.readFile(kvPath, "utf8");
    const conflictStart = Date.now();
    const conflict = await submit(port, job3.job_id, [conclusionFor("ml1s4-kv-2", BODY_B, evidence3)]);
    const conflictEnd = Date.now();
    assert.equal(conflict.status, 409, `a differing body must be refused with 409, got ${conflict.status} ${JSON.stringify(conflict.body)}`);
    assert.notEqual(conflict.status, 500, "an expected conflict must never be reported as 500");
    assert.equal(conflict.body.error.code, "SUPERSEDE_REQUIRED", `error code, got ${JSON.stringify(conflict.body.error)}`);
    assert.ok(Array.isArray(conflict.body.error.conflicts) && conflict.body.error.conflicts.length === 1, `the conflict must be structured, got ${JSON.stringify(conflict.body.error)}`);
    const conflictDetail = conflict.body.error.conflicts[0];
    assert.equal(conflictDetail.stable_key, STABLE_KEY, `the conflict must name the stable_key, got ${JSON.stringify(conflictDetail)}`);
    assert.equal(conflictDetail.active_id, "ml1s4-kv-1", `the conflict must name the active memory id, got ${JSON.stringify(conflictDetail)}`);
    assert.equal(conflictDetail.index, 0, "the conflict must point at the conclusion that raised it");
    // 零写入：正式记忆文件清单逐项相同，且被拒的 id 读不到。
    assert.deepEqual(await formalMemoryFiles(), beforeConflict, "a refused conflict must perform zero formal-memory writes");
    const refusedReadBack = await post(port, "/v1/get", { id: "ml1s4-kv-2" });
    assert.equal(refusedReadBack.status, 404, `the refused conclusion must not exist, got ${refusedReadBack.status}`);
    // 盘上那份旧记忆一个字节都没被改写（冲突不许物理覆盖）。
    assert.equal(await fs.readFile(kvPath, "utf8"), beforeConflictText, "a refused conflict must leave the active file byte-identical");
    const kvAfterConflict = parseFrontmatterTyped(await fs.readFile(kvPath, "utf8"));
    assert.equal(kvAfterConflict.frontmatter.status, "active", "a refused conflict must leave the active memory active");
    assert.deepEqual(kvAfterConflict.frontmatter.evidence_refs, [evidence1, evidence2], "a refused conflict must not touch the active memory's evidence");
    // 持久且可重试：job 落在 needs_review，并带上**结构化**原因（public 4xx 之外还能在库里查到为什么）。
    const conflictJob = await post(port, "/v1/refinement/jobs/get", { job_id: job3.job_id });
    assert.equal(conflictJob.status, 200);
    assert.equal(conflictJob.body.job.state, "needs_review", `a conflict must leave the job in needs_review (retryable), got ${conflictJob.body.job.state}`);
    assert.equal(conflictJob.body.job.needs_review_reason, "SUPERSEDE_REQUIRED", `the durable reason must be structured, got ${JSON.stringify(conflictJob.body.job.needs_review_reason)}`);
    assert.deepEqual(conflictJob.body.job.conflicts.map((item) => [item.stable_key, item.active_id]), [[STABLE_KEY, "ml1s4-kv-1"]], `the durable conflict record, got ${JSON.stringify(conflictJob.body.job.conflicts)}`);
    const lastSubmission = conflictJob.body.job.submissions[conflictJob.body.job.submissions.length - 1];
    assert.equal(lastSubmission.outcome, "SUPERSEDE_REQUIRED", `the durable submission history must record the rejection, got ${JSON.stringify(lastSubmission)}`);
    assert.ok(Date.parse(lastSubmission.at) >= conflictStart && Date.parse(lastSubmission.at) <= conflictEnd, `the rejection instant must be the submit instant, got ${lastSubmission.at}`);

    // ---------- ④ 显式点名当前 active id ⇒ 走既有 supersede：旧条目留盘 + 取代链 ----------
    const superseded = await submit(port, job3.job_id, [conclusionFor("ml1s4-kv-2", BODY_B, evidence3, { supersedes: ["ml1s4-kv-1"] })]);
    assert.equal(superseded.status, 200, `naming the active memory must be accepted, got ${superseded.status} ${JSON.stringify(superseded.body)}`);
    assert.equal(superseded.body.job.state, "completed", `a valid supersede completes the job, got ${JSON.stringify(superseded.body.job.state)}`);
    assert.equal(superseded.body.receipt.outcome, "superseded", `receipt outcome must say superseded, got ${JSON.stringify(superseded.body.receipt)}`);
    const superWrite = superseded.body.receipt.writes[0];
    assert.equal(superWrite.action, "superseded", `the receipt must expose action=superseded, got ${JSON.stringify(superWrite)}`);
    assert.equal(superWrite.id, "ml1s4-kv-2", `the receipt must name the new id, got ${JSON.stringify(superWrite)}`);
    assert.equal(superWrite.old_id, "ml1s4-kv-1", `the receipt must name the superseded id, got ${JSON.stringify(superWrite)}`);
    const kv2Path = path.join(dataRoot, "curated", "shared", "ml1s4-kv-2.md");
    assert.equal(superWrite.path, kv2Path, `the new memory must be its own file, got ${superWrite.path}`);
    // 旧文件还在原地：status=superseded、superseded_by=新 id、valid_to=取代时刻、正文**未被覆盖**。
    const oldOnDisk = parseFrontmatterTyped(await fs.readFile(kvPath, "utf8"));
    assert.equal(oldOnDisk.frontmatter.id, "ml1s4-kv-1", "the superseded memory must keep its identity");
    assert.equal(oldOnDisk.frontmatter.status, "superseded", `the old memory must be marked superseded, got ${JSON.stringify(oldOnDisk.frontmatter.status)}`);
    assert.equal(oldOnDisk.frontmatter.superseded_by, "ml1s4-kv-2", `the old memory must point at the new one, got ${JSON.stringify(oldOnDisk.frontmatter.superseded_by)}`);
    assert.equal(oldOnDisk.frontmatter.stable_key, STABLE_KEY, "the old memory must keep its stable_key (that is the chain)");
    assert.ok(oldOnDisk.frontmatter.valid_to, `the old memory must be closed with valid_to, got ${JSON.stringify(oldOnDisk.frontmatter.valid_to)}`);
    // 取代链是**同一时刻**的两端：旧的 valid_to 必须等于新的 valid_from（不是两次 now() 各写一个值）。
    const newOnDisk = parseFrontmatterTyped(await fs.readFile(kv2Path, "utf8"));
    assert.equal(Date.parse(oldOnDisk.frontmatter.valid_to), Date.parse(newOnDisk.frontmatter.valid_from), `old.valid_to must equal new.valid_from, got ${oldOnDisk.frontmatter.valid_to} vs ${newOnDisk.frontmatter.valid_from}`);
    assert.equal(oldOnDisk.body.trim(), BODY_A.trim(), "the superseded content must not be physically overwritten");
    // 新文件：status=active、supersedes=[旧 id]、stable_key 延续。
    assert.equal(newOnDisk.frontmatter.id, "ml1s4-kv-2");
    assert.equal(newOnDisk.frontmatter.status, "active", `the new memory must be active, got ${JSON.stringify(newOnDisk.frontmatter.status)}`);
    assert.deepEqual(newOnDisk.frontmatter.supersedes, ["ml1s4-kv-1"], `the new memory must carry the supersedes chain, got ${JSON.stringify(newOnDisk.frontmatter.supersedes)}`);
    assert.equal(newOnDisk.frontmatter.stable_key, STABLE_KEY, "the new memory must carry the same stable_key");
    assert.deepEqual(newOnDisk.frontmatter.evidence_refs, [evidence3], "the new memory carries its own evidence");
    assert.deepEqual(await formalMemoryFiles(), [relOf(kvPath), relOf(kv2Path)], `both versions must exist on disk (old + new), got ${JSON.stringify(await formalMemoryFiles())}`);

    // ---------- ⑤ 精确读取：新旧都能读回，且各自暴露链与冲突元数据 ----------
    const oldItem = await readFrontmatter("ml1s4-kv-1");
    assert.equal(oldItem.path, kvPath);
    assert.equal(plain(oldItem.frontmatter.status), "superseded", `exact get on the old id must expose status=superseded, got ${JSON.stringify(oldItem.frontmatter.status)}`);
    assert.equal(plain(oldItem.frontmatter.superseded_by), "ml1s4-kv-2", `exact get on the old id must expose the successor, got ${JSON.stringify(oldItem.frontmatter.superseded_by)}`);
    assert.equal(plain(oldItem.frontmatter.stable_key), STABLE_KEY, "exact get on the old id must expose the stable_key");
    assert.ok(plain(oldItem.frontmatter.valid_to).length > 0, "exact get on the old id must expose valid_to");
    const newItem = await readFrontmatter("ml1s4-kv-2");
    assert.equal(plain(newItem.frontmatter.status), "active");
    assert.equal(plain(newItem.frontmatter.stable_key), STABLE_KEY);
    assert.equal(JSON.stringify(JSON.parse(String(newItem.frontmatter.supersedes))), JSON.stringify(["ml1s4-kv-1"]), `exact get on the new id must expose the supersedes chain, got ${JSON.stringify(newItem.frontmatter.supersedes)}`);

    // ---------- ⑥ 检索：默认只回新版本；include_superseded=true 让旧版本可见 ----------
    const search = async (extra = {}) => {
      const result = await post(port, "/v1/search", { query: MARKER, searchMode: "memories", limit: 20, ...extra });
      assert.equal(result.status, 200, `search must succeed, got ${result.status} ${JSON.stringify(result.body)}`);
      return (result.body.results ?? []).map((item) => item.path);
    };
    const defaultPaths = await search();
    assert.ok(defaultPaths.includes(kv2Path), `default search must return the current version, got ${JSON.stringify(defaultPaths)}`);
    assert.ok(!defaultPaths.includes(kvPath), `default search must hide the superseded version, got ${JSON.stringify(defaultPaths)}`);
    const withSuperseded = await search({ include_superseded: true });
    assert.ok(withSuperseded.includes(kv2Path), `include_superseded search must still return the current version, got ${JSON.stringify(withSuperseded)}`);
    assert.ok(withSuperseded.includes(kvPath), `include_superseded search must reveal the superseded version, got ${JSON.stringify(withSuperseded)}`);

    // ⑥' 冲突**可见性**的证据链：检索只回答"命中哪个文件"（检索结果项的既有形状是
    // {path,line,excerpt,lanes} —— 不带 frontmatter，本单不改检索），而"这条命中是不是
    // 已被取代的旧版本"由**该路径上的那份记忆自己**回答。两版逐字段在这里钉死：
    //   status / stable_key / superseded_by / supersedes —— 缺任何一个，调用方都看不出"有冲突"。
    const versionOf = async (filePath) => {
      const frontmatter = parseFrontmatterTyped(await fs.readFile(filePath, "utf8")).frontmatter;
      return { status: frontmatter.status, stable_key: frontmatter.stable_key, superseded_by: frontmatter.superseded_by ?? null, supersedes: frontmatter.supersedes ?? [] };
    };
    assert.deepEqual(await versionOf(kv2Path), { status: "active", stable_key: STABLE_KEY, superseded_by: null, supersedes: ["ml1s4-kv-1"] }, "the search hit for the current version must carry the chain head metadata");
    assert.deepEqual(await versionOf(kvPath), { status: "superseded", stable_key: STABLE_KEY, superseded_by: "ml1s4-kv-2", supersedes: [] }, "the include_superseded hit for the old version must carry the retiring metadata");

    // ---------- ⑦ 点错 supersedes：不存在 / 不是当前 active / 跨作用域 ⇒ 409 且零写入 ----------
    const evidence4 = await capture("ml1s4-conv-4");
    const job4 = await claimedJob("ml1s4-conv-4");
    const expectBadSupersede = async (label, supersedes, expectedActiveId) => {
      const before = await formalMemoryFiles();
      const result = await submit(port, job4.job_id, [conclusionFor("ml1s4-kv-3", BODY_B, evidence4, { supersedes })]);
      assert.equal(result.status, 409, `${label}: expected 409, got ${result.status} ${JSON.stringify(result.body)}`);
      assert.notEqual(result.status, 500, `${label}: an expected rejection must never be 500`);
      assert.equal(result.body.error.code, "SUPERSEDE_TARGET_INVALID", `${label}: error code, got ${JSON.stringify(result.body.error)}`);
      assert.equal(result.body.error.conflicts[0].active_id, expectedActiveId, `${label}: the rejection must still name the real active memory, got ${JSON.stringify(result.body.error.conflicts)}`);
      assert.deepEqual(await formalMemoryFiles(), before, `${label}: a refused supersede must perform zero formal-memory writes`);
      const get3 = await post(port, "/v1/get", { id: "ml1s4-kv-3" });
      assert.equal(get3.status, 404, `${label}: the refused conclusion must not exist, got ${get3.status}`);
      return result;
    };
    // 字符串形式（单个旧 id）也被接受为输入形状 —— 这里点的是**不存在**的 id。
    await expectBadSupersede("nonexistent supersedes", "no-such-memory-id", "ml1s4-kv-2");
    // 点到了非 active 的旧版本（ml1s4-kv-1 已被取代）⇒ 仍然是"没点名当前 active"。
    await expectBadSupersede("non-active supersedes", ["ml1s4-kv-1"], "ml1s4-kv-2");

    // ---------- ⑧ 跨租户同 stable_key **不冲突**（各自一条 active 记忆） ----------
    const foreignEvidence = await capture("ml1s4-conv-foreign", FOREIGN);
    const foreignJob = await claimedJob("ml1s4-conv-foreign", FOREIGN);
    assert.equal(foreignJob.project, PROJECT, "the foreign job carries the same project (the conflict key must still differ by tenant)");
    const foreignResult = await submit(port, foreignJob.job_id, [conclusionFor("ml1s4-kv-foreign", BODY_B, foreignEvidence)], FOREIGN);
    assert.equal(foreignResult.status, 200, `a foreign-tenant stable key must not collide with ours, got ${foreignResult.status} ${JSON.stringify(foreignResult.body)}`);
    assert.equal(foreignResult.body.receipt.writes[0].created, true, `a foreign-tenant write must be a fresh create, got ${JSON.stringify(foreignResult.body.receipt.writes)}`);
    assert.equal(foreignResult.body.receipt.writes[0].id, "ml1s4-kv-foreign");
    const foreignPath = path.join(dataRoot, "curated", "shared", "ml1s4-kv-foreign.md");
    assert.equal(foreignResult.body.receipt.writes[0].path, foreignPath);
    const foreignOnDisk = parseFrontmatterTyped(await fs.readFile(foreignPath, "utf8"));
    assert.equal(foreignOnDisk.frontmatter.stable_key, STABLE_KEY, "the foreign memory carries the same stable_key");
    assert.equal(foreignOnDisk.frontmatter.group_id, "group-ml4-foreign", "the foreign memory belongs to the other tenant");
    // 我们那份 active 记忆完全没被跨租户写入影响。
    const oursAfterForeign = parseFrontmatterTyped(await fs.readFile(kv2Path, "utf8"));
    assert.equal(oursAfterForeign.frontmatter.status, "active");
    assert.deepEqual(oursAfterForeign.frontmatter.evidence_refs, [evidence3], "a foreign-tenant write must not touch our memory");
    const filesAfterForeign = await formalMemoryFiles();
    assert.deepEqual(filesAfterForeign, [relOf(kvPath), relOf(kv2Path), relOf(foreignPath)], `three files after the foreign write, got ${JSON.stringify(filesAfterForeign)}`);

    // 跨作用域的 supersedes（点名另一个租户的 active 记忆）⇒ 409 且零写入。
    await expectBadSupersede("cross-tenant supersedes", ["ml1s4-kv-foreign"], "ml1s4-kv-2");

    // ---------- ⑨ 同 stable_key 跨 project **不冲突**（项目轴作用域） ----------
    const pdEvidence1 = await capture("ml1s4-conv-p1", OWNER, WORKSPACE);
    const pdJob1 = await claimedJob("ml1s4-conv-p1");
    const projectConclusion = (id, body, evidenceId) => ({
      layer: "project-decision",
      id,
      body,
      evidence_refs: [evidenceId],
      stable_key: PROJECT_KEY,
    });
    const pdFirst = await submit(port, pdJob1.job_id, [projectConclusion("ml1s4-pd-p1", `${MARKER} 项目一号的决策正文。`, pdEvidence1)]);
    assert.equal(pdFirst.status, 200, `project-decision write in project 1, got ${pdFirst.status} ${JSON.stringify(pdFirst.body)}`);
    assert.equal(pdFirst.body.receipt.writes[0].created, true);
    assert.equal(pdFirst.body.receipt.writes[0].path, path.join(dataRoot, "project-state", PROJECT, "decisions", "ml1s4-pd-p1.md"));

    const pdEvidence2 = await capture("ml1s4-conv-p2", OWNER, WORKSPACE2);
    const pdJob2 = await claimedJob("ml1s4-conv-p2");
    assert.notEqual(pdJob2.project, PROJECT, "the second job must belong to a different project");
    assert.equal(pdJob2.project, PROJECT2);
    const pdSecond = await submit(port, pdJob2.job_id, [projectConclusion("ml1s4-pd-p2", `${MARKER} 项目二号的决策正文（与一号不同）。`, pdEvidence2)]);
    assert.equal(pdSecond.status, 200, `the same stable_key in another project must not collide, got ${pdSecond.status} ${JSON.stringify(pdSecond.body)}`);
    assert.equal(pdSecond.body.receipt.writes[0].created, true, `the other-project write must be a fresh create, got ${JSON.stringify(pdSecond.body.receipt.writes)}`);
    assert.equal(pdSecond.body.receipt.writes[0].path, path.join(dataRoot, "project-state", PROJECT2, "decisions", "ml1s4-pd-p2.md"));

    // ---------- ⑩ project-state 层：一条项目一份 current-state.md ⇒ 冲突取代必须被明确拒绝（不静默覆盖） ----------
    const psEvidence1 = await capture("ml1s4-conv-ps1");
    const psJob1 = await claimedJob("ml1s4-conv-ps1");
    assert.equal(psJob1.target_layer, "project-state", "the default target layer for a workspace job is project-state");
    const psConclusion = (id, body, evidenceId, extra = {}) => ({
      layer: "project-state",
      project: PROJECT,
      id,
      body,
      evidence_refs: [evidenceId],
      stable_key: "memory-loop-1-slice4-project-state-key",
      ...extra,
    });
    const psFirst = await submit(port, psJob1.job_id, [psConclusion("ml1s4-ps-1", `${MARKER} 项目现状第一版。`, psEvidence1)]);
    assert.equal(psFirst.status, 200, `a project-state stable-key write must still work, got ${psFirst.status} ${JSON.stringify(psFirst.body)}`);
    const currentStatePath = path.join(dataRoot, "project-state", PROJECT, "current-state.md");
    assert.equal(psFirst.body.receipt.writes[0].path, currentStatePath);
    const psEvidence2 = await capture("ml1s4-conv-ps2");
    const psJob2 = await claimedJob("ml1s4-conv-ps2");
    const filesBeforePsConflict = await formalMemoryFiles();
    const psConflict = await submit(port, psJob2.job_id, [psConclusion("ml1s4-ps-2", `${MARKER} 项目现状第二版（冲突）。`, psEvidence2, { supersedes: ["ml1s4-ps-1"] })]);
    assert.equal(psConflict.status, 409, `a same-file supersede must be refused, got ${psConflict.status} ${JSON.stringify(psConflict.body)}`);
    assert.equal(psConflict.body.error.code, "SUPERSEDE_UNSUPPORTED_LAYER", `error code, got ${JSON.stringify(psConflict.body.error)}`);
    assert.deepEqual(await formalMemoryFiles(), filesBeforePsConflict, "a refused same-file supersede must perform zero formal-memory writes");
    const currentStateAfter = parseFrontmatterTyped(await fs.readFile(currentStatePath, "utf8"));
    assert.equal(currentStateAfter.frontmatter.id, "ml1s4-ps-1", "the project-state file must keep the first version untouched");
    assert.equal(currentStateAfter.frontmatter.status, "active", "the project-state file must stay active (nothing was corrupted)");
    assert.equal(currentStateAfter.body.trim(), `${MARKER} 项目现状第一版。`.trim(), "the project-state body must be intact");
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
