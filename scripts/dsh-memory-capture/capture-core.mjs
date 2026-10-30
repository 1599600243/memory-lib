// IN-PLUGIN-1：捕获核（纯逻辑 + 一个薄传输层）
//
// 为什么要拆出来：插件本体跑在 DSH 宿主进程里，任何一点逻辑错都会连累对话。
// 把「事件契约 / 重试判定 / 状态汇总 / 传输」放成普通模块，就能在工作区内用
// 假 ctx + 假服务端跑完整测试，不需要重启 DSH、也不碰生产 data。
//
// 四条纪律（范围单 §三）：
//   ① 失败**不推进**游标；同一 turn 最多 3 次；超限进死信（落文件，带原因）。
//   ② 不做无界内存重试队列 —— 待发的东西一律先落盘（queue/），再逐条处理。
//   ③ 状态可查：一条命令答出「最近成功 / 连续失败 / 死信数 / 待发数」。
//   ④ 所有 IO 异步、带超时（≤5s）、全包 try/catch —— 异常只记账，绝不抛回宿主。

import fsp from "node:fs/promises";
import path from "node:path";

export const SOURCE = "dsh-session";
export const MAX_TEXT = 8000;
export const MAX_ATTEMPTS = 3;
export const POST_TIMEOUT_MS = 5000;
export const RETRY_INTERVAL_MS = 60_000;
export const STATE_VERSION = 2;
export const PRUNE_DONE_DAYS = 7;

/** 内容块 → 纯文本（只取 text 段，丢掉 reasoning/工具块）。 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function workspaceOf(session) {
  const value = session?.workspace ?? session?.cwd ?? session?.meta?.workspace ?? session?.meta?.cwd;
  return typeof value === "string" && value.trim() ? value.trim().replace(/\\/g, "/") : null;
}

export function sessionIdOf(session) {
  const id = session?.id ?? session?.sessionId ?? session?.meta?.id;
  return typeof id === "string" && id ? id : null;
}

/** 每一轮的唯一键。刻意与旧实现保持一致（`<sessionId>#turn-<n>`），
 *  这样服务端按 (source, conversation_id, event_id) 的既有幂等仍然生效。 */
export function turnKeyOf(sessionId, turn) {
  return `${sessionId}#turn-${turn}`;
}

/** 统一事件契约（与 skill / 服务端一致）。 */
export function buildCaptureEvent({ sessionId, turn, messages, workspace }) {
  return {
    source: SOURCE,
    conversation_id: sessionId,
    event_id: turnKeyOf(sessionId, turn),
    ...(workspace ? { workspace } : {}),
    messages: messages.map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_TEXT) })),
  };
}

/** 该不该继续重试。返回 'done' | 'retry' | 'dead'。 */
export function nextAttemptVerdict(attempts, maxAttempts = MAX_ATTEMPTS) {
  if (attempts >= maxAttempts) return "dead";
  return "retry";
}

/** 空状态。 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    updated_at: null,
    turns: {},
    stats: {
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      lastError: null,
      submitted: 0,
      failed: 0,
      dead_lettered: 0,
    },
  };
}

/**
 * 读旧版 state.json（只有 sessions[id].maxTurn）里的**会话清单**，
 * 只用于向人展示"历史上有哪些会话被捕获过"，**不参与任何判定**。
 *
 * 为什么不迁移旧的 maxTurn 当游标：那个游标正是"失败仍推进 ⇒ 永不重试"的病根
 * （maxTurn 一涨，之前失败的那一轮就永远 isSubmitted=true）。旧值只做档案。
 */
export function legacySessionCount(legacyState) {
  const sessions = legacyState?.sessions;
  if (!sessions || typeof sessions !== "object") return 0;
  return Object.keys(sessions).length;
}

