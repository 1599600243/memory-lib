// MEMORY-LOOP-1（第三垂直切片）——"完成度度量"只读接口：POST /v1/refinement/jobs/metrics
//
// 为什么打在 HTTP 这一层：单子要的是一张**能直接贴进日报**的问责表
// （"今天捕获了几段对话？其中几段产生了待办？几段完成了？几段超时？几段无 durable 结论？
//  有多少 job 无人认领？"）。它是一个公开只读接口，不是一个内部函数。这个测试同时钉五件事：
//   ① 路由真存在、真受认证与 action 约束（认证通过但没有 search 的角色进不来）；
//   ② 数字与**手算的夹具表**逐项相等（不是把被测代码的算法再算一遍 —— 那是同义反复）；
//   ③ 作用域是 group_id + user_id 严格相等、缺身份即全零（不泄漏、也不吞并别人的量）；
//   ④ 日期口径是**本地日历日的半开区间**（不是滚动 24 小时）：跨本地午夜的捕获分属两天；
//   ⑤ 超时是"相对注入的 as_of"判定的（deadline < as_of），且"超时"与"无人认领"是两个不同的问题。
//
// 时间夹具（否则"某一天的报表"根本没法断言）：
//   - 捕获时刻：先用**真实** HTTP 捕获造出形状正确的证据与待办，再把 capturedAt / created_at /
//     deadline 改成夹具表里写死的时刻。文件的形状仍是生产写出来的那一份（没有第二套渲染代码）。
//   - "现在"：server 的 refinementNow 注入（通用时钟配置，不是测试专用接口）。
// 夹具刻意全部非空：空夹具区分不了"因为没内容所以是 0"和"因为没接线所以是 0"。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = { agent_id: "pilot-01", role_id: "researcher" };
// 另一个租户：用来造"真实存在但属于别人"的证据与待办（必须一条都不进报表）。
const OTHER_TENANT = { agent_id: "pilot-01", role_id: "pet-steward" };
// 认证通过但**没绑身份**（夹具里没有 group_id/user_id ⇒ principal 是 "unknown"）。
const UNBOUND = { agent_id: "pilot-01", role_id: "reader" };
// 认证通过但**没有 search** action（capture-ingest 只有 propose）⇒ 必须 403。
const NO_SEARCH = { agent_id: "pilot-01", role_id: "capture-ingest" };
const WORKSPACE = "D:/MemoryLib/app/memory-lib";
const PROJECT = "d-memorylib-app-memory-lib";

// ── 独立真值源：本测试自己规定的"那一天"、那一刻、以及那张作业表 ──────────────
const DAY = "2026-10-10";
const TZ = "Asia/Shanghai";
// 本地日 2026-10-10（Asia/Shanghai，UTC+8）＝ UTC 半开区间 [10-09T16:00Z, 10-10T16:00Z)
const WINDOW_SINCE = "2026-10-09T16:00:00.000Z";
const WINDOW_UNTIL = "2026-10-10T16:00:00.000Z";
// 报表的"现在"：取本地日结束的那一瞬间 —— 这一天已经过完，超时与否按它判。
const AS_OF = "2026-10-10T16:00:00.000Z";
// 待办时限策略（server 的通用配置 refinementJobDeadlineHours）：6h。
// 之所以不用默认的 24h：24h 时"当天捕获的待办"在当天结束前**不可能**超时，
// 一组夹具就分不出"已超时"与"还开着"两种状态。
const DEADLINE_HOURS = 6;

