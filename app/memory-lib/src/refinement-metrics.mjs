// MEMORY-LOOP-1（第三垂直切片）—— 完成度度量：一张"证据 → 正式记忆"的问责日报。
//
// 单子要的不是又一个内部函数，而是一张**能直接贴进日报**的表：
//   今天捕获了几段对话？其中几段产生了提炼待办？几段完成了？几段超时？几段"无 durable 结论"？
//   还有多少 job 无人认领？
// 这四个问题各自有不同的"分母"，也有各自最容易算错的地方，所以口径在这里一次写死：
//
//   ① **日期口径是本地日历日的半开区间** `[当日本地 00:00, 次日本地 00:00)`，不是滚动 24 小时。
//      "某一天的报表"必须可重放：同一个 day + timezone 永远得到同一个窗口（边界由 date-query 的
//      时区投影算出，不靠固定 86400000）。捕获时刻一律比 `capturedAt` 这个**瞬时**，
//      不拿证据自己落的 `calendarDate` 比 —— 那个字段是**捕获当时**的部署时区算出来的，
//      而报表的 timezone 是调用方现在指定的，两者可以不同。
//   ② **"段"以 conversation 为单位**：同一段对话落多条证据（重试、分片、续写）只算一段，
//      否则"几段对话"会被自己的重试放大。conversationId 优先，缺省退回证据 id。
//      ⚠️ 一段对话可以有多张待办（一条证据一张）：这在语义上**合法**，不是"重复异常"。
//      所以按"段"计的指标一律去重，按"张"计的指标照实计数，两者分开报（见 counts 的两组字段）。
//   ③ **超时是相对 as_of 判定的**：`deadline < as_of` 且状态是 pending/claimed。
//      as_of 由注入的时钟给出（部署的真实时钟，测试里固定），**不看**窗口右端 ——
//      "这一天里超时的"与"报表生成时超时的"是同一件事，因为窗口右端通常就是"现在"。
//   ④ **无人认领与超时是两个问题**：无人认领 = 此刻仍 pending 的待办，**不限捕获日**
//      （昨天挂着没做的活，今天照样要问责）；同时给出只看本日捕获的 `unclaimed_jobs_day`。
//
// 作用域（default deny）：只算 `group_id` + `user_id` 与认证主体严格相等的东西；缺一即**什么都不算**
// （不做通配、不给 admin 旁路、也不把 "unknown" 当成一个真实租户）。这与 refinement-jobs.mjs 的
// 读写口径是同一把尺子 —— 度量不许变成一条能看见别人工作量的旁路。
//
// 平台零模型：这里一次模型调用都没有，全部是文件扫描 + 计数。
import fs from "node:fs/promises";
import path from "node:path";
import { readTextFile, walkFiles } from "./read-only-core.mjs";
import { parseFrontmatterTyped } from "./frontmatter-util.mjs";
import { calendarFields } from "./conversation-memory.mjs";
import { normalizeTimezone, resolveDateText } from "./date-query.mjs";

const EVIDENCE_DIRS = ["evidence", "conversations"];
const JOB_DIR = "refinement-jobs";
const JOB_FILE_RE = /^job-[0-9a-f]{24}\.json$/u;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;
// 还"开着"的状态：只有这两种可能超时。completed 是终态，needs_review / failed 可重提但不算开着
// —— 它们各自单独计数，好让 `completed + open + needs_review + failed == jobs_in_day` 这条不变式成立。
const OPEN_STATES = Object.freeze(["pending", "claimed"]);

function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function isoDate(ms) { return new Date(ms).toISOString(); }
function asMs(value) { const parsed = Date.parse(String(value ?? "")); return Number.isFinite(parsed) ? parsed : null; }
function failure(status, code, message) { return { ok: false, error: { status, code, message } }; }
function ratioOf(numerator, denominator) { return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null; }

// 默认拒绝：作用域只由认证主体派生；"unknown" 与缺失等价（它不是一个租户）。
function scopeOf(principal) {
  const group = text(principal?.group_id);
  const user = text(principal?.user_id);
  return { group_id: group && group !== "unknown" ? group : null, user_id: user && user !== "unknown" ? user : null };
}

function inScope(identity, scope) {
  if (!scope.group_id || !scope.user_id) return false;
  return identity?.group_id === scope.group_id && identity?.user_id === scope.user_id;
}

// 待办 → "段"的键。与证据侧同一套规则：conversationId 优先，缺省退回证据 id，最后才是 job_id。
function jobKeyOf(job) {
  const evidenceIds = Array.isArray(job?.evidence_ids) ? job.evidence_ids : [];
  return text(job?.conversation_id) ?? evidenceIds.map((id) => text(id)).find(Boolean) ?? text(job?.job_id) ?? "";
}