/** 汇总状态，给 status 命令用。 */
export function summarizeState(state, { pending = 0, dead = 0, now = Date.now() } = {}) {
  const turns = state?.turns ?? {};
  let done = 0;
  let deadTracked = 0;
  for (const entry of Object.values(turns)) {
    if (entry?.status === "done") done += 1;
    else if (entry?.status === "dead") deadTracked += 1;
  }
  const lastSuccessAt = state?.stats?.lastSuccessAt ?? null;
  return {
    version: state?.version ?? null,
    done_turns: done,
    dead_turns: deadTracked,
    pending_queue: pending,
    dead_letters: dead,
    last_success_at: lastSuccessAt,
    last_success_ago_ms: lastSuccessAt ? Math.max(0, now - Date.parse(lastSuccessAt)) : null,
    last_failure_at: state?.stats?.lastFailureAt ?? null,
    consecutive_failures: state?.stats?.consecutiveFailures ?? 0,
    last_error: state?.stats?.lastError ?? null,
    submitted_total: state?.stats?.submitted ?? 0,
    failed_total: state?.stats?.failed ?? 0,
    dead_lettered_total: state?.stats?.dead_lettered ?? 0,
  };
}

/**
 * 提交一条捕获。**永不抛**：成功返回 {ok:true, evidenceId}，失败返回 {ok:false, error}。
 * fetchImpl 可注入（测试用），默认用全局 fetch。
 */
export async function postCapture({ auth, event, apiBase, timeoutMs = POST_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`${apiBase}/v1/conversations/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...auth, ...event }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || /timeout|aborted/i.test(String(e?.message));
    return { ok: false, status: null, ms: Date.now() - started, error: timeout ? `超时(>${timeoutMs}ms)` : `${e?.name ?? "Error"}: ${e?.message ?? e}` };
  }
  let body = null;
  let text = "";
  try {
    text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    return { ok: false, status: res.status, ms: Date.now() - started, error: `HTTP ${res.status} ${String(text).slice(0, 200)}` };
  }
  return { ok: true, status: res.status, ms: Date.now() - started, evidenceId: body?.evidenceId ?? null, candidateCount: body?.candidateCount ?? 0, body };
}

// ---------------------------------------------------------------- 磁盘布局（插件与 status 命令共用一套，避免口径漂移）

/** 一个工作目录里的全部落点。插件和 status.mjs 都从这里取，不许各写一份字面量。 */
export function pathsOf(workDir) {
  return {
    workDir,
    stateFile: path.join(workDir, "capture-state-v2.json"),
    legacyStateFile: path.join(workDir, "state.json"),
    queueDir: path.join(workDir, "queue"),
    deadDir: path.join(workDir, "dead"),
    logFile: path.join(workDir, "realtime.log"),
  };
}

export async function readStateFile(stateFile) {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    return { ...emptyState(), ...parsed, turns: { ...(parsed?.turns ?? {}) }, stats: { ...emptyState().stats, ...(parsed?.stats ?? {}) } };
  } catch {
    return emptyState();
  }
}

/**
 * 一条命令要回答的那四个问题，全在这里算出来：
 * 最近成功时间 / 连续失败数 / 死信条数 / 待发条数。
 * 插件内的快照与 status.mjs 都调它 —— 只有一份口径。
 */
export async function readSnapshot({ workDir, apiBase = null, now = Date.now() } = {}) {
  const p = pathsOf(workDir);
  const state = await readStateFile(p.stateFile);
  let pendingQueue = 0;
  try {
    pendingQueue = (await fsp.readdir(p.queueDir)).filter((n) => n.endsWith(".json")).length;
  } catch {
    pendingQueue = 0;
  }
  let dead = 0;
  try {
    dead = (await fsp.readdir(p.deadDir)).filter((n) => n.endsWith(".json")).length;
  } catch {
    dead = 0;
  }
  let legacySessions = 0;
  try {
    legacySessions = legacySessionCount(JSON.parse(await fsp.readFile(p.legacyStateFile, "utf8")));
  } catch {
    legacySessions = 0;
  }
  return {
    ...summarizeState(state, { pending: pendingQueue, dead, now }),
    legacy_sessions_archived: legacySessions,
    work_dir: workDir,
    state_file: p.stateFile,
    queue_dir: p.queueDir,
    dead_dir: p.deadDir,
    api_base: apiBase,
  };
}
