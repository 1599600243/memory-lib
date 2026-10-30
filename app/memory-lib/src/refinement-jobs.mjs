// MEMORY-LOOP-1（第一垂直切片）—— 提炼任务（refinement job）控制面。
//
// 平台零模型：这里一行模型代码都没有。"证据 → 正式记忆"的问责闭环里，确定性的一半恰好是
// 最缺的那一半 —— 每段证据落盘后，**必须有人为它负责**：谁、什么时候、到什么时候为止、
// 现在归谁。提炼本身由接入 agent 做（结论提交是下一片）。
//
// 深度（deep module）：调用方只需要记住四个动作
//   recordCapture(...)  证据落盘后登记一张待办（幂等；只有 partial 的捕获不登记）
//   list(...)           按认证主体列出自己的待办
//   get(...)            按 job_id 读一张待办（越界 = 不存在）
//   claim(...)          pending → claimed（独占；重复领取幂等）
// 幂等键、去重、租户作用域、状态机、原子落盘全部收在内部，调用方不需要知道文件长什么样。
//
// 落盘即真相：一张待办一个 JSON 文件，写在注入的 dataRoot 之下（走统一原子写助手）。
// 进程内存里**不留任何状态** —— 换一个服务实例读回的结果必须逐字段相同（HTTP 测试第 ⑤ 步钉住这点）。
//
// 作用域（default deny）：读/领取只匹配调用方自己的 group_id + user_id；缺失或 "unknown"
// 一律**匹配不到任何东西**（不做通配、不给 admin 旁路）。越界读/领一律按"不存在"处理，
// 免得 job_id 被当成一张能换资源的通行证。
//
// `suppressRefinement` 的语义（修复批次已澄清，单子红线："每当一段对话证据落盘 ⇒ 自动产生待办"）：
//   它只抑制**旧的巡检观测**（refinement-observability 的巡检报告，见 localhost-server 的 onCaptured），
//   **不**抑制待办 —— 一段完成（非 partial）的对话证据落盘，就必须有人为它的提炼负责，
//   不管这一段是从哪个入口进来的。这个参数仍然被接收（既有调用方零改动），但不再影响待办的产生。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "./atomic-write.mjs";
import { workspaceKey } from "./conversation-memory.mjs";
import { unquote } from "./frontmatter-util.mjs";
import { WRITE_LAYERS } from "./write-memory.mjs";

// 状态机的**全部**格（修复批次补全）：pending → claimed → completed / needs_review / failed。
// 旧值只有前两格 —— 导出给别人看的枚举少三格，调用方就会把"已完成 / 需复核 / 失败"当成未知状态。
export const REFINEMENT_JOB_STATES = Object.freeze(["pending", "claimed", "completed", "needs_review", "failed"]);
export const DEFAULT_JOB_DEADLINE_HOURS = 24;
export const REFINEMENT_JOB_TRIGGER = "conversation_capture";

const JOB_DIR = "refinement-jobs";
const JOB_ID_RE = /^job-[0-9a-f]{24}$/u;
const JOB_FILE_RE = /^job-[0-9a-f]{24}\.json$/u;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CONCLUSIONS = 20;
const MAX_BODY_CHARS = 20_000;
const MAX_TAGS = 20;

