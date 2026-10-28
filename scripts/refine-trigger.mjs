#!/usr/bin/env node
/**
 * MAINPATH-2 提炼触发器 —— 让「提炼」活在代理的主流程里，而不是靠谁记得手动跑脚本。
 *
 * 为什么放在代理里（产品岗裁决，见 orders/MAINPATH-2-refine-inside-proxy.md）：
 * 今天两次事故都是「旁路组件静默死」——插件断 2.5 天没人发现、poller 首败即停、
 * 定时器装不上。代理不一样：它死了对话当场不通，人立刻就知道。
 * 所以把触发点放在代理收到并落库一个新 turn 之后，异步跑，不阻塞转发。
 *
 * 三条纪律（本模块的全部职责就是保证它们不被绕过）：
 *   ① 不阻塞对话：任何触发路径都不得让请求多等一毫秒；失败只落日志 + 状态文件。
 *   ② 不并发：同一时刻最多一个提炼进程（锁文件），且 60 秒内不重复触发。
 *   ③ 可关：`--refine=off` 退回纯手动模式，一切行为与加这个功能之前一致。
 *
 * 子进程一律用「文件描述符」作 stdio，**不用管道**：
 *   - 管道在本机沙箱下会 EPERM（spawn EPERM），文件描述符两条路都能跑；
 *   - 顺带把 worker 的 stdout/stderr 直接落到日志文件，失败时能直接看尾巴。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 同一会话两次触发的最小间隔（产品岗口径：至少 60 秒）。 */
export const MIN_INTERVAL_MS = 60_000;
/** 全局两次触发的最小间隔（同上）。 */
export const GLOBAL_MIN_INTERVAL_MS = 60_000;
/** 锁超过这个年龄就认为是上一个进程被杀留下的，可以强占。 */
export const LOCK_STALE_MS = 10 * 60_000;
/** 一轮提炼最多处理多少条证据（省额度；剩余的下一轮继续）。 */
export const DEFAULT_LIMIT = 10;
/** 单轮提炼硬超时；超时就杀子进程，绝不让它一直挂着。 */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** 节流表最多记多少个会话，防止长跑进程内存无限涨。 */
export const MAX_THROTTLE_ENTRIES = 200;

export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// 触发状态（可持久化，给 refine-status.mjs 读）
// ---------------------------------------------------------------------------

export function emptyTriggerState() {
  return {
    version: STATE_VERSION,
    enabled: null, // null = 还没跑过；true/false 由代理启动参数决定
    updated_at: null,
    lastAttemptAt: null, // 上一次真正去起进程的时刻（不论成败）
    lastTriggerAt: null, // 上一次成功发起（拿到锁并 spawn 了）的时刻
    lastSuccessAt: null, // 上一次 worker 正常退出的时刻
    lastFailureAt: null,
    lastError: null,
    lastDurationMs: null,
    lastExitCode: null,
    lastConversationId: null,
    lastReason: null, // 最近一次决策的原因（便于回答「为什么没触发」）
    triggered: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    skippedByThrottle: 0,
    skippedByLock: 0,
    skippedByWorkerLock: 0,
    skippedByNoPending: 0,
    skippedByDisabled: 0,
    throttleByConversation: {},
  };
}

export async function loadTriggerState(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyTriggerState(), ...parsed, throttleByConversation: { ...(parsed?.throttleByConversation ?? {}) } };
  } catch {
    return emptyTriggerState();
  }
}

export async function saveTriggerState(file, state) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// 锁（同一时刻最多 1 个提炼进程）
// ---------------------------------------------------------------------------

/**
 * 只读地看一眼锁。`stale` 表示这个锁老到可以认为是残留，不应再挡路。
 * 注意：判断年龄用锁文件自己的 mtime，不依赖里面的 pid —— 进程被杀时 pid 是死值。
 */