// 夹具表。finish 是本测试安排的终态：
//   written          领取 → 提交一条结论 ⇒ completed / written
//   no_durable_fact  领取 → 提交结构化零输出 ⇒ completed / no_durable_fact
//   claimed          只领取 ⇒ claimed（还开着）
//   pending          不动 ⇒ pending（无人认领）
//   none             不产生待办（partial 捕获）
//
// 两个 `two-jobs-*` 条目是**同一段对话的两条证据**（消息不同 ⇒ 证据不同 ⇒ 待办不同）。
// 一段对话多张待办是**合法**的（重试 / 分片 / 续写都长这样），所以这里同时钉住：
// 按"段"计的指标必须去重，按"张"计的指标必须照实计数，且多张待办不许被当成"重复异常"。
const TWO_JOBS_CONVERSATION = "ml1s3-conv-two-jobs";
const PLAN = [
  // 本地 00:00:00 整 —— 窗口**左端闭**的那一侧（差 1 毫秒就是前一天）。
  { key: "write", conversation: "ml1s3-conv-write", capturedAt: WINDOW_SINCE, finish: "written" },
  { key: "nofact", conversation: "ml1s3-conv-nofact", capturedAt: "2026-10-10T02:00:00.000Z", finish: "no_durable_fact" },
  { key: "overdue-claimed", conversation: "ml1s3-conv-overdue-claimed", capturedAt: "2026-10-10T04:00:00.000Z", finish: "claimed" },
  { key: "overdue-pending", conversation: "ml1s3-conv-overdue-pending", capturedAt: "2026-10-10T06:00:00.000Z", finish: "pending" },
  // 同一段对话的两张待办（同一会话、不同证据）：先写成功的，再零输出的。
  { key: "two-jobs-a", conversation: TWO_JOBS_CONVERSATION, capturedAt: "2026-10-10T08:00:00.000Z", finish: "written" },
  { key: "two-jobs-b", conversation: TWO_JOBS_CONVERSATION, capturedAt: "2026-10-10T08:00:30.000Z", finish: "no_durable_fact" },
  { key: "open-claimed", conversation: "ml1s3-conv-open-claimed", capturedAt: "2026-10-10T12:00:00.000Z", finish: "claimed" },
  // 本地 23:59:59 —— 窗口**右端开**的那一侧；而且是 partial（公开入口能触发的"没有待办"）。
  { key: "nojob", conversation: "ml1s3-conv-nojob", capturedAt: "2026-10-10T15:59:59.000Z", finish: "none", partial: true },
  // 本地 2026-10-09 23:59:59 —— 前一天，差 1 毫秒进窗口（它的待办是**全局未认领/超时**的一份）。
  { key: "day-before", conversation: "ml1s3-conv-day-before", capturedAt: "2026-10-09T15:59:59.000Z", finish: "pending" },
  // 本地 2026-10-11 00:00:00 —— 后一天，窗口右端恰好排除；同时是"默认日"报表里唯一的一段。
  { key: "day-after", conversation: "ml1s3-conv-day-after", capturedAt: WINDOW_UNTIL, finish: "pending" },
];
const FOREIGN = { key: "foreign", conversation: "ml1s3-conv-foreign", capturedAt: "2026-10-10T05:00:00.000Z" };