function sha(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24); }
function fullSha(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function isoDate(ms) { return new Date(ms).toISOString(); }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
// occurred_at 必须是可解析的时间：在**计划阶段**就判掉，别留到 writer 里才炸 ——
// 那会让"第 1 条已经写盘、第 2 条因时间字符串不合法抛错"变成一个本来可以避免的部分写入。
function isoInstant(value) { const parsed = new Date(String(value ?? "")); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(); }

// 公开错误信封：status 由本模块给出，路由只负责把它写成 HTTP 状态码。
// 为什么由模块给：作用域、证据可见性、状态机这三类拒绝的**正确状态码**是领域知识，
// 散在路由里早晚会漂移；这里集中一次，测试在 HTTP 层逐条钉死。
// extra 用来带**结构化**冲突信息（切片4：stable_key + active id），路由原样透传，不在这里拼字符串。
function failure(status, code, message, extra = {}) {
  return { ok: false, error: { status, code, message, ...extra } };
}

// 结论里允许出现的字段（其余一律拒绝：宁可让调用方改参数，也不许悄悄吞掉拼错的字段）。
const CONCLUSION_FIELDS = Object.freeze(["layer", "target_layer", "id", "body", "text", "content", "summary", "tags", "project", "evidence_refs", "occurred_at", "stable_key", "supersedes"]);
const MAX_STABLE_KEY_CHARS = 200;
// 切片4 的三种公开冲突码（都由本模块给出，路由按 status 原样回）：
//   SUPERSEDE_REQUIRED        同键已有一条 active 记忆、正文不同、调用方没点名它；
//   SUPERSEDE_TARGET_INVALID  supersedes 点错了（不存在 / 不是当前 active / 跨作用域 / 不止一个）；
//   SUPERSEDE_UNSUPPORTED_LAYER 该层物理上只保留一个文件（project-state），新旧两版无法共存。
export const SUPERSEDE_CONFLICT_CODES = Object.freeze(["SUPERSEDE_REQUIRED", "SUPERSEDE_TARGET_INVALID", "SUPERSEDE_UNSUPPORTED_LAYER"]);

// 正文等价判据（纯确定性，切片4 文档化）：行尾归一到 \n → 首尾 trim → 严格相等。
// 刻意不做模糊相似度、不做大小写折叠、不调模型：同样输入永远同样判定。
export function normalizeBodyForEquivalence(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function normalizeStableKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return null;
  if (key.length > MAX_STABLE_KEY_CHARS) return null;
  if (/[\0\r\n]/u.test(key)) return null;
  return key;
}
// 项目轴上的层：只有这几个层允许（也必须）带 project。
const PROJECT_LAYERS = Object.freeze(["project-state", "project-decision", "project-progress"]);
// 零输出的闭合原因枚举：不是自由文本 —— 自由文本会让"完成度度量"无从统计。
export const NO_DURABLE_FACT_REASONS = Object.freeze(["no_durable_fact", "already_covered", "out_of_scope", "insufficient_context", "duplicate"]);
// 终态：completed 是"写成功了"（回执即事实，不再重做）；needs_review / failed 是**没写成**，
// 领取者可以带着修正后的载荷重提 —— 否则一次瞬时的写入失败会把待办永久钉死。
export const REFINEMENT_JOB_TERMINAL_STATES = Object.freeze(["completed"]);

// 目标记忆层：平台此刻**唯一确定**的上下文是"这段证据属于哪个项目"。
// 有 workspace ⇒ 结论该落在 project-state（项目现状层）；没有 ⇒ 落在 curated-shared（共享长期层）。
// 这是推断性规则里最保守的一条：两个值都是写入侧真实存在的层（write-memory.mjs 的 WRITE_LAYERS），
// 所以提交结论的一方可以直接拿这个值去写；更精细的层（project-decision 等）留给下一片的提交入口。
function defaultTargetLayer(workspace) { return workspace ? "project-state" : "curated-shared"; }

// ---------------------------------------------------------------------------
// 证据兼容性（修复批次）：提交时**每一条**可读证据都要逐个检查内容。
//
// 旧实现只问 verifyEvidence(ref) 的布尔值 —— "当前主体读得到"就当成合格证据。可是证据本来就带着
// 两件与"这条结论该不该写进这个项目"直接相关的事实：它属于谁、它属于哪个 workspace。
// 于是出现两种本不该被接受的提交：同主体在**另一个项目**里的证据被用来写本项目的记忆；
// 没有 workspace 的证据被用来支撑项目层结论。两种都是"借一张待办写别处"。
//
// 判据（保守、可解释、可测）：
//   1. 必须是**对话证据记录**（type=conversation 或住在 evidence/ 下）——
//      否则任何一条可读记忆都能被当成"证据"；
//   2. 证据的身份（groupId/userId）必须与待办的 principal 严格相等；
//   3. 证据的 workspace 派生的 project 必须与待办的 project **相等**（null 与 null 相等）。
//      推论：没有 workspace 的证据只能支撑没有 workspace 的待办（比如 pet-command 自动捕获）；
//      有项目的待办只能被"同一个项目"的证据支撑 —— 包括非项目层结论（共享层也不行）。
//      这是"非项目目标"的保守定义：宁可拒绝，也不允许跨项目借证据。
export const EVIDENCE_INCOMPATIBLE = "EVIDENCE_INCOMPATIBLE";

function evidenceFrontmatter(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const candidates = [item.frontmatter, item.metadata, item];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function evidenceProjectOf(frontmatter) {
  const raw = unquote(String(frontmatter?.workspace ?? ""));
  if (!raw) return null;
  try { return workspaceKey(raw); } catch { return null; }
}

/**
 * 返回不相容的原因（字符串），相容返回 null。纯函数：不看磁盘、不看可见性（可见性由调用方
 * 走**请求作用域**的库实例确认，本模块不复制那套判据）。
 */
function evidenceIncompatibility({ evidence, job }) {
  const frontmatter = evidenceFrontmatter(evidence);
  if (!frontmatter) return "evidence_not_inspectable";
  const type = String(frontmatter.type ?? "").trim();
  const evidencePath = String(evidence?.path ?? "").replaceAll("\\", "/");
  if (type !== "conversation" && !evidencePath.includes("/evidence/")) return "not_a_conversation_evidence";
  const groupId = unquote(String(frontmatter.groupId ?? frontmatter.group_id ?? ""));
  const userId = unquote(String(frontmatter.userId ?? frontmatter.user_id ?? ""));
  if (groupId !== job.principal.group_id || userId !== job.principal.user_id) return "evidence_from_another_principal";
  if (evidenceProjectOf(frontmatter) !== (job.project ?? null)) return "evidence_project_mismatch";
  return null;
}

// 进程内串行化（修复批次）：stable_key 的"查同键 → 决定 write/merge/supersede → 落盘"必须是
// 一个不可分割的临界区。否则两个并发提交会在各自"查不到"之后各写一条 active 版本
// （同键同体也合并不上，因为两边的 merge 目标都还不存在）。
//
// 这是**单进程**保证：按 dataRoot 排队（本服务是一个进程、一个 jobs 实例）。跨进程 / 多实例
// 部署需要外部锁，本单不做，也不在这里假装做到了（刻意不断言分布式互斥）。
const stableKeyQueues = new Map();
function withStableKeyLock(dataRoot, run) {
  const key = String(dataRoot);
  const previous = stableKeyQueues.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  stableKeyQueues.set(key, current.then(() => {}, () => {}));
  return current;
}

// 身份快照：待办必须能回答"这段证据属于谁"。六个字段全部落盘，授权判据只用 group_id + user_id
// （与证据所有权 hasCaptureOwnership 同一把尺子）。
function principalSnapshot(principal, label) {
  if (!principal || typeof principal !== "object") throw new Error(`${label} requires an authenticated principal`);
  const groupId = text(principal.group_id);
  const userId = text(principal.user_id);
  if (!groupId || groupId === "unknown" || !userId || userId === "unknown") throw new Error(`${label} requires principal group_id and user_id`);
  return {
    tenant_id: text(principal.tenant_id) ?? "default",
    framework_id: text(principal.framework_id),
    group_id: groupId,
    user_id: userId,
    agent_id: text(principal.agent_id),
    role_id: text(principal.role_id),
  };
}

function scopeOf(principal) {
  const group = text(principal?.group_id);
  const user = text(principal?.user_id);
  return { group_id: group && group !== "unknown" ? group : null, user_id: user && user !== "unknown" ? user : null };
}

function inScope(record, scope) {
  if (!scope.group_id || !scope.user_id) return false;
  return record?.principal?.group_id === scope.group_id && record?.principal?.user_id === scope.user_id;
}

function sameIdentity(left, right) {
  return Boolean(left && right) && ["tenant_id", "framework_id", "group_id", "user_id", "agent_id", "role_id"].every((key) => (left[key] ?? null) === (right[key] ?? null));
}

export function createRefinementJobs({ dataRoot, deadlineHours = DEFAULT_JOB_DEADLINE_HOURS, now = () => Date.now() } = {}) {
  if (!dataRoot) throw new Error("refinement jobs require dataRoot");
  const jobsRoot = path.join(dataRoot, JOB_DIR);
  const deadlineMs = Math.max(1, Number(deadlineHours) || DEFAULT_JOB_DEADLINE_HOURS) * 60 * 60 * 1000;

  const jobPath = (jobId) => path.join(jobsRoot, `${jobId}.json`);

  async function readJob(jobId) {
    if (!JOB_ID_RE.test(String(jobId ?? ""))) return null;
    try { return JSON.parse(await fs.readFile(jobPath(jobId), "utf8")); } catch { return null; }
  }

  /**
   * 证据落盘后登记一张待办。同一条证据永远只有一张待办（job_id 由 evidenceId 派生 ⇒ 天然幂等，
   * 重复捕获不会长出第二张）。只有 **partial**（还没完成的那次捕获）不登记。
   *
   * `suppressRefinement` 仍然出现在签名里（既有调用方零改动），但它**不再**影响待办的产生：
   * 该开关只抑制旧的巡检观测。一段完成的对话证据落盘 ⇒ 必须有一张待办 —— 这是单子红线的
   * "每当一段对话证据落盘（capture 完成）自动产生一张可追踪的提炼待办"。
   */
  async function recordCapture({ evidenceId, conversationId = null, workspace = null, principal = null, capturedAt = null, partial = false, suppressRefinement = false } = {}) {
    const evidence = text(evidenceId);
    if (!evidence) throw new Error("refinement job requires evidenceId");
    if (partial === true) return null;
    // suppressRefinement 刻意**不**在这里短路：它的语义是"本轮不触发巡检观测"，不是"不要求提炼"。
    void suppressRefinement;
    const jobId = `job-${sha(evidence)}`;
    const existing = await readJob(jobId);
    if (existing) return { ...existing, duplicate: true };
    const capturedMs = Date.parse(String(capturedAt ?? ""));
    const createdAtMs = Number.isFinite(capturedMs) ? capturedMs : Number(now());
    const normalizedWorkspace = text(workspace);
    const record = {
      version: 1,
      job_id: jobId,
      conversation_id: text(conversationId),
      evidence_ids: [evidence],
      workspace: normalizedWorkspace,
      project: normalizedWorkspace ? workspaceKey(normalizedWorkspace) : null,
      principal: principalSnapshot(principal, "refinement job"),
      target_layer: defaultTargetLayer(normalizedWorkspace),
      trigger_reason: REFINEMENT_JOB_TRIGGER,
      created_at: isoDate(createdAtMs),
      deadline: isoDate(createdAtMs + deadlineMs),
      state: "pending",
      claimed_by: null,
      claimed_at: null,
    };
    await atomicWriteJson(jobPath(jobId), record);
    return { ...record, duplicate: false };
  }

  async function list({ principal = null, state = null, limit = DEFAULT_LIMIT } = {}) {
    const scope = scopeOf(principal);
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const records = [];
    const names = (await fs.readdir(jobsRoot).catch(() => [])).filter((name) => JOB_FILE_RE.test(name));
    for (const name of names) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(jobsRoot, name), "utf8"));
        if (!inScope(record, scope)) continue;
        if (state && record.state !== state) continue;
        records.push(record);
      } catch { /* 单张坏文件不拖垮整个列表：跳过它，其余照常返回 */ }
    }
    records.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || String(a.job_id).localeCompare(String(b.job_id)));
    return { scope, count: Math.min(records.length, safeLimit), total_count: records.length, jobs: records.slice(0, safeLimit) };
  }

  async function get({ job_id = null, principal = null } = {}) {
    const record = await readJob(job_id);
    return record && inScope(record, scopeOf(principal)) ? record : null;
  }

  async function claim({ job_id = null, principal = null } = {}) {
    const record = await get({ job_id, principal });
    if (!record) return { ok: false, reason: "NOT_FOUND", job: null };
    const claimant = principalSnapshot(principal, "refinement job claim");
    if (record.state === "claimed") {
      return sameIdentity(record.claimed_by, claimant)
        ? { ok: true, already_claimed: true, job: record }
        : { ok: false, reason: "ALREADY_CLAIMED", job: record };
    }
    if (record.state !== "pending") return { ok: false, reason: "NOT_CLAIMABLE", job: record };
    const claimed = { ...record, state: "claimed", claimed_by: claimant, claimed_at: isoDate(Number(now())) };
    await atomicWriteJson(jobPath(record.job_id), claimed);
    return { ok: true, already_claimed: false, job: claimed };
  }

  /**
   * 计划提交（纯函数，不碰磁盘、不碰 writer）：把两种互斥形态先变成"要么可写、要么一条明确错误"。
   * 这一步之所以必要：所有**整包校验**必须先跑完再落盘，否则"第 1 条结论写成功了、第 2 条证据越权"
   * 就会留下半截正式记忆 —— 那是比拒绝更糟的结果。
   */
  function planSubmission({ record, body, principal }) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "BAD_REQUEST", "submission body must be a JSON object");
    const claimant = principalSnapshot(principal, "refinement job submit");
    if (!sameIdentity(record.claimed_by, claimant)) return failure(403, "NOT_CLAIMANT", "only the claimant of this refinement job may submit its conclusions");

    // 形态互斥：conclusions 与 no_durable_fact 必须**恰好**给一个。
    const hasConclusions = body.conclusions !== undefined;
    const hasNoDurableFact = body.no_durable_fact !== undefined;
    if (hasConclusions === hasNoDurableFact) {
      return failure(400, "BAD_REQUEST", "submit exactly one of conclusions or no_durable_fact");
    }
    const payloadHash = fullSha(hasNoDurableFact ? { no_durable_fact: body.no_durable_fact } : { conclusions: body.conclusions });

    if (hasNoDurableFact) {
      const fact = body.no_durable_fact;
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) return failure(400, "BAD_REQUEST", "no_durable_fact must be an object");
      const reason = text(fact.reason);
      if (!reason || !NO_DURABLE_FACT_REASONS.includes(reason)) {
        return failure(400, "BAD_REQUEST", `no_durable_fact.reason must be one of: ${NO_DURABLE_FACT_REASONS.join(", ")}`);
      }
      return { ok: true, payloadHash, noDurableFact: { reason, note: text(fact.note) } };
    }

    if (!Array.isArray(body.conclusions) || body.conclusions.length === 0) return failure(400, "BAD_REQUEST", "conclusions must be a non-empty array");
    if (body.conclusions.length > MAX_CONCLUSIONS) return failure(400, "BAD_REQUEST", `conclusions must not exceed ${MAX_CONCLUSIONS} items`);
    const planned = [];
    for (let index = 0; index < body.conclusions.length; index += 1) {
      const raw = body.conclusions[index];
      const label = `conclusions[${index}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure(400, "BAD_REQUEST", `${label} must be an object`);
      const unknown = Object.keys(raw).filter((key) => !CONCLUSION_FIELDS.includes(key));
      if (unknown.length) return failure(400, "BAD_REQUEST", `${label} has unsupported fields: ${unknown.join(", ")}`);
      const bodyText = text(raw.body) ?? text(raw.text) ?? text(raw.content) ?? text(raw.summary);
      if (!bodyText) return failure(400, "BAD_REQUEST", `${label} requires a non-empty body`);
      if (bodyText.length > MAX_BODY_CHARS) return failure(400, "BAD_REQUEST", `${label}.body must not exceed ${MAX_BODY_CHARS} characters`);
      // 「每条结论必须有非空 evidence_refs」：这里是**形状**校验；"存在 + 可读"由调用方逐个 ref 走库校验。
      const refs = raw.evidence_refs;
      if (!Array.isArray(refs) || refs.length === 0) return failure(400, "BAD_REQUEST", `${label}.evidence_refs must be a non-empty array`);
      const evidenceRefs = [...new Set(refs.map((ref) => text(ref)).filter(Boolean))];
      if (evidenceRefs.length !== refs.length || evidenceRefs.length === 0) return failure(400, "BAD_REQUEST", `${label}.evidence_refs must be non-empty strings`);
      // 目标层：结论可以显式声明（target_layer 是 layer 的别名），缺省继承待办的 target_layer。
      const declaredLayer = text(raw.target_layer) ?? text(raw.layer);
      const layer = declaredLayer ?? record.target_layer;
      if (!WRITE_LAYERS.includes(layer)) return failure(400, "BAD_REQUEST", `${label}.layer must be one of: ${WRITE_LAYERS.join(", ")}`);
      // 项目轴的规则（本次唯一一处"兼容性"判断）：
      //   结论**声明了** project ⇒ 必须等于待办的 project，且待办必须有 workspace（否则没有可依据的项目）；
      //   结论落在**项目层** ⇒ 项目只能来自待办（结论自报的项目一律按上面那条比）；
      //   两条都指向同一件事：不许借一张待办把记忆写进另一个项目的根目录。
      const declaredProject = text(raw.project);
      if (declaredProject && (!record.project || declaredProject !== record.project)) {
        return failure(400, "PROJECT_MISMATCH", `${label}.project must equal the refinement job project${record.project ? "" : "; this job has no workspace, so no project may be declared"}`);
      }
      const projectLayer = PROJECT_LAYERS.includes(layer);
      if (projectLayer && !record.project) return failure(400, "PROJECT_MISMATCH", `${label}.layer "${layer}" requires the refinement job to carry a workspace`);
      const tags = raw.tags === undefined ? [] : raw.tags;
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return failure(400, "BAD_REQUEST", `${label}.tags must be a string array`);
      const occurredAt = text(raw.occurred_at);
      if (occurredAt && !isoInstant(occurredAt)) return failure(400, "BAD_REQUEST", `${label}.occurred_at must be a valid ISO instant`);
      // 切片4：stable_key / supersedes 的**形状**校验也在计划阶段做完（写前一次性判掉）。
      // stable_key 可以不给（= 不做同键判定，行为与切片2/3 完全一致）；给了就必须是非空字符串。
      let stableKey = null;
      if (raw.stable_key !== undefined) {
        stableKey = normalizeStableKey(raw.stable_key);
        if (!stableKey) return failure(400, "BAD_REQUEST", `${label}.stable_key must be a non-empty string of at most ${MAX_STABLE_KEY_CHARS} characters`);
      }
      // supersedes 的既有写入口径是**旧 id 列表**；这里同时接受"单个旧 id 字符串"和长度恰为 1 的数组。
      // 本切片只允许点名一条（同键冲突只有一个对手），多给一律拒绝 —— 免得调用方以为还能连环取代。
      let supersedes = null;
      if (raw.supersedes !== undefined) {
        const rawSupersedes = typeof raw.supersedes === "string" ? [raw.supersedes] : raw.supersedes;
        if (!Array.isArray(rawSupersedes) || rawSupersedes.length !== 1) return failure(400, "BAD_REQUEST", `${label}.supersedes must be a single memory id (a string or a one-item array)`);
        supersedes = text(rawSupersedes[0]);
        if (!supersedes) return failure(400, "BAD_REQUEST", `${label}.supersedes must be a non-empty memory id`);
        if (!stableKey) return failure(400, "BAD_REQUEST", `${label}.supersedes requires ${label}.stable_key`);
      }
      if (stableKey && layer === "project-progress") return failure(400, "BAD_REQUEST", `${label}.stable_key is not supported for layer "project-progress"`);
      const id = text(raw.id) ?? `refined-${sha(`${record.job_id}:${index}:${bodyText}`)}`;
      planned.push({
        index,
        id,
        layer,
        stable_key: stableKey,
        supersedes,
        // 正文等价判据要用**发出去的那份**（不做 writer 的 cleanBody），这里留原始 trim 值。
        candidateBody: bodyText,
        evidence_refs: evidenceRefs,
        project: projectLayer ? record.project : null,
        writeInput: {
          layer,
          id,
          body: bodyText,
          tags: tags.map((tag) => tag.trim()).filter(Boolean).slice(0, MAX_TAGS),
          evidence_refs: evidenceRefs,
          ...(projectLayer ? { project: record.project } : {}),
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
          ...(stableKey ? { stable_key: stableKey } : {}),
          principal,
        },
      });
    }
    return { ok: true, payloadHash, planned };
  }

  /**
   * 领取者提交结论。三种结局：
   *   completed    全部结论写完（或合法零输出：no_durable_fact）；
   *   needs_review 部分结论写失败（已经写在盘上的**不回滚** —— 见下方"部分写入"注释），
   *                或同键冲突且调用方没有点名要取代的 active 记忆（切片4：可重试）；
   *   failed       一条都没写成功。
   * 整包校验失败（形状 / 证据不可读 / 项目不兼容 / 非领取者 / 同键冲突）在这里**一条都不写**，直接返回错误。
   * needs_review / failed 不是终点：领取者可以带修正后的载荷重提（否则一次瞬时写失败就是永久死结）。
   */
  async function submit({ job_id = null, body = null, principal = null, assertion = null, verifyEvidence = null, writeMemory = null, findActiveMemory = null, readableMemory = null, mergeMemory = null, supersedeMemory = null, targetPathOf = null, now: nowFn = now } = {}) {
    const record = await get({ job_id, principal });
    if (!record) return failure(404, "NOT_FOUND", "refinement job not found");
    const plan = planSubmission({ record, body, principal });
    if (!plan.ok) return plan;
    // 幂等：已经**写成**的待办 + 同一份载荷再提交一次 ⇒ 返回原回执（不重复写、不再计时）。
    // 状态必须是 claimed（或 needs_review / failed 的重提），否则这张待办还没被领取。
    if (REFINEMENT_JOB_TERMINAL_STATES.includes(record.state)) {
      if (record.payload_hash === plan.payloadHash && record.receipt) return { ok: true, idempotent: true, job: record, receipt: record.receipt };
      return failure(409, "CONFLICT", `refinement job is already ${record.state} with a different submission`);
    }
    if (record.state !== "claimed" && record.state !== "needs_review" && record.state !== "failed") {
      return failure(409, "CONFLICT", `refinement job must be claimed before submitting (state: ${record.state})`);
    }

    const completedAt = () => isoDate(Number(nowFn()));

    // --- 合法零输出：零正式写入，但**有**持久回执（"我确实做了判断"本身要留痕）。 ---
    // 修复批次：这条路径**不要求任何写作用域**（旧实现连零输出也要 project 作用域，于是没有 workspace
    // 的待办连"我判断了，没有 durable 结论"都提交不了 —— 那是把问责闭环堵死在自己的度量口径上）。
    // 需要的作用域只剩"能提交"（路由侧的 propose + 本模块的领取者）——两者都已经在更早的关卡里判过了。
    if (plan.noDurableFact) {
      const receipt = { outcome: "no_durable_fact", reason: plan.noDurableFact.reason, note: plan.noDurableFact.note, writes: [], completed_at: completedAt() };
      return commit({ record, state: "completed", receipt, payloadHash: plan.payloadHash, outcome: "no_durable_fact", note: plan.noDurableFact.reason });
    }

    if (typeof assertion !== "function" || typeof verifyEvidence !== "function" || typeof writeMemory !== "function") {
      throw new Error("refinement job submit requires assertion, verifyEvidence and writeMemory collaborators");
    }
    // 写授权：由调用方按**每条结论最终会写成什么**去判（见 localhost-server 的
    // conclusionWriteTarget / conclusionWriteDenial：先用 write-memory 的默认可见性算出
    // container + visibility，再套 /v1/write 对那个可见性的既有规则）。
    // 旧实现不管结论落在哪一层都只要 project 作用域，于是"没有 workspace 的待办"一条共享层结论
    // 都写不出去；后来的修复又按层名猜了一个 visibility（比写入口更严/更松各一处），本次按写入口
    // 的实际口径收敛。
    assertion({ record, planned: plan.planned });

    // --- 逐个证据 ref 的确定校验（修复批次：不再只看布尔值）：
    //     ① 存在 + 当前主体可读 —— 由调用方走**请求作用域**的库实例（lib.get），
    //        所以这里既不复制也不改可见性规则；缺失与越权回同一个错误，不把 id 变成探测器；
    //     ② 兼容性 —— 把**库返回的那一条**交给 evidenceIncompatibility 逐条检查
    //        （是不是对话证据、属于谁、属于哪个 workspace/项目）。 ---
    for (const item of plan.planned) {
      for (const evidenceId of item.evidence_refs) {
        const evidence = await verifyEvidence(evidenceId);
        if (!evidence) return failure(404, "EVIDENCE_NOT_FOUND", `conclusions[${item.index}].evidence_refs contains an evidence id that does not exist or is not readable`);
        const reason = evidenceIncompatibility({ evidence, job: record });
        if (reason) {
          return failure(400, EVIDENCE_INCOMPATIBLE, `conclusions[${item.index}].evidence_refs contains evidence that cannot support this conclusion (${reason})`);
        }
      }
    }

    // --- 从这里开始是**写入临界区**：同键查找 + 三种动作 + 落盘 + 提交回执必须原子地串行，
    //     否则两个并发提交会各写一条 active 版本（进程内按 dataRoot 排队，见 withStableKeyLock）。 ---
    const writePlan = async () => {
      // --- 切片4：同 stable_key 的**写前**判定（合并 / 冲突 / 取代），同样一条都不写。
      //     必须与证据校验一样在落盘前跑完：否则"第 1 条已写、第 2 条是同键冲突"会留下半截结果。 ---
      const resolved = await resolveStableKeyActions({ plan, principal, findActiveMemory, readableMemory, mergeMemory, supersedeMemory, targetPathOf });
      if (!resolved.ok) {
        await recordConflict({ record, conflicts: resolved.conflicts, payloadHash: plan.payloadHash });
        const primary = resolved.conflicts[0];
        return failure(409, primary.code, conflictMessage(primary), { conflicts: resolved.conflicts });
      }

      // --- 真正落盘。写在**共享 writer**上（服务端那一个：带 onIndexed，写完立刻进索引）。 ---
      // 部分写入语义（不假装原子）：写完一条才发现下一条写不进去时，**不回滚**已写的那条
      // —— 正式记忆可能已经被索引、被读走；把它删掉是另一种更难解释的破坏。
      // 这种情形回报 needs_review（全失败 = failed），把 index 与原因结构化写进回执与 job.submissions。
      const writes = [];
      const failures = [];
      let stopped = false;
      for (const item of resolved.planned) {
        if (stopped) { failures.push({ index: item.index, id: item.id, error: "not attempted: an earlier conclusion failed to write" }); continue; }
        try {
          if (item.action === "merge") {
            // 同键同体：只刷新证据，**保留原 id / 正文 / 版本**，不产生第二个文件。
            const merged = await mergeMemory({ filePath: item.mergeTarget.path, evidence_refs: item.evidence_refs, principal });
            writes.push({ action: "merged", id: merged.id, layer: item.layer, path: merged.path, written_at: completedAt(), updated_at: merged.updated_at });
          } else if (item.action === "supersede") {
            // 同键异体且点名了当前 active：走**既有** writer.supersede（旧文件留盘并闭合，链可追）。
            const result = await supersedeMemory({ oldId: item.supersedeTarget.id, ...item.writeInput });
            writes.push({ action: "superseded", id: result.new.id, layer: item.layer, path: result.new.path, old_id: item.supersedeTarget.id, stable_key: item.stable_key, written_at: completedAt() });
          } else {
            const result = await writeMemory(item.writeInput);
            writes.push({ id: item.id, layer: result.layer, path: result.path, ...(result.updated ? { updated: true } : { created: true }), written_at: completedAt() });
          }
        } catch (error) {
          stopped = true;
          failures.push({ index: item.index, id: item.id, error: String(error?.message ?? error).slice(0, 300) });
          continue;
        }
      }

      if (!writes.length) {
        const receipt = { outcome: "failed", writes, failures, completed_at: completedAt() };
        return commit({ record, state: "failed", receipt, payloadHash: plan.payloadHash, outcome: "failed" });
      }
      // outcome 的既有含义是"这批写入的性质"：全是普通写入 ⇒ written（切片2/3 的既有断言）；
      // 全是合并 ⇒ merged；全是取代 ⇒ superseded；混着来 ⇒ mixed。
      const actions = [...new Set(writes.map((item) => item.action ?? "written"))];
      const outcome = failures.length ? "needs_review" : actions.length === 1 ? actions[0] : "mixed";
      const receipt = { outcome, ...(failures.length ? { reason: "partial_write" } : {}), writes, ...(failures.length ? { failures } : {}), completed_at: completedAt() };
      return commit({ record, state: failures.length ? "needs_review" : "completed", receipt, payloadHash: plan.payloadHash, outcome });
    };

    // 带 stable_key 的提交必须与同键的其它提交互斥；不带键的提交不做同键判定，保持原样直通。
    return plan.planned.some((item) => item.stable_key) ? withStableKeyLock(dataRoot, writePlan) : writePlan();

    async function commit({ record: current, state, receipt, payloadHash, outcome, note = null }) {
      const at = receipt.completed_at;
      const submission = { at, state, outcome, ...(note ? { note } : {}), written: receipt.writes.length, failed: Number(receipt.failures?.length ?? 0), payload_hash: payloadHash };
      const updated = {
        ...current,
        state,
        receipt,
        payload_hash: payloadHash,
        submissions: [...(Array.isArray(current.submissions) ? current.submissions : []), submission],
        completed_at: at,
        updated_at: at,
      };
      await atomicWriteJson(jobPath(current.job_id), updated);
      return { ok: true, job: updated, receipt, idempotent: false };
    }

    /**
     * 冲突拒绝也要**落盘**（落的是 job，不是正式记忆）：公开 HTTP 只回 409，而"为什么被拒"必须
     * 在库里查得到、且状态**明确可重试** —— needs_review 正是既有状态机里"没写成、可以重提"的那一格。
     * 零正式记忆写入：这里只动 refinement-jobs/<job_id>.json。
     */
    async function recordConflict({ record: current, conflicts, payloadHash }) {
      const at = completedAt();
      const submission = { at, state: "needs_review", outcome: conflicts[0].code, written: 0, failed: 0, payload_hash: payloadHash };
      const updated = {
        ...current,
        state: "needs_review",
        needs_review_reason: conflicts[0].code,
        conflicts,
        submissions: [...(Array.isArray(current.submissions) ? current.submissions : []), submission],
        updated_at: at,
      };
      await atomicWriteJson(jobPath(current.job_id), updated);
      return updated;
    }
  }

  /**
   * 切片4：把"每条带 stable_key 的结论"解析成三种确定动作：write / merge / supersede。
   * 纯判定 —— 只读（经注入的 findActiveMemory / readableMemory）+ 纯计算，**不落盘**。
   * 作用域由 findActiveMemory 自己收窄（同 layer/project/tenant/group/user），所以这里不做任何
   * 可见性判断；"当前 principal 读不到这条 active 记忆"用注入的 readableMemory（就是检索侧那一份判据）
   * 确认，读不到就拒绝且**不回传 id**（不把 active id 变成探测器）。
   */
  async function resolveStableKeyActions({ plan, principal, findActiveMemory, readableMemory, mergeMemory, supersedeMemory, targetPathOf }) {
    const keyed = plan.planned.filter((item) => item.stable_key);
    if (keyed.length) {
      if (typeof findActiveMemory !== "function" || typeof readableMemory !== "function" || typeof mergeMemory !== "function" || typeof supersedeMemory !== "function" || typeof targetPathOf !== "function") {
        throw new Error("refinement job submit with stable_key requires findActiveMemory, readableMemory, mergeMemory, supersedeMemory and targetPathOf collaborators");
      }
    }
    const planned = [];
    const conflicts = [];
    for (const item of plan.planned) {
      if (!item.stable_key) { planned.push({ ...item, action: "write" }); continue; }
      const active = await findActiveMemory({ stable_key: item.stable_key, layer: item.layer, project: item.project, principal });
      if (!active?.found) { planned.push({ ...item, action: "write" }); continue; }
      const base = { index: item.index, layer: item.layer, stable_key: item.stable_key, active_id: active.id };
      // 点名取代：只允许点名**当前 active** 的那一条；点错（不存在/非 active/跨作用域）一律拒绝。
      if (item.supersedes && item.supersedes !== active.id) {
        conflicts.push({ ...base, code: "SUPERSEDE_TARGET_INVALID", supersedes: item.supersedes });
        continue;
      }
      const readable = await readableMemory(active.id);
      if (!readable) {
        conflicts.push({ ...base, code: "SUPERSEDE_REQUIRED", active_id: null, reason: "active_memory_not_readable" });
        continue;
      }
      if (normalizeBodyForEquivalence(item.candidateBody) === normalizeBodyForEquivalence(active.body)) {
        planned.push({ ...item, action: "merge", mergeTarget: active });
        continue;
      }
      if (!item.supersedes) {
        conflicts.push({ ...base, code: "SUPERSEDE_REQUIRED", reason: "body_differs" });
        continue;
      }
      // 该层物理上只保留一个文件（project-state 的 current-state.md）⇒ 新旧两版无法共存，
      // 取代会把两份内容互相覆盖。明确拒绝，而不是让旧内容被新版盖掉。
      const newPath = targetPathOf({ layer: item.layer, id: item.id, project: item.project, principal });
      if (newPath && newPath === active.path) {
        conflicts.push({ ...base, code: "SUPERSEDE_UNSUPPORTED_LAYER", reason: "same_file_layer" });
        continue;
      }
      planned.push({ ...item, action: "supersede", supersedeTarget: active });
    }
    if (conflicts.length) return { ok: false, conflicts };
    return { ok: true, planned };
  }

  function conflictMessage(conflict) {
    const label = `conclusions[${conflict.index}]`;
    if (conflict.code === "SUPERSEDE_TARGET_INVALID") {
      return `${label}: supersedes does not name the active memory for stable_key ${JSON.stringify(conflict.stable_key)}; submit the active id ${JSON.stringify(conflict.active_id)} to replace it`;
    }
    if (conflict.code === "SUPERSEDE_UNSUPPORTED_LAYER") {
      return `${label}: layer "${conflict.layer}" keeps one file per scope, so stable_key ${JSON.stringify(conflict.stable_key)} cannot keep both versions; resolve it through a layer that stores one file per memory`;
    }
    if (conflict.reason === "active_memory_not_readable") {
      return `${label}: stable_key ${JSON.stringify(conflict.stable_key)} already has an active memory in this scope that the current principal may not read; a human must resolve it`;
    }
    return `${label}: stable_key ${JSON.stringify(conflict.stable_key)} already has an active memory (${JSON.stringify(conflict.active_id)}); resubmit the same body to merge evidence, or submit supersedes with that id to replace it`;
  }

  return { recordCapture, list, get, claim, submit, root: jobsRoot, deadlineHours: deadlineMs / (60 * 60 * 1000) };
}