export async function inspectLock(lockFile, { now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  try {
    const stat = await fsp.stat(lockFile);
    const ageMs = Math.max(0, now - stat.mtimeMs);
    let pid = null;
    try {
      pid = Number((await fsp.readFile(lockFile, "utf8")).trim()) || null;
    } catch {
      /* 锁文件内容读不到不影响判断 */
    }
    return { exists: true, stale: ageMs >= staleMs, ageMs, pid };
  } catch {
    return { exists: false, stale: false, ageMs: 0, pid: null };
  }
}

/**
 * 抢锁。用 `flag: "wx"` 让「判断 + 创建」成为一步，避免两个请求同时抢到。
 * 返回 { acquired, reason }；reason 会原样写进日志，所以措辞要能直接给人看。
 */
export async function acquireLock(lockFile, { now = Date.now(), staleMs = LOCK_STALE_MS, pid = process.pid } = {}) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  const before = await inspectLock(lockFile, { now, staleMs });
  if (before.exists && !before.stale) {
    return { acquired: false, reason: `另一个提炼进程还在跑（pid=${before.pid ?? "?"}，锁 ${Math.round(before.ageMs / 1000)}s 前建立）` };
  }
  if (before.exists && before.stale) {
    // 残留锁：先删再抢。删失败也无所谓，下面的 wx 会再判一次。
    await fsp.rm(lockFile, { force: true }).catch(() => {});
  }
  try {
    await fsp.writeFile(lockFile, String(pid), { encoding: "utf8", flag: "wx" });
    return { acquired: true, reason: before.exists ? "清掉过期锁后抢到" : "抢到锁" };
  } catch (e) {
    // 极窄的竞态：另一个进程刚好在这一瞬抢到了。
    return { acquired: false, reason: `抢锁失败（${e.code ?? e.message}）` };
  }
}

export async function releaseLock(lockFile) {
  await fsp.rm(lockFile, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 节流（同一会话 / 全局，至少间隔 60 秒）
// ---------------------------------------------------------------------------

function pruneThrottleMap(map, now, ttlMs, max = MAX_THROTTLE_ENTRIES) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  // 先按时间淘汰旧的，仍超量就按最久未触发裁掉
  const kept = {};
  for (const k of keys) {
    const at = Date.parse(map[k]);
    if (Number.isFinite(at) && now - at < ttlMs) kept[k] = map[k];
  }
  const rest = Object.entries(kept).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, max);
  return Object.fromEntries(rest);
}

/**
 * 纯决策：给定状态 + 此刻上下文，回答「这一下要不要去起提炼进程」。
 * 刻意做成纯函数，好让测试能把 60 秒、锁、无待办这些分支一个个钉死。
 *
 * 检查顺序 = 从便宜到贵：
 *   关闭 → 会话节流 → 全局节流 → 锁 → 有无待提炼
 * 前四步都不读大文件；只有真要触发时才去解析 refine-state.json。
 */
export function decideTrigger(
  state,
  {
    now = Date.now(),
    conversationId = null,
    enabled = true,
    minIntervalMs = MIN_INTERVAL_MS,
    globalMinIntervalMs = GLOBAL_MIN_INTERVAL_MS,
    lock = { exists: false, stale: false },
    pendingCount = null,
  } = {},
) {
  if (!enabled) return { allowed: false, blockedBy: "disabled", reason: "提炼触发已关闭（--refine=off），当前是手动模式" };

  if (conversationId) {
    const last = state.throttleByConversation?.[conversationId];
    const at = last ? Date.parse(last) : NaN;
    if (Number.isFinite(at)) {
      const elapsed = now - at;
      if (elapsed < minIntervalMs) {
        return {
          allowed: false,
          blockedBy: "throttle-conversation",
          reason: `会话 ${conversationId} 上次触发在 ${Math.round(elapsed / 1000)}s 前，未到 ${Math.round(minIntervalMs / 1000)}s`,
        };
      }
    }
  }

  const lastGlobal = state.lastTriggerAt ? Date.parse(state.lastTriggerAt) : NaN;
  if (Number.isFinite(lastGlobal)) {
    const elapsed = now - lastGlobal;
    if (elapsed < globalMinIntervalMs) {
      return {
        allowed: false,
        blockedBy: "throttle-global",
        reason: `全局上次触发在 ${Math.round(elapsed / 1000)}s 前，未到 ${Math.round(globalMinIntervalMs / 1000)}s`,
      };
    }
  }

  if (lock.exists && !lock.stale) {
    return { allowed: false, blockedBy: "lock", reason: `另一个提炼进程还在跑（锁 ${Math.round(lock.ageMs / 1000)}s 前建立）` };
  }

  if (pendingCount === 0) {
    return { allowed: false, blockedBy: "no-pending", reason: "没有待提炼的新证据" };
  }

  return { allowed: true, blockedBy: null, reason: "可以触发" };
}

