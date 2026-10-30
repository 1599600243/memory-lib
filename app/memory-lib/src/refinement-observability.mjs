import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile, parseFrontmatter } from "./read-only-core.mjs";
import { unquote } from "./frontmatter-util.mjs";
import { createMemoryWriter } from "./write-memory.mjs";

export const DEFAULT_REFINEMENT_THRESHOLD = 3;
export const REFINED_DIRS = ["curated", "project-state", "tools-memory", "plans", "profile"];
const CONVERSATION_DIR = ["evidence", "conversations"];

function active(text) {
  const fm = parseFrontmatter(text).frontmatter;
  return !["deprecated", "deleted", "archived"].includes(String(fm.status ?? "active").toLowerCase()) ? fm : null;
}
function refsOf(fm) {
  if (Array.isArray(fm.evidence_refs)) return fm.evidence_refs.map((ref) => unquote(String(ref)));
  try { const parsed = JSON.parse(String(fm.evidence_refs ?? "")); return Array.isArray(parsed) ? parsed.map((ref) => unquote(String(ref))) : []; } catch { return []; }
}
function hasTag(fm, tag) {
  return Array.isArray(fm.tags) ? fm.tags.map(String).includes(tag) : String(fm.tags ?? "").includes(tag);
}
// REFINE-LOOP-1-REJECT1：一条证据有**两个**合法标识，巡检必须都认。
//   · `id`      —— 证据文件自己的 id（`conversation-ff97f09a…`），历史记忆引用的是它；
//   · `eventId` —— 捕获事件标识（`session-…#turn-298` / `<uuid>#turn-1`），**带“第几轮”的粒度**，
//                   提炼线按范围单要求写的就是这种。
// 只认 id 会让提炼产出全部关联不上 ⇒ 仪表把健康系统报成「零精炼 / alert」。
// 这里收成唯一一处真值，snapshot() 与 pending() 共用，避免两处口径再次漂移。
export function identifiersOfEvidence(item) {
  const id = String(item.frontmatter.id ?? path.basename(item.file, ".md"));
  const eventId = unquote(item.frontmatter.eventId);
  return eventId && eventId !== id ? [id, eventId] : [id];
}
async function markdownFiles(root) {
  return (await walkFiles(root)).filter((file) => path.extname(file).toLowerCase() === ".md");
}
async function readEntries(root) {
  const entries = [];
  for (const file of await markdownFiles(root)) {
    const text = await readTextFile(file);
    const fm = text ? active(text) : null;
    if (fm) entries.push({ file, text, frontmatter: fm });
  }
  return entries;
}
function iso(value) { return new Date(value).toISOString(); }
function within24(value, now) { const t = Date.parse(value ?? ""); return Number.isFinite(t) && now - t <= 24 * 60 * 60 * 1000 && t <= now; }
function firstRequestFromText(text) {
  const match = String(text ?? "").match(/## 用户\s*\n\s*([\s\S]*?)(?:\n\s*##|\n\s*$)/u);
  return String(match?.[1] ?? "未记录首条诉求").trim().slice(0, 80) || "未记录首条诉求";
}

// 巡检报告的落点是**运维契约**，只允许有一个真值（唯一常量 + 可配置 + 单写）。
//
// 历史（三个提交把它来回挪过，别再踩）：
//   · 6009735 M2.0 起：写 `project-state/memory-system/refinement-inspection.md`（进检索根）；
//   · bb62f7b WRITE-DENY-1：挪到 `runtime/refinement-inspection.md`，理由见下；
//   · REFINE-LOOP-1-REJECT1b 一度把它改回 project-state，效果是产品盯的文件恢复了更新，
//     但**代价被验收抓出来**：报告落在无身份字段的 project 容器里，任何身份的
//     `/v1/get` 与 MCP `memory_get` 都能读到它（404 → 200），可见面被扩大。
//
// 产品岗裁决（orders/REFINE-LOOP-1-REJECT1C-inspection-path-strict.md）：
//   **巡检报告不该进检索根**——它是运维指标，不是一条记忆。
//   ① 默认落点 = `runtime/refinement-inspection.md`（runtime/ 不在 REFINED_DIRS 内，不进检索）；
//   ② project-state/ 那份只作为**显式指定**的可选项（`reportPath` / `--refinement-report-path`）；
//   ③ `visibility: private` 保留；任何时刻只写一处（绝不双写）。
//   推论：检索根里的东西该回答"我们干过什么"，而不是"系统今天提炼了几条"。
export const DEFAULT_INSPECTION_REPORT_RELATIVE_PATH = path.join("runtime", "refinement-inspection.md");

/** 巡检报告最终落盘路径：显式 `reportPath` 优先，否则落在 dataRoot 下的默认相对路径。 */
export function inspectionReportPath(dataRoot, { reportPath = null } = {}) {
  if (reportPath) return path.resolve(String(reportPath));
  return path.join(dataRoot, DEFAULT_INSPECTION_REPORT_RELATIVE_PATH);
}

/** 这条路径是否落在某个检索根（REFINED_DIRS）之下 —— 巡检报告**必须**为 false。 */
export function isInsideRetrievalRoot(candidate, dataRoot = null) {
  const relative = dataRoot ? path.relative(dataRoot, path.resolve(String(candidate))) : String(candidate);
  const normalized = relative.split(path.sep).join("/");
  return REFINED_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

export function createRefinementObservability({ dataRoot, audit = null, now = () => Date.now(), threshold = DEFAULT_REFINEMENT_THRESHOLD, reportPath = null } = {}) {
  if (!dataRoot) throw new Error("refinement observability requires dataRoot");
  const writer = createMemoryWriter({ dataRoot });
  const reportPathOption = reportPath;   // 显式覆盖（null = 用默认的 runtime/refinement-inspection.md）
  let lastAlertKey = null;

  async function snapshot({ group_id = null, user_id = null } = {}) {
    const allRaw = await readEntries(path.join(dataRoot, ...CONVERSATION_DIR));
    const refined = [];
    for (const dir of REFINED_DIRS) refined.push(...await readEntries(path.join(dataRoot, dir)));
    const identityOf = (fm) => {
      const group = unquote(fm.group_id ?? fm.groupId) || null;
      const user = unquote(fm.user_id ?? fm.userId) || null;
      return { group_id: group === "unknown" ? null : group, user_id: user === "unknown" ? null : user };
    };
    const matches = (item) => {
      const identity = identityOf(item.frontmatter);
      if (group_id !== null && String(identity.group_id ?? "unknown") !== String(group_id)) return false;
      if (user_id !== null && String(identity.user_id ?? "unknown") !== String(user_id)) return false;
      return true;
    };
    const raw = allRaw.filter(matches);
    // 两种标识都进索引（id 与 eventId 指向同一条证据；此处只用于 `.has()` 判断，不会重复计数）
    const rawById = new Map();
    for (const item of raw) for (const key of identifiersOfEvidence(item)) rawById.set(key, item);
    const linked = refined.filter((item) => refsOf(item.frontmatter).some((ref) => rawById.has(ref)));
    const refinedTimes = linked.map((item) => unquote(item.frontmatter.updated_at ?? item.frontmatter.occurred_at)).filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const rawTimes = raw.map((item) => unquote(item.frontmatter.capturedAt ?? item.frontmatter.captured_at ?? item.frontmatter.occurred_at)).filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const current = Number(now());
    const conversations_last_24h = rawTimes.filter((t) => current - t <= 24 * 60 * 60 * 1000 && t <= current).length;
    const refined_last_24h = refinedTimes.filter((t) => current - t <= 24 * 60 * 60 * 1000 && t <= current).length;
    const latest = refinedTimes.length ? new Date(Math.max(...refinedTimes)).toISOString() : null;
    const latestRefinedTime = refinedTimes.length ? Math.max(...refinedTimes) : null;
    const zeroRefinementStreak = rawTimes.filter((t) => current - t <= 24 * 60 * 60 * 1000 && t <= current && (latestRefinedTime === null || t > latestRefinedTime)).length;
    const alert = { threshold, status: zeroRefinementStreak >= threshold ? "alert" : "ok", audible: zeroRefinementStreak >= threshold, signal: zeroRefinementStreak >= threshold ? "audible" : "none", consecutive_zero_refinement: zeroRefinementStreak };
    const unattributed_conversations_global = allRaw.filter((item) => {
      const identity = identityOf(item.frontmatter);
      return !identity.group_id && !identity.user_id;
    }).length;
    return { raw_conversations: raw.length, refined_memories: linked.length, last_refined_at: latest, refined_last_24h, conversations_last_24h, refinement_ratio: conversations_last_24h ? Number((refined_last_24h / conversations_last_24h).toFixed(4)) : null, unattributed_conversations_global, plan: { group_id, user_id, scope: group_id || user_id ? "scoped" : "global" }, alert };
  }

  async function pending({ group_id = null, user_id = null, limit = 50, since = null } = {}) {
    const allRaw = await readEntries(path.join(dataRoot, ...CONVERSATION_DIR));
    const refined = [];
    for (const dir of REFINED_DIRS) refined.push(...await readEntries(path.join(dataRoot, dir)));
    const linked = new Set(refined.flatMap((item) => refsOf(item.frontmatter)));
    const start = since ? Date.parse(String(since).length <= 10 ? `${since}T00:00:00.000Z` : since) : (() => { const d = new Date(now()); d.setUTCHours(0, 0, 0, 0); return d.getTime(); })();
    const identityOf = (fm) => ({ group_id: unquote(fm.group_id ?? fm.groupId) || null, user_id: unquote(fm.user_id ?? fm.userId) || null });
    const matches = (item) => { const identity = identityOf(item.frontmatter); return (group_id === null || String(identity.group_id ?? "unknown") === String(group_id)) && (user_id === null || String(identity.user_id ?? "unknown") === String(user_id)); };
    const items = allRaw
      .filter(matches)
      // 同一口径：证据的任一标识（id 或 eventId）被记忆引用过，就算"已提炼"，不进待办
      .filter((item) => !identifiersOfEvidence(item).some((key) => linked.has(key)))
      .map((item) => {
        const capturedAt = unquote(item.frontmatter.capturedAt ?? item.frontmatter.captured_at ?? item.frontmatter.occurred_at);
        return { evidence_id: String(item.frontmatter.id ?? path.basename(item.file, ".md")), captured_at: capturedAt, summary: firstRequestFromText(item.text) };
      }).filter((item) => Number.isFinite(Date.parse(item.captured_at)) && Date.parse(item.captured_at) >= start).sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return { scope: group_id || user_id ? "scoped" : "global", since: new Date(start).toISOString(), count: Math.min(items.length, safeLimit), total_count: items.length, items: items.slice(0, safeLimit) };
  }

  async function statusFor(evidenceId, { group_id = null, user_id = null } = {}) {
    const metrics = await snapshot({ group_id, user_id });
    const today = await pending({ group_id, user_id });
    const all = await pending({ group_id, user_id, since: "1970-01-01", limit: 200 });
    return { pending: today.items.some((item) => item.evidence_id === evidenceId), unrefined_today: today.total_count, unrefined_total: all.total_count, last_refined_at: metrics.last_refined_at };
  }

  async function writeReport(metrics, anomalies = []) {
    // 只写一处：默认 = 产品实际在读的 project-state/memory-system/；可用 reportPath 覆盖。
    const resolvedReportPath = inspectionReportPath(dataRoot, { reportPath: reportPathOption });
    const body = `---\nid: refinement-inspection\nlayer: project\ncontainer: project\nvisibility: private\ntype: inspection-report\nstatus: deprecated\nupdated_at: ${iso(now())}\nevidence_refs: ["inspection:refinement"]\nproject: memory-system\ntags: ["refinement", "inspection", "auto-generated"]\n---\n\n# 记忆精炼巡检报告\n\n> 本文件是**运维指标**、不是记忆：落点在检索根之外（runtime/，不在 REFINED_DIRS 内），\n> 并标 status=deprecated / visibility=private，确保它不会被当成一条正式记忆读走。\n\n- 生成时间：${iso(now())}\n- 最近 24 小时捕获：${metrics.conversations_last_24h}\n- 最近 24 小时精炼：${metrics.refined_last_24h}\n- 原始对话总数：${metrics.raw_conversations}\n- 已关联正式记忆：${metrics.refined_memories}\n- 最近一次真正记住：${metrics.last_refined_at ?? "从未"}\n- 精炼率：${metrics.refinement_ratio ?? "无分母"}\n- 告警状态：${metrics.alert.status}（连续零精炼 ${metrics.alert.consecutive_zero_refinement}，阈值 ${metrics.alert.threshold}）\n- 声音信号：${metrics.alert.audible ? "已触发" : "未触发"}\n\n## 异常\n\n${anomalies.length ? anomalies.map((x) => `- ${x}`).join("\n") : "- 未发现异常"}\n\n## 诊断\n\n捕获与精炼是两个独立动作；本报告只依据原文 evidence 与正式记忆的 evidence_refs 关联，不把原文层当作可检索记忆。\n`;
    await fs.mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await fs.writeFile(resolvedReportPath, body, "utf8");
    return resolvedReportPath;
  }

  async function inspect({ group_id = null, user_id = null, anomalies = [] } = {}) {
    const metrics = await snapshot({ group_id, user_id });
    if (metrics.alert.audible) {
      const key = `${metrics.conversations_last_24h}:${metrics.last_refined_at ?? "none"}`;
      if (key !== lastAlertKey) {
        lastAlertKey = key;
        await audit?.record?.({ channel: "refinement", action: "refinement_alert", allow: true, alert: "zero-refinement-threshold", threshold: metrics.alert.threshold, consecutive_zero_refinement: metrics.alert.consecutive_zero_refinement, audible: true });
      }
    }
    const reportPath = await writeReport(metrics, anomalies);
    return { ...metrics, report_path: reportPath };
  }

  async function cleanupStubs() {
    return { removed: 0, skipped: true, reason: "auto-stub writes are retired; existing artifacts require an explicit maintenance action" };
  }

  async function onCapture({ principal = null } = {}) {
    return inspect({ group_id: principal?.group_id ?? null, user_id: principal?.user_id ?? null });
  }
  return { snapshot, pending, statusFor, inspect, onCapture, cleanupStubs, threshold };
}