export function createRefinementMetrics({ dataRoot, calendarTimezone = "UTC", now = () => Date.now() } = {}) {
  if (!dataRoot) throw new Error("refinement metrics require dataRoot");
  const evidenceRoot = path.join(dataRoot, ...EVIDENCE_DIRS);
  const jobsRoot = path.join(dataRoot, JOB_DIR);
  // 部署默认时区：请求不带 timezone 时用它（唯一兜底字面量与库其它地方的 "UTC" 一致）。
  const deploymentZone = text(calendarTimezone) ?? "UTC";

  async function readCaptures() {
    const records = [];
    for (const file of await walkFiles(evidenceRoot, [".md"])) {
      const raw = await readTextFile(file);
      if (!raw) continue;
      const { frontmatter } = parseFrontmatterTyped(raw);
      // capturedAt 优先；captured_at / occurred_at 是既有别名（与 refinement-observability 同序）。
      const capturedMs = asMs(frontmatter.capturedAt ?? frontmatter.captured_at ?? frontmatter.occurred_at);
      records.push({
        evidence_id: text(frontmatter.id) ?? path.basename(file, ".md"),
        conversation_id: text(frontmatter.conversationId) ?? text(frontmatter.conversation_id),
        captured_at: capturedMs === null ? null : isoDate(capturedMs),
        captured_ms: capturedMs,
        group_id: text(frontmatter.groupId) ?? text(frontmatter.group_id),
        user_id: text(frontmatter.userId) ?? text(frontmatter.user_id),
      });
    }
    return records;
  }

  async function readJobs() {
    const records = [];
    const names = (await fs.readdir(jobsRoot).catch(() => [])).filter((name) => JOB_FILE_RE.test(name));
    for (const name of names) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(jobsRoot, name), "utf8"));
        // 单张坏文件不拖垮整张报表：跳过它，其余照常统计（坏文件本身由 jobs/list 与体检暴露）。
        if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      } catch { /* skip */ }
    }
    return records;
  }

  /**
   * 出一张日报。`day` 缺省 = 注入时钟在该时区的本地日；`timezone` 缺省 = 部署默认时区。
   * 返回值要么是完整报表，要么是一条明确的错误（{ok:false,error:{status,code,message}}）。
   */
  async function report({ principal = null, day = null, timezone = null } = {}) {
    const scope = scopeOf(principal);
    // Windows 名走既有 CLDR 表翻译成 IANA（与 /v1/date/resolve 同一条归一化路径）。
    const zoneResult = normalizeTimezone(text(timezone) ?? deploymentZone);
    if (!zoneResult.ok) return failure(400, "BAD_REQUEST", zoneResult.message);
    const zone = zoneResult.timezone;

    const asOfMs = Number(now());
    if (!Number.isFinite(asOfMs)) throw new Error("refinement metrics require now() to return a finite epoch-millisecond value");
    const asOf = isoDate(asOfMs);

    const requestedDay = text(day);
    if (requestedDay !== null && !DAY_RE.test(requestedDay)) {
      return failure(400, "BAD_REQUEST", `day must be a calendar date (YYYY-MM-DD), got: ${requestedDay}`);
    }
    // 默认日取"注入时钟在该时区落在哪一天"，与窗口派生用的是同一对 (时钟, 时区)。
    const resolvedDay = requestedDay ?? calendarFields(asOf, zone).calendarDate;
    // 窗口边界交给 date-query 的时区投影：某些时区的本地午夜因偏移切换并不等于固定 24 小时。
    const resolved = resolveDateText({ text: resolvedDay, now: asOf, timezone: zone });
    if (!resolved.ok) return failure(400, "BAD_REQUEST", resolved.message);
    const sinceMs = asMs(resolved.range.since);
    const untilMs = asMs(resolved.range.untilExclusive);

    const captures = (await readCaptures()).filter((item) => inScope(item, scope));
    const windowed = captures.filter((item) => item.captured_ms !== null && item.captured_ms >= sinceMs && item.captured_ms < untilMs);

    // 一段对话一个条目：同一段的多条证据合并，捕获时刻取最早的那条（"这一段是哪天进来的"）。
    const conversations = new Map();
    const conversationOfEvidence = new Map();
    for (const item of windowed) {
      const key = item.conversation_id ?? item.evidence_id;
      const existing = conversations.get(key);
      if (!existing) {
        conversations.set(key, { conversation_id: key, captured_at: item.captured_at, captured_ms: item.captured_ms, evidence_ids: [item.evidence_id], job: null });
      } else {
        existing.evidence_ids.push(item.evidence_id);
        if (item.captured_ms < existing.captured_ms) { existing.captured_ms = item.captured_ms; existing.captured_at = item.captured_at; }
      }
      conversationOfEvidence.set(item.evidence_id, key);
    }

    const scopedJobs = (await readJobs()).filter((job) => inScope({ group_id: text(job?.principal?.group_id), user_id: text(job?.principal?.user_id) }, scope));

    // 把待办归到"本日捕获的那一段"上：先认 conversationId，再认证据 id（两者都是同一个键空间）。
    const dayJobs = [];
    for (const job of scopedJobs) {
      const declared = text(job.conversation_id);
      let key = declared && conversations.has(declared) ? declared : null;
      if (!key) {
        for (const evidenceId of Array.isArray(job.evidence_ids) ? job.evidence_ids : []) {
          const hit = conversationOfEvidence.get(text(evidenceId));
          if (hit) { key = hit; break; }
        }
      }
      if (!key) continue;
      const state = text(job.state) ?? "unknown";
      const deadlineMs = asMs(job.deadline);
      const createdMs = asMs(job.created_at);
      dayJobs.push({
        key,
        conversation_id: declared ?? key,
        job_id: text(job.job_id) ?? "",
        state,
        outcome: text(job?.receipt?.outcome),
        created_at: createdMs === null ? null : isoDate(createdMs),
        deadline: deadlineMs === null ? null : isoDate(deadlineMs),
        // "超时"只对**还开着**的待办成立：已完成的活不因为回看时间晚而被算成超时。
        overdue: OPEN_STATES.includes(state) && deadlineMs !== null && deadlineMs < asOfMs,
        unclaimed: state === "pending",
        created_ms: createdMs,
      });
    }
    dayJobs.sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0) || a.job_id.localeCompare(b.job_id));

    // 段 → 待办列表（**一对多**是合法的：一条证据一张待办，一段对话可以多条证据）。
    const dayJobKeys = new Set(dayJobs.map((job) => job.key));
    const jobsByConversation = new Map();
    for (const job of dayJobs) {
      const list = jobsByConversation.get(job.key) ?? [];
      list.push(job);
      jobsByConversation.set(job.key, list);
    }

    const distinctKeys = (list) => new Set(list.map((job) => job.key)).size;
    const completedJobs = dayJobs.filter((job) => job.state === "completed");
    const writtenJobs = dayJobs.filter((job) => job.state === "completed" && job.outcome === "written");
    const noFactJobs = dayJobs.filter((job) => job.state === "completed" && job.outcome === "no_durable_fact");
    const openJobs = dayJobs.filter((job) => OPEN_STATES.includes(job.state));
    const overdueJobs = openJobs.filter((job) => job.overdue);
    const needsReviewJobs = dayJobs.filter((job) => job.state === "needs_review");
    const failedJobs = dayJobs.filter((job) => job.state === "failed");
    const pendingDayJobs = dayJobs.filter((job) => job.state === "pending");

    // 全局口径（不限捕获日）：昨天挂着没做的活，今天照样要问责。
    const unclaimedAll = scopedJobs.filter((job) => text(job.state) === "pending");
    const overdueAll = scopedJobs.filter((job) => {
      const state = text(job.state);
      const deadlineMs = asMs(job.deadline);
      return OPEN_STATES.includes(state) && deadlineMs !== null && deadlineMs < asOfMs;
    });

    const conversationsInOrder = [...conversations.values()].sort((a, b) => a.captured_ms - b.captured_ms || a.conversation_id.localeCompare(b.conversation_id));
    const jobCountsPerConversation = conversationsInOrder.map((conversation) => (jobsByConversation.get(conversation.conversation_id) ?? []).length);

    const counts = {
      captured_conversations: conversations.size,
      captured_evidence_records: windowed.length,
      conversations_with_jobs: dayJobKeys.size,
      uncovered_conversations: conversations.size - dayJobKeys.size,
      jobs_in_day: dayJobs.length,
      completed_jobs: completedJobs.length,
      completed_conversations: distinctKeys(completedJobs),
      written_jobs: writtenJobs.length,
      written_conversations: distinctKeys(writtenJobs),
      no_durable_fact_jobs: noFactJobs.length,
      no_durable_fact_conversations: distinctKeys(noFactJobs),
      open_jobs: openJobs.length,
      overdue_open_jobs: overdueJobs.length,
      overdue_open_conversations: distinctKeys(overdueJobs),
      needs_review_jobs: needsReviewJobs.length,
      failed_jobs: failedJobs.length,
      unclaimed_jobs: unclaimedAll.length,
      unclaimed_conversations: new Set(unclaimedAll.map(jobKeyOf)).size,
      unclaimed_jobs_day: pendingDayJobs.length,
      overdue_open_jobs_all_days: overdueAll.length,
      // 一段对话最多几张待办 / 有几段是多张 —— 这不是"异常计数"，是**已知合法形态**的规模。
      max_jobs_per_conversation: jobCountsPerConversation.length ? Math.max(...jobCountsPerConversation) : 0,
      conversations_with_multiple_jobs: jobCountsPerConversation.filter((count) => count > 1).length,
    };

    // 覆盖：给**可以对着夹具逐项核对的具体值**（哪几段没有待办、哪几段有多张待办），
    // 而不是"用同一批计数再算一遍"的恒真布尔 —— 那种自检永远不会红，只会让人误以为验过了。
    // 一段对话有多张待办在这里**不是**缺口，也不是异常：它只被如实列出来。
    const coverage = {
      uncovered_conversation_ids: conversationsInOrder.filter((conversation) => !dayJobKeys.has(conversation.conversation_id)).map((conversation) => conversation.conversation_id),
      multi_job_conversation_ids: conversationsInOrder.filter((conversation) => (jobsByConversation.get(conversation.conversation_id) ?? []).length > 1).map((conversation) => conversation.conversation_id),
    };

    // 分母**显式**给出（"及格线在哪"是报表的一半）：所有"几段/几段"的分母都是本日捕获对话数。
    const rates = {
      job_coverage: { numerator: counts.conversations_with_jobs, denominator: counts.captured_conversations, value: ratioOf(counts.conversations_with_jobs, counts.captured_conversations) },
      completion: { numerator: counts.completed_conversations, denominator: counts.captured_conversations, value: ratioOf(counts.completed_conversations, counts.captured_conversations) },
      no_durable_fact: { numerator: counts.no_durable_fact_conversations, denominator: counts.captured_conversations, value: ratioOf(counts.no_durable_fact_conversations, counts.captured_conversations) },
      overdue_open: { numerator: counts.overdue_open_conversations, denominator: counts.captured_conversations, value: ratioOf(counts.overdue_open_conversations, counts.captured_conversations) },
    };

    const jobs = dayJobs.map((job) => ({
      job_id: job.job_id,
      conversation_id: job.conversation_id,
      state: job.state,
      outcome: job.outcome,
      created_at: job.created_at,
      deadline: job.deadline,
      overdue: job.overdue,
      unclaimed: job.unclaimed,
    }));

    const labelOf = (job) => {
      const parts = [job.state];
      if (job.outcome) parts.push(job.outcome);
      if (job.overdue) parts.push("超时");
      if (job.unclaimed) parts.push("无人认领");
      return parts.join(" / ");
    };
    const lines = [
      `# 提炼问责日报：${resolvedDay}（${zone}）`,
      "",
      `- 作用域：group_id=${scope.group_id ?? "未绑定"}，user_id=${scope.user_id ?? "未绑定"}`,
      `- 本地日：${resolvedDay}（${zone}）＝ UTC 半开区间 [${isoDate(sinceMs)}, ${isoDate(untilMs)})`,
      `- 统计截止 as_of：${asOf}（超时判据：deadline < as_of）`,
      "",
      "| 指标 | 数值 | 分母 |",
      "| --- | --- | --- |",
      `| 捕获对话（段） | ${counts.captured_conversations} | — |`,
      `| 产生提炼待办 | ${counts.conversations_with_jobs} | ${counts.captured_conversations} |`,
      `| 本日产生的待办（张） | ${counts.jobs_in_day} | — |`,
      `| 已完成 | ${counts.completed_conversations} | ${counts.captured_conversations} |`,
      `| 无 durable 结论 | ${counts.no_durable_fact_conversations} | ${counts.captured_conversations} |`,
      `| 超时未完成 | ${counts.overdue_open_conversations} | ${counts.captured_conversations} |`,
      `| 待办覆盖缺口 | ${counts.uncovered_conversations} | ${counts.captured_conversations} |`,
      `| 无人认领（全部 pending，不限捕获日） | ${counts.unclaimed_jobs} | — |`,
      `| 无人认领（本日捕获） | ${counts.unclaimed_jobs_day} | — |`,
      "",
      "明细（本日捕获的对话，按捕获时刻升序）：",
    ];
    for (const conversation of conversationsInOrder) {
      const conversationJobs = jobsByConversation.get(conversation.conversation_id) ?? [];
      if (!conversationJobs.length) { lines.push(`- ${conversation.captured_at} ${conversation.conversation_id}：未产生待办`); continue; }
      const suffix = conversationJobs.length > 1 ? `（本段 ${conversationJobs.length} 张待办）` : "";
      lines.push(`- ${conversation.captured_at} ${conversation.conversation_id}：${conversationJobs.map(labelOf).join("、")}${suffix}`);
    }

    return {
      ok: true,
      day: resolvedDay,
      timezone: zone,
      as_of: asOf,
      window: { since: isoDate(sinceMs), until_exclusive: isoDate(untilMs), local_date: resolvedDay, timezone: zone },
      scope: { group_id: scope.group_id, user_id: scope.user_id },
      counts,
      coverage,
      rates,
      jobs,
      report: `${lines.join("\n")}\n`,
    };
  }

  return { report, evidenceRoot, jobsRoot };
}