// ---------------------------------------------------------------------------
// 「有没有新证据没被提炼」
// ---------------------------------------------------------------------------

/**
 * 从 refine-state.json 里数出还没 done 的条目。
 * 口径必须和 refine-worker 的 --status 一致：done 才算提炼完，
 * failed/dead 仍算待处理（它们还要重试），skipped 是明确跳过（短文本等），不计入。
 */
export async function countPendingFromState(stateFile) {
  let state;
  try {
    state = JSON.parse(await fsp.readFile(stateFile, "utf8"));
  } catch {
    // 没有 state = 从没提炼过；这不能当成「无事可做」，否则第一次永远不触发。
    return { known: false, pending: null, done: 0, failed: 0, dead: 0, skipped: 0, total: 0 };
  }
  const counts = { done: 0, failed: 0, dead: 0, skipped: 0, pending: 0 };
  for (const entry of Object.values(state?.evidence ?? {})) {
    const status = entry?.status;
    if (status === "done") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "dead") counts.dead += 1;
    else if (status === "skipped") counts.skipped += 1;
    else counts.pending += 1;
  }
  return {
    known: true,
    pending: counts.pending + counts.failed + counts.dead,
    done: counts.done,
    failed: counts.failed,
    dead: counts.dead,
    skipped: counts.skipped,
    total: Object.keys(state?.evidence ?? {}).length,
    last_success_at: state?.last_success_at ?? null,
    last_run_at: state?.last_run_at ?? null,
  };
}

/**
 * 本轮「有没有活干」的正确口径：磁盘证据总数 − 已 done − 已 skipped − 已 dead。
 *
 * 为什么不能只看 state：**从来没被 worker 碰过的证据根本不在 state 里**。
 * 实测过：state 里只有 684 条（done+skipped），磁盘上有 1593 条，
 * 于是"待办"被读成 0，触发判定误报"没有待提炼"，909 条积压从此再也排不上队。
 * 这个公式与 refine-worker `--status` 的 `pending` 完全一致（单一口径）。
 *
 * failed 计入待办（还会重试），dead 不计（已放弃，要靠 --requeue-dead 人工恢复）。
 */
export async function countWorkload({ stateFile, evidenceDir = null } = {}) {
  const counts = await countPendingFromState(stateFile);
  if (!evidenceDir) return counts; // 没有证据目录 ⇒ 只能退回 state 口径
  let total = 0;
  try {
    total = (await fsp.readdir(evidenceDir)).filter((n) => n.endsWith(".md")).length;
  } catch {
    return counts;
  }
  const settled = counts.done + counts.skipped + counts.dead;
  return { ...counts, known: true, total, pending: Math.max(0, total - settled) };
}

/**
 * 证据目录里最近 sinceMs 之内有没有新的 .md。
 * 用于兜住「不是本代理写进来的证据」（旁路捕获、手工导入）——它们同样该被提炼。
 */