// 测试自己的本地日换算（独立于被测模块：用 Intl 直接算）。
const localDayIn = (iso, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const deadlineOf = (capturedAt) => new Date(Date.parse(capturedAt) + DEADLINE_HOURS * 60 * 60 * 1000).toISOString();

test("ML1 切片3：完成度度量报表按本地日+时区+as_of 出准确数字，且限本主体", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-metrics-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const pilot = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef).agents.find((item) => item.agent_id === "pilot-01");
  const roleOf = (roleId) => pilot.roles.find((item) => item.role_id === roleId);
  Object.assign(roleOf("researcher"), { group_id: "group-ml1", user_id: "user-ml1" });
  // 带 workspace 的捕获要求角色持有该项目的项目作用域（既有捕获路由的规则），精确授一个同名项目。
  roleOf("researcher").scopes = [...roleOf("researcher").scopes, { layer: "memory", visibility: "project", project: PROJECT }];
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
    // 部署默认时区：请求不带 timezone 时，报表就用它。
    calendarTimezone: TZ,
    // 通用配置（不是测试专用接口）：时限策略 + 时钟。
    refinementJobDeadlineHours: DEADLINE_HOURS,
    refinementNow: () => Date.parse(AS_OF),
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

  async function capture(port, { key, conversation, partial = false }, principal = OWNER) {
    const result = await post(port, "/v1/conversations/capture", {
      messages: [
        { role: "user", content: `夹具对话 ${key}（会话 ${conversation}）：这一段用来验证完成度度量报表的计数口径。` },
        { role: "assistant", content: `记下了：${key} 的捕获时刻与待办状态由测试写死，期望值手算。` },
      ],
      conversation_id: conversation,
      // 每一条夹具一个独立 event_id：同一会话的两条证据必须是**两条**证据记录。
      event_id: `${key}-event`,
      source: "ml1s3-metrics-test",
      workspace: WORKSPACE,
      ...(partial ? { partial: true } : {}),
    }, principal);
    assert.equal(result.status, 200, `capture must succeed for ${key}, got ${result.status} ${JSON.stringify(result.body)}`);
    assert.match(result.body.evidenceId, /^conversation-[0-9a-f]{24}$/u, `fixture evidence id shape, got ${result.body.evidenceId}`);
    return result.body.evidenceId;
  }

  // 把证据的捕获时刻挪到夹具表写死的时刻。**只改时间行**：文件其余部分（id/身份/正文）保持生产形态。
  async function reslotEvidence(evidenceId, capturedAt) {
    const file = path.join(dataRoot, "evidence", "conversations", `${evidenceId}.md`);
    const raw = await fs.readFile(file, "utf8");
    const rewritten = raw
      .replace(/^capturedAt: .*$/mu, `capturedAt: ${capturedAt}`)
      .replace(/^calendarDate: .*$/mu, `calendarDate: ${localDayIn(capturedAt, TZ)}`);
    assert.notEqual(rewritten, raw, `the fixture rewrite must hit the capturedAt line of ${evidenceId}`);
    assert.match(rewritten, new RegExp(`^capturedAt: ${capturedAt.replace(/\./gu, "\\.")}$`, "mu"), `capturedAt must be rewritten verbatim, got:\n${rewritten.slice(0, 400)}`);
    await fs.writeFile(file, rewritten, "utf8");
  }

  // 待办的 created_at / deadline 由捕获时刻派生 ⇒ 一起挪（deadline = created_at + 时限策略）。
  async function reslotJob(jobId, capturedAt) {
    const file = path.join(dataRoot, "refinement-jobs", `${jobId}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.created_at = capturedAt;
    record.deadline = deadlineOf(capturedAt);
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async function jobsOf(port, principal = OWNER) {
    const listed = await post(port, "/v1/refinement/jobs/list", { limit: 200 }, principal);
    assert.equal(listed.status, 200, `jobs list must be a real route, got ${listed.status}`);
    return listed.body.jobs;
  }

  try {
    const port = (await server.listen()).port;

    // ── 夹具：先走**真实**捕获入口，让证据与待办由生产代码写出来 ──────────────
    const evidenceByKey = new Map();
    for (const item of PLAN) evidenceByKey.set(item.key, await capture(port, item));
    const foreignEvidenceId = await capture(port, FOREIGN, OTHER_TENANT);
    assert.notEqual(foreignEvidenceId, PLAN.map((item) => evidenceByKey.get(item.key))[0], "the foreign evidence must be its own record");

    // 待办：owner 8 张（partial 的那段不产生待办；同一会话的两条证据各产生一张），另一租户 1 张。
    const ownerJobsBefore = await jobsOf(port);
    assert.equal(ownerJobsBefore.length, 9, `owner must start with 9 jobs (the partial capture opens none; one conversation has two), got ${JSON.stringify(ownerJobsBefore.map((item) => [item.conversation_id, item.evidence_ids[0]]))}`);
    assert.equal(ownerJobsBefore.some((item) => item.conversation_id === "ml1s3-conv-nojob"), false, "a partial capture must not open a job");
    // 待办按**它自己的证据 id** 归属（同一会话会有两张待办，用 conversation_id 索引会互相覆盖）。
    const jobByEvidence = new Map(ownerJobsBefore.map((item) => [item.evidence_ids[0], item]));
    for (const item of PLAN) {
      if (item.finish === "none") continue;
      assert.ok(jobByEvidence.get(evidenceByKey.get(item.key)), `every completed capture must have its own job, missing ${item.key}`);
    }
    const foreignJob = (await jobsOf(port, OTHER_TENANT))[0];
    assert.equal(foreignJob.conversation_id, FOREIGN.conversation, `the foreign job must exist, got ${JSON.stringify(foreignJob)}`);

    // ── 把时刻挪到夹具表写死的位置 ──────────────────────────────────────────
    for (const item of PLAN) await reslotEvidence(evidenceByKey.get(item.key), item.capturedAt);
    for (const item of PLAN) {
      const job = jobByEvidence.get(evidenceByKey.get(item.key));
      if (job) await reslotJob(job.job_id, item.capturedAt);
    }
    await reslotEvidence(foreignEvidenceId, FOREIGN.capturedAt);
    await reslotJob(foreignJob.job_id, FOREIGN.capturedAt);

    // ── 用**真实**入口走到各自的终态 ────────────────────────────────────────
    async function claimJob(key) {
      const job = jobByEvidence.get(evidenceByKey.get(key));
      const claimed = await post(port, "/v1/refinement/jobs/claim", { job_id: job.job_id });
      assert.equal(claimed.status, 200, `claim must succeed for ${key}, got ${claimed.status} ${JSON.stringify(claimed.body)}`);
      assert.equal(claimed.body.job.state, "claimed");
      return claimed.body.job;
    }

    for (const item of PLAN) {
      if (item.finish === "written") {
        const job = await claimJob(item.key);
        const submitted = await post(port, "/v1/refinement/jobs/submit", {
          job_id: job.job_id,
          conclusions: [{
            layer: job.target_layer,
            project: job.project,
            // 每一条结论一个独立 id：同一层（project-state = 一个项目一份 current-state.md）里
            // 后写的会覆盖前一条，用同一个 id 会让"两条结论"看不出区别。
            id: `ml1s3-conclusion-${item.key}`,
            body: "提炼结论：切片3 只做完成度度量，不改写入、检索与可见性。",
            evidence_refs: job.evidence_ids,
          }],
        });
        assert.equal(submitted.status, 200, `submit must succeed for ${item.key}, got ${submitted.status} ${JSON.stringify(submitted.body)}`);
        assert.equal(submitted.body.job.state, "completed");
        assert.equal(submitted.body.receipt.outcome, "written", `the written fixture must carry a written receipt, got ${JSON.stringify(submitted.body.receipt)}`);
      } else if (item.finish === "no_durable_fact") {
        const job = await claimJob(item.key);
        const submitted = await post(port, "/v1/refinement/jobs/submit", { job_id: job.job_id, no_durable_fact: { reason: "no_durable_fact", note: "这段只聊了天气" } });
        assert.equal(submitted.status, 200, `zero-output submit must succeed for ${item.key}, got ${submitted.status} ${JSON.stringify(submitted.body)}`);
        assert.equal(submitted.body.job.state, "completed");
        assert.equal(submitted.body.receipt.outcome, "no_durable_fact");
      } else if (item.finish === "claimed") {
        await claimJob(item.key);
      }
    }

    // ═══════ ① 报表本体：那一天、那个时区、那个 as_of 的精确数字 ═══════
    const report = await post(port, "/v1/refinement/jobs/metrics", { day: DAY, timezone: TZ });
    assert.equal(report.status, 200, `metrics must be a real route, got ${report.status} ${JSON.stringify(report.body)}`);
    assert.equal(report.body.ok, true);

    // 分母/口径必须显式写在响应里（"及格线在哪"是报表的一半）。
    assert.equal(report.body.day, DAY, `the report must echo the requested day, got ${report.body.day}`);
    assert.equal(report.body.timezone, TZ, `the report must echo the requested timezone, got ${report.body.timezone}`);
    assert.equal(report.body.as_of, AS_OF, `the report must state the as-of instant, got ${report.body.as_of}`);
    assert.deepEqual(report.body.window, { since: WINDOW_SINCE, until_exclusive: WINDOW_UNTIL, local_date: DAY, timezone: TZ }, `the window must be the local half-open day, got ${JSON.stringify(report.body.window)}`);
    assert.deepEqual(report.body.scope, { group_id: "group-ml1", user_id: "user-ml1" }, `scope must be the authenticated principal's, got ${JSON.stringify(report.body.scope)}`);

    // 手算的数字（夹具表在上面；跨本地午夜的两段被严格排除在外）。
    // 注意"段"与"张"是两个不同的分母：two-jobs 那一段有**两条证据、两张待办**，
    // 按段计的指标必须去重，按张计的指标必须照实计数 —— 一段对话多张待办是**合法**的。
    assert.deepEqual(report.body.counts, {
      captured_conversations: 7,          // write / nofact / overdue-claimed / overdue-pending / two-jobs / open-claimed / nojob
      captured_evidence_records: 8,       // two-jobs 那一段有两条证据，其余各一条
      conversations_with_jobs: 6,         // 除 partial 的那段以外都有待办
      uncovered_conversations: 1,         // 捕获了但没有待办 ⇒ 缺口
      jobs_in_day: 7,                     // 6 段有待办的对话 + two-jobs 的**第二**张
      completed_jobs: 4,                  // write + nofact + two-jobs 的两张
      completed_conversations: 3,         // write / nofact / two-jobs（按段去重）
      written_jobs: 2,                    // write + two-jobs-a
      written_conversations: 2,
      no_durable_fact_jobs: 2,            // nofact + two-jobs-b
      no_durable_fact_conversations: 2,
      open_jobs: 3,                       // claimed / claimed / pending
      overdue_open_jobs: 2,               // 04:00 与 06:00 那两张（deadline 10:00/12:00 < 16:00）
      overdue_open_conversations: 2,
      needs_review_jobs: 0,
      failed_jobs: 0,
      unclaimed_jobs: 3,                  // 全部 pending：本日 1 张 + 前一天 1 张 + 后一天 1 张
      unclaimed_conversations: 3,
      unclaimed_jobs_day: 1,              // 只看本日捕获：只有 overdue-pending 那张
      overdue_open_jobs_all_days: 3,      // 本日 2 张 + 前一天那张（deadline 21:59:59 < 16:00）
      max_jobs_per_conversation: 2,       // two-jobs 那一段
      conversations_with_multiple_jobs: 1,
    }, `the daily counts must match the hand-computed fixture table, got ${JSON.stringify(report.body.counts, null, 2)}`);

    // 覆盖：给的是**可对着夹具逐项核对的具体值**（是哪些段没有待办、哪些段有多张待办），
    // 不是"用同一批计数再算一遍"的恒真布尔（那种自检永远不会红）。
    assert.deepEqual(report.body.coverage, {
      uncovered_conversation_ids: ["ml1s3-conv-nojob"],
      multi_job_conversation_ids: [TWO_JOBS_CONVERSATION],
    }, `the coverage lists must name the exact fixture conversations, got ${JSON.stringify(report.body.coverage)}`);
    assert.deepEqual(report.body.rates, {
      job_coverage: { numerator: 6, denominator: 7, value: 0.8571 },
      completion: { numerator: 3, denominator: 7, value: 0.4286 },
      no_durable_fact: { numerator: 2, denominator: 7, value: 0.2857 },
      overdue_open: { numerator: 2, denominator: 7, value: 0.2857 },
    }, `the rates must use the stated denominators, got ${JSON.stringify(report.body.rates)}`);

    // 逐 job 的问责明细：状态 / 回执结果 / 是否超时（"超时"只对还开着的待办成立）。
    // 同一段对话可能有多张待办 ⇒ 先按会话分组，再对每组排序后比较（避免依赖 job_id 的排序）。
    const detailByConversation = new Map();
    for (const item of report.body.jobs) {
      const entry = [item.state, item.outcome, item.overdue, item.created_at, item.deadline];
      const list = detailByConversation.get(item.conversation_id) ?? [];
      list.push(entry);
      detailByConversation.set(item.conversation_id, list);
    }
    const sortedDetail = Object.fromEntries([...detailByConversation.entries()]
      .map(([conversation, rows]) => [conversation, rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))) ]));
    assert.deepEqual(sortedDetail, {
      "ml1s3-conv-write": [["completed", "written", false, WINDOW_SINCE, deadlineOf(WINDOW_SINCE)]],
      "ml1s3-conv-nofact": [["completed", "no_durable_fact", false, "2026-10-10T02:00:00.000Z", deadlineOf("2026-10-10T02:00:00.000Z")]],
      "ml1s3-conv-overdue-claimed": [["claimed", null, true, "2026-10-10T04:00:00.000Z", deadlineOf("2026-10-10T04:00:00.000Z")]],
      "ml1s3-conv-overdue-pending": [["pending", null, true, "2026-10-10T06:00:00.000Z", deadlineOf("2026-10-10T06:00:00.000Z")]],
      [TWO_JOBS_CONVERSATION]: [
        ["completed", "no_durable_fact", false, "2026-10-10T08:00:30.000Z", deadlineOf("2026-10-10T08:00:30.000Z")],
        ["completed", "written", false, "2026-10-10T08:00:00.000Z", deadlineOf("2026-10-10T08:00:00.000Z")],
      ],
      "ml1s3-conv-open-claimed": [["claimed", null, false, "2026-10-10T12:00:00.000Z", deadlineOf("2026-10-10T12:00:00.000Z")]],
    }, `the per-job detail must match the fixture table, got ${JSON.stringify(sortedDetail, null, 2)}`);
    assert.equal(report.body.jobs.length, 7, `every job of the day must be listed (a conversation may have more than one), got ${JSON.stringify(report.body.jobs.map((item) => item.conversation_id))}`);
    assert.deepEqual([...new Set(report.body.jobs.map((item) => item.conversation_id))], ["ml1s3-conv-write", "ml1s3-conv-nofact", "ml1s3-conv-overdue-claimed", "ml1s3-conv-overdue-pending", TWO_JOBS_CONVERSATION, "ml1s3-conv-open-claimed"], "the detail must be ordered by capture instant");

    // 可直接贴进日报的那份文本（逐字符相等：它是本切片的交付物，不是调试输出）。
    assert.equal(report.body.report, [
      "# 提炼问责日报：2026-10-10（Asia/Shanghai）",
      "",
      "- 作用域：group_id=group-ml1，user_id=user-ml1",
      `- 本地日：${DAY}（${TZ}）＝ UTC 半开区间 [${WINDOW_SINCE}, ${WINDOW_UNTIL})`,
      `- 统计截止 as_of：${AS_OF}（超时判据：deadline < as_of）`,
      "",
      "| 指标 | 数值 | 分母 |",
      "| --- | --- | --- |",
      "| 捕获对话（段） | 7 | — |",
      "| 产生提炼待办 | 6 | 7 |",
      "| 本日产生的待办（张） | 7 | — |",
      "| 已完成 | 3 | 7 |",
      "| 无 durable 结论 | 2 | 7 |",
      "| 超时未完成 | 2 | 7 |",
      "| 待办覆盖缺口 | 1 | 7 |",
      "| 无人认领（全部 pending，不限捕获日） | 3 | — |",
      "| 无人认领（本日捕获） | 1 | — |",
      "",
      "明细（本日捕获的对话，按捕获时刻升序）：",
      "- 2026-10-09T16:00:00.000Z ml1s3-conv-write：completed / written",
      "- 2026-10-10T02:00:00.000Z ml1s3-conv-nofact：completed / no_durable_fact",
      "- 2026-10-10T04:00:00.000Z ml1s3-conv-overdue-claimed：claimed / 超时",
      "- 2026-10-10T06:00:00.000Z ml1s3-conv-overdue-pending：pending / 超时 / 无人认领",
      "- 2026-10-10T08:00:00.000Z ml1s3-conv-two-jobs：completed / written、completed / no_durable_fact（本段 2 张待办）",
      "- 2026-10-10T12:00:00.000Z ml1s3-conv-open-claimed：claimed",
      "- 2026-10-10T15:59:59.000Z ml1s3-conv-nojob：未产生待办",
      "",
    ].join("\n"), `the pasteable report must match exactly, got:\n${report.body.report}`);

    // ═══════ ② 同一天换一个主体：别人的量一条都不许出现 ═══════
    const foreignReport = await post(port, "/v1/refinement/jobs/metrics", { day: DAY, timezone: TZ }, OTHER_TENANT);
    assert.equal(foreignReport.status, 200, `the other tenant must get its own report, got ${foreignReport.status} ${JSON.stringify(foreignReport.body)}`);
    assert.deepEqual(foreignReport.body.scope, { group_id: "group-ml2", user_id: "user-ml2" }, `scope must be the caller's own, got ${JSON.stringify(foreignReport.body.scope)}`);
    assert.deepEqual(foreignReport.body.counts, {
      captured_conversations: 1,
      captured_evidence_records: 1,
      conversations_with_jobs: 1,
      uncovered_conversations: 0,
      jobs_in_day: 1,
      completed_jobs: 0,
      completed_conversations: 0,
      written_jobs: 0,
      written_conversations: 0,
      no_durable_fact_jobs: 0,
      no_durable_fact_conversations: 0,
      open_jobs: 1,
      overdue_open_jobs: 1,
      overdue_open_conversations: 1,
      needs_review_jobs: 0,
      failed_jobs: 0,
      unclaimed_jobs: 1,
      unclaimed_conversations: 1,
      unclaimed_jobs_day: 1,
      overdue_open_jobs_all_days: 1,
      max_jobs_per_conversation: 1,
      conversations_with_multiple_jobs: 0,
    }, `the other tenant's report must be exactly its own single conversation, got ${JSON.stringify(foreignReport.body.counts, null, 2)}`);

    // ═══════ ③ 认证通过但没绑身份：报表照答，但一条都不许算进去 ═══════
    const unboundReport = await post(port, "/v1/refinement/jobs/metrics", { day: DAY, timezone: TZ }, UNBOUND);
    assert.equal(unboundReport.status, 200, `an identity-less caller may read a report, got ${unboundReport.status} ${JSON.stringify(unboundReport.body)}`);
    assert.deepEqual(unboundReport.body.scope, { group_id: null, user_id: null }, `an unbound principal must report an empty scope, got ${JSON.stringify(unboundReport.body.scope)}`);
    assert.equal(unboundReport.body.counts.captured_conversations, 0, "an identity-less caller must capture-match nothing");
    assert.equal(unboundReport.body.counts.conversations_with_jobs, 0, "an identity-less caller must job-match nothing");
    assert.equal(unboundReport.body.counts.unclaimed_jobs, 0, "an identity-less caller must not see unclaimed jobs");

    // ═══════ ④ 默认口径：不带 day/timezone ⇒ 部署时区 + 注入时钟的本地"今天" ═══════
    // 注入的 as_of 是 2026-10-10T16:00Z ⇒ Asia/Shanghai 的今天已是 2026-10-11，
    // 于是窗口 [10-10T16:00Z, 10-11T16:00Z) 里只剩"后一天"那一段（10-10T16:00:00Z 恰好落在左端）。
    const defaultReport = await post(port, "/v1/refinement/jobs/metrics", {});
    assert.equal(defaultReport.status, 200, `the defaults must produce a report, got ${defaultReport.status} ${JSON.stringify(defaultReport.body)}`);
    assert.equal(defaultReport.body.timezone, TZ, `the timezone must default to the deployment calendarTimezone, got ${defaultReport.body.timezone}`);
    assert.equal(defaultReport.body.day, "2026-10-11", `the day must default to the local day of the injected clock, got ${defaultReport.body.day}`);
    assert.deepEqual(defaultReport.body.window, { since: WINDOW_UNTIL, until_exclusive: "2026-10-11T16:00:00.000Z", local_date: "2026-10-11", timezone: TZ }, `the default window must be that local day, got ${JSON.stringify(defaultReport.body.window)}`);
    assert.equal(defaultReport.body.counts.captured_conversations, 1, `the default day must only contain the post-midnight capture, got ${JSON.stringify(defaultReport.body.counts)}`);
    assert.equal(defaultReport.body.counts.uncovered_conversations, 0);
    assert.equal(defaultReport.body.counts.overdue_open_jobs, 0, "a not-yet-due open job must not be reported as overdue");

    // ═══════ ⑤ 负向控制：读接口的两道闸（认证 / action）+ 输入校验 ═══════
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/refinement/jobs/metrics`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ day: DAY, timezone: TZ }) });
    assert.equal(anonymous.status, 401, `metrics without a credential must be 401, got ${anonymous.status}`);

    const noSearch = await post(port, "/v1/refinement/jobs/metrics", { day: DAY, timezone: TZ }, NO_SEARCH);
    assert.equal(noSearch.status, 403, `a role without the search action must be refused, got ${noSearch.status} ${JSON.stringify(noSearch.body)}`);
    assert.equal(noSearch.body.error.code, "FORBIDDEN");
    assert.equal(noSearch.body.error.detail, "ACTION_DENIED", `the refusal must name the action gate, got ${JSON.stringify(noSearch.body.error)}`);
    assert.equal(noSearch.body.counts, undefined, "a refused call must not leak any counts");

    const badDay = await post(port, "/v1/refinement/jobs/metrics", { day: "10/10", timezone: TZ });
    assert.equal(badDay.status, 400, `a non-ISO day must be refused, got ${badDay.status} ${JSON.stringify(badDay.body)}`);
    assert.equal(badDay.body.error.code, "BAD_REQUEST");

    const badZone = await post(port, "/v1/refinement/jobs/metrics", { day: DAY, timezone: "Not/AZone" });
    assert.equal(badZone.status, 400, `an unknown timezone must be refused, got ${badZone.status} ${JSON.stringify(badZone.body)}`);
    assert.equal(badZone.body.error.code, "BAD_REQUEST");
    assert.match(String(badZone.body.error.message), /time zone/u, `the refusal must name the timezone, got ${JSON.stringify(badZone.body.error)}`);

    // ═══════ ⑥ 幂等/只读：再问一次是同一份；且没有多出任何待办或正式记忆 ═══════
    const again = await post(port, "/v1/refinement/jobs/metrics", { day: DAY, timezone: TZ });
    assert.deepEqual(again.body, report.body, "asking twice must return the very same report");
    const finalJobs = await jobsOf(port);
    assert.equal(finalJobs.length, 9, `metrics must not create jobs, got ${finalJobs.length}`);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