export async function countFreshEvidence(evidenceDir, { sinceMs = 0, now = Date.now() } = {}) {
  let names;
  try {
    names = await fsp.readdir(evidenceDir);
  } catch {
    return 0;
  }
  let fresh = 0;
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const stat = await fsp.stat(path.join(evidenceDir, name));
      if (sinceMs <= 0 || now - stat.mtimeMs <= sinceMs) fresh += 1;
    } catch {
      /* 单个文件 stat 失败不影响整体 */
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// 起一轮提炼（子进程；文件描述符做 stdio，不用管道）
// ---------------------------------------------------------------------------

/**
 * 跑一轮 refine-worker。**永不 reject** —— 调用方是代理的请求路径，这里抛错就等于
 * 把提炼的问题传染给对话。所有失败都折算成结果对象。
 */
export async function runRefineOnce({
  workerPath,
  args = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logFile,
  nodePath = process.execPath,
  spawnImpl = spawn,
  now = () => Date.now(),
}) {
  const started = now();
  let fd = null;
  let child;
  // 本次运行往日志里新写了什么：起点偏移在 spawn 之前记下来。
  // 用它区分"真的干完了"和"worker 因为别的进程持锁而直接跳过"——后者也是 exit 0，
  // 不看日志就会把它记成一次成功（E2E 里真踩过：伪造绿）。
  let startOffset = 0;
  if (logFile) {
    try {
      startOffset = (await fsp.stat(logFile)).size;
    } catch {
      startOffset = 0;
    }
  }
  try {
    if (logFile) {
      await fsp.mkdir(path.dirname(logFile), { recursive: true });
      fd = fs.openSync(logFile, "a");
    }
    const stdio = logFile ? ["ignore", fd, fd] : ["ignore", "ignore", "ignore"];
    child = spawnImpl(nodePath, [workerPath, ...args], { stdio, windowsHide: true });
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    return { ok: false, code: null, signal: null, timedOut: false, durationMs: now() - started, error: `spawn 失败：${e.code ?? e.message}` };
  }

  /** 读本次运行新增的日志片段（判断"跳过了"还是"真跑了"）。 */
  const readRunOutput = async () => {
    if (!logFile) return "";
    try {
      const buf = await fsp.readFile(logFile);
      return buf.subarray(startOffset).toString("utf8");
    } catch {
      return "";
    }
  };

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const finish = async (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      const out = await readRunOutput();
      // refine-worker 抢不到自己的锁时打印这句并以 0 退出；那不是"提炼成功"，是"什么都没做"
      const skippedBecauseLocked = payload.ok === true && /上一轮还在跑/.test(out);
      resolve({ durationMs: now() - started, timedOut, skippedBecauseLocked, runOutputTail: out.slice(-400), ...payload });
    };

    child.on("error", (e) => void finish({ ok: false, code: null, signal: null, error: `子进程错误：${e.code ?? e.message}` }));
    child.on("exit", (code, signal) => {
      if (timedOut) return void finish({ ok: false, code, signal, error: `超时 ${Math.round(timeoutMs / 1000)}s，已杀子进程` });
      if (code === 0) return void finish({ ok: true, code, signal, error: null });
      return void finish({ ok: false, code, signal, error: `refine-worker 退出码 ${code}${signal ? ` signal=${signal}` : ""}` });
    });
  });
}

/** 取日志尾巴（失败时用它回答「到底怎么坏的」）。 */
export async function tailLog(file, { lines = 12, maxChars = 2000 } = {}) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    const tail = raw.split("\n").filter(Boolean).slice(-lines).join("\n");
    return tail.length > maxChars ? tail.slice(-maxChars) : tail;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 编排：代理该调的就是这一个
// ---------------------------------------------------------------------------

/**
 * 代理落库一个 turn 之后调用它。**调用方不要 await**（要么 `void`，要么挂 catch），
 * 这里虽然本身不会抛，但保持「永远不阻塞转发」这条纪律的一致写法。
 *
 * 依赖全部可注入，测试不需要真起 worker、也不需要真模型。
 *
 * 进程内串行：同一个代理进程里的多次调用排成一队。这不是为了"省事"，是因为
 * 并发 5 个请求时会各自通过锁前的节流检查（那时还没人写 lastTriggerAt），
 * 于是可能起 2 个进程 —— 单元测试实测到过。排队之后，第一个跑完就写下了
 * lastTriggerAt，后面的读到的就是"刚触发过"，自然被节流挡下。
 * 跨进程的互斥仍由锁文件负责（两者互补，各管一段）。
 */
let triggerQueue = Promise.resolve();

export function maybeRefine(opts) {
  const run = () => maybeRefineInner(opts);
  const next = triggerQueue.then(run, run);
  // 队列自身必须吞掉异常，否则一次失败会让后续每一次都跟着炸
  triggerQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function maybeRefineInner(
  {
    stateFile,
    lockFile,
    logFile,
    workerPath,
    workerLogFile,
    refineStateFile = "D:\\MemoryLib\\state\\refine-state.json",
    evidenceDir = null,
    enabled = true,
    conversationId = null,
    limit = DEFAULT_LIMIT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    minIntervalMs = MIN_INTERVAL_MS,
    globalMinIntervalMs = GLOBAL_MIN_INTERVAL_MS,
    staleMs = LOCK_STALE_MS,
    now = () => Date.now(),
    lockNow = () => Date.now(),
    spawnImpl = spawn,
    extraArgs = [],
    log = () => {},
    freshEvidenceSinceMs = null,
  } = {},
) {
  const state = await loadTriggerState(stateFile);
  state.enabled = Boolean(enabled);

  // ① 关掉就直接返回，连锁文件都不碰（退回手动模式必须彻底）
  if (!enabled) {
    const d = decideTrigger(state, { now: now(), conversationId, enabled: false });
    state.skippedByDisabled += 1;
    state.lastReason = d.reason;
    state.updated_at = new Date(now()).toISOString();
    await saveTriggerState(stateFile, state).catch(() => {});
    log({ event: "refine_skipped", reason: d.reason, blockedBy: d.blockedBy });
    return { triggered: false, blockedBy: d.blockedBy, reason: d.reason };
  }

  // 锁的年龄按**真实时钟**算，不跟业务时钟走：进程活没活是墙上时间的事，
  // 用注入的业务时钟判年龄会得出荒谬结论（测试里就踩过：假时钟在未来 ⇒ 刚建的锁被判成过期）。
  const lock = await inspectLock(lockFile, { now: lockNow(), staleMs });

  // ② 便宜的判断先做：节流与锁，任何一个挡路就到此为止（不读大文件）
  const early = decideTrigger(state, { now: now(), conversationId, enabled, minIntervalMs, globalMinIntervalMs, lock });
  if (!early.allowed) {
    if (early.blockedBy === "throttle-conversation" || early.blockedBy === "throttle-global") state.skippedByThrottle += 1;
    else if (early.blockedBy === "lock") state.skippedByLock += 1;
    state.lastReason = early.reason;
    state.updated_at = new Date(now()).toISOString();
    await saveTriggerState(stateFile, state).catch(() => {});
    log({ event: "refine_skipped", reason: early.reason, blockedBy: early.blockedBy, lockAgeMs: lock.ageMs });
    return { triggered: false, blockedBy: early.blockedBy, reason: early.reason };
  }

  // ③ 有没有活要干
  //   口径 = 磁盘证据总数 − done − skipped − dead（与 refine-worker --status 的 pending 一致）。
  //   不能只数 state 里出现过的条目：从没被碰过的证据不在 state 里，那样会把整片积压读成"0 条待办"。
  const workload = await countWorkload({ stateFile: refineStateFile, evidenceDir });
  const pendingCount = workload.known ? workload.pending : null;
  const decided = decideTrigger(state, {
    now: now(),
    conversationId,
    enabled,
    minIntervalMs,
    globalMinIntervalMs,
    lock,
    pendingCount: pendingCount === null ? null : pendingCount,
  });
  if (!decided.allowed) {
    state.skippedByNoPending += 1;
    state.lastReason = decided.reason;
    state.updated_at = new Date(now()).toISOString();
    await saveTriggerState(stateFile, state).catch(() => {});
    log({ event: "refine_skipped", reason: decided.reason, blockedBy: decided.blockedBy, pending: pendingCount });
    return { triggered: false, blockedBy: decided.blockedBy, reason: decided.reason, pending: pendingCount };
  }

  // ④ 抢锁（"判断 + 创建"一步完成）——抢不到就是别的进程在跑
  const grabbed = await acquireLock(lockFile, { now: lockNow(), staleMs });
  if (!grabbed.acquired) {
    state.skippedByLock += 1;
    state.lastReason = grabbed.reason;
    state.updated_at = new Date(now()).toISOString();
    await saveTriggerState(stateFile, state).catch(() => {});
    log({ event: "refine_skipped", reason: grabbed.reason, blockedBy: "lock" });
    return { triggered: false, blockedBy: "lock", reason: grabbed.reason };
  }

  // ④′ 双检：拿到锁之后**重新读一遍状态**再决定。
  // 锁前那次节流检查有 TOCTOU —— 并发多个请求会各自看到"还没触发过"，
  // 于是排队到锁时第二个仍然会起进程。锁内重读一次，读到的就是上一个刚写下的
  // lastTriggerAt，于是被节流挡下。跨进程同理（别的进程也会写这个状态文件）。
  let locked = await loadTriggerState(stateFile);
  locked.enabled = Boolean(enabled);
  const recheck = decideTrigger(locked, { now: now(), conversationId, enabled, minIntervalMs, globalMinIntervalMs, lock: { exists: false } });
  if (!recheck.allowed) {
    await releaseLock(lockFile);
    locked.skippedByThrottle += recheck.blockedBy === "throttle-global" || recheck.blockedBy === "throttle-conversation" ? 1 : 0;
    locked.lastReason = recheck.reason;
    locked.updated_at = new Date(now()).toISOString();
    await saveTriggerState(stateFile, locked).catch(() => {});
    log({ event: "refine_skipped", reason: recheck.reason, blockedBy: recheck.blockedBy, stage: "after-lock" });
    return { triggered: false, blockedBy: recheck.blockedBy, reason: recheck.reason };
  }

  // ⑤ 记「已发起」，然后起进程
  const startedIso = new Date(now()).toISOString();
  const state2 = locked;
  state2.lastAttemptAt = startedIso;
  state2.lastTriggerAt = startedIso;
  state2.lastConversationId = conversationId;
  state2.lastReason = `触发（待提炼 ${pendingCount ?? "?"}）`;
  state2.triggered += 1;
  if (conversationId) {
    state2.throttleByConversation[conversationId] = startedIso;
    state2.throttleByConversation = pruneThrottleMap(state2.throttleByConversation, now(), globalMinIntervalMs * 10);
  }
  state2.updated_at = startedIso;
  await saveTriggerState(stateFile, state2).catch(() => {});
  log({ event: "refine_triggered", conversationId, pending: pendingCount, lock: grabbed.reason });

  const result = await runRefineOnce({
    workerPath,
    // 这三个参数必须由本函数按"代理自己的配置"传下去，**不能**交给调用方记：
    //   --state     决定"数待办用哪个文件"和"worker 把进度写进哪个文件"
    //   --evidence  决定"worker 读哪个证据目录"
    //   （--api/--data-root 由调用方放进 extraArgs，因为它们属于部署指向）
    // 只要有一处跟代理不一致，就会出现"代理指向副本、提炼却读/写生产"这种事——
    // E2E 里这两种都真踩过（--state 漏传、--evidence 漏传）。
    args: [
      "--limit", String(limit),
      "--state", refineStateFile,
      ...(evidenceDir ? ["--evidence", evidenceDir] : []),
      ...extraArgs,
    ],
    timeoutMs,
    logFile: workerLogFile,
    spawnImpl,
    now,
  });

  // ⑥ 收尾：无论成败都放锁；失败只落日志/状态，不外抛
  await releaseLock(lockFile);
  const after = await loadTriggerState(stateFile);
  after.enabled = Boolean(enabled);
  after.lastDurationMs = result.durationMs;
  after.lastExitCode = result.code;
  after.updated_at = new Date(now()).toISOString();
  if (result.ok && result.skippedBecauseLocked) {
    // worker 抢不到自己的锁 ⇒ 它 exit 0 但**什么都没干**。
    // 记成成功就是伪造绿（E2E 里真把它记成过一次成功），所以单独记一档。
    after.skippedByWorkerLock += 1;
    after.lastReason = "worker 因另一轮仍在跑而跳过（没干活，不算成功）";
    log({ event: "refine_skipped", blockedBy: "worker-lock", reason: after.lastReason });
  } else if (result.ok) {
    after.succeeded += 1;
    after.lastSuccessAt = new Date(now()).toISOString();
    after.lastError = null;
    after.lastReason = `成功（${Math.round(result.durationMs / 1000)}s）`;
    log({ event: "refine_ok", durationMs: result.durationMs });
  } else {
    after.failed += 1;
    if (result.timedOut) after.timedOut += 1;
    after.lastFailureAt = new Date(now()).toISOString();
    after.lastError = result.error ?? "未知失败";
    after.lastReason = `失败：${result.error}`;
    const tail = await tailLog(workerLogFile);
    log({ event: "refine_failed", error: result.error, exitCode: result.code, timedOut: result.timedOut, workerLogTail: tail });
  }
  await saveTriggerState(stateFile, after).catch(() => {});

  return {
    triggered: true,
    ok: result.ok && !result.skippedBecauseLocked,
    skippedBecauseLocked: Boolean(result.skippedBecauseLocked),
    durationMs: result.durationMs,
    error: result.error ?? null,
    pending: pendingCount,
  };
}

// ---------------------------------------------------------------------------
// 默认路径（代理与状态命令共用一套，避免两边算错地方）
// ---------------------------------------------------------------------------

export function defaultPaths({ logDir = "D:\\MemoryLib\\logs", stateFile = "D:\\MemoryLib\\state\\refine-state.json" } = {}) {
  return {
    triggerStateFile: path.join(logDir, "refine-trigger-state.json"),
    lockFile: path.join(logDir, "refine-trigger.lock"),
    triggerLogFile: path.join(logDir, "refine-trigger.log"),
    workerLogFile: path.join(logDir, "refine-worker.out.log"),
    refineStateFile: stateFile,
  };
}

/** 把 `--refine=off` / `--refine off` / 环境变量 三种写法归一成一个布尔。 */
export function parseRefineSwitch(argv = process.argv.slice(2), env = process.env) {
  const eq = argv.find((a) => a.startsWith("--refine="));
  if (eq) {
    const v = eq.slice("--refine=".length).trim().toLowerCase();
    return { value: !(v === "off" || v === "false" || v === "0" || v === "no"), raw: v };
  }
  const i = argv.indexOf("--refine");
  if (i >= 0) {
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      const v = String(next).trim().toLowerCase();
      return { value: !(v === "off" || v === "false" || v === "0" || v === "no"), raw: v };
    }
    return { value: true, raw: "on" };
  }
  const envRaw = env.CAPTURE_PROXY_REFINE;
  if (envRaw !== undefined && envRaw !== "") {
    const v = String(envRaw).trim().toLowerCase();
    return { value: !(v === "off" || v === "false" || v === "0" || v === "no"), raw: v };
  }
  return { value: true, raw: "default-on" };
}
