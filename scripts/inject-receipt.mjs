#!/usr/bin/env node
/**
 * IN-PLUGIN-2：「注入回执」—— 代理与插件**共用一个文件**，保证同一时刻只有一边注入。
 *
 * 为什么必须共用：
 *   代理（8899）把注入块拼进转发出去的请求体；插件（DSH 进程内）把注入块挂进
 *   `systemPrompt.section()`。两条路都能给同一轮对话加记忆 —— 两边各记各的节流，
 *   同一轮就会被注入两次（模型看到两段记忆：纯烧 token + 干扰）。
 *
 * 判定规则（**只有这三条**，写死在下面也写进报告）：
 *
 *   | 谁      | 什么时候让位                                                        |
 *   |---------|---------------------------------------------------------------------|
 *   | 插件    | 窗口内（默认 60s）最近一次注入是**代理**的 ⇒ 让位（`peer-window`）   |
 *   |         | 窗口内最近一次注入是**同一个会话**（无论谁注入的）⇒ 让位（`throttle`）|
 *   | 代理    | 窗口内最近一次注入是**插件**的 ⇒ 让位（`peer-window`）               |
 *   |         | 它自己那套按会话的节流仍然在内存里，本次不改口径                      |
 *
 * 为什么这样就不会同一轮注入两次（这是顺序保证，不是运气）：
 *   同一轮里 **插件先**（`turn/start` 时认领）、**代理后**（请求组装完才转发出去）。
 *   插件认领后回执写着 source=plugin ⇒ 代理看到就必然让位。
 *
 * 三条纪律：
 *   ① **认领是原子的**（`wx` 建锁 + 读改写 + 删锁），不让两边同时写。
 *   ② **拿不到锁 / 写不进去 ⇒ 不要注入**：宁可这一轮不给记忆，也绝不注入两次。
 *   ③ 永不抛回调用方：它跑在转发路径与 turn 路径上。
 *
 * 文件极小（几十字节），一次 turn 只碰一次，读写都是同步的（实测亚毫秒）。
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RECEIPT_FILE = "D:\\MemoryLib\\logs\\inject-receipt.json";
export const DEFAULT_WINDOW_MS = 60_000;
export const LOCK_STALE_MS = 2_000;
/** 认领锁最多等这么久（1 毫秒一轮 × 10 次）。超时就当没抢到 ⇒ 这轮不注入。 */
export const LOCK_RETRIES = 10;
export const LOCK_WAIT_MS = 1;

export const SOURCE_PLUGIN = "plugin";
export const SOURCE_PROXY = "proxy";

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* 退化：1ms 级忙等，可忽略 */
    }
  }
}

export function emptyReceipt() {
  return { version: 1, last: null, updated_at: null };
}

function normalize(raw) {
  const last = raw?.last;
  if (!last || typeof last !== "object") return emptyReceipt();
  return {
    version: 1,
    last: {
      at: typeof last.at === "string" ? last.at : null,
      source: last.source === SOURCE_PROXY ? SOURCE_PROXY : SOURCE_PLUGIN,
      conversationId: typeof last.conversationId === "string" ? last.conversationId : null,
      chars: Number(last.chars ?? 0) || 0,
      ids: Array.isArray(last.ids) ? last.ids.slice(0, 8) : [],
    },
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

/** 读回执。**永不抛**：文件不在 / 坏了 / 无权读，都当成"空回执"。 */
export function readReceipt(file = DEFAULT_RECEIPT_FILE) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return emptyReceipt();
  }
}

/** 回执里"最近一次注入"距今多少毫秒；没有记录返回 null。 */
export function receiptAgeMs(receipt, now = Date.now()) {
  const at = receipt?.last?.at ? Date.parse(receipt.last.at) : NaN;
  return Number.isFinite(at) ? now - at : null;
}

/** 纯判定：不给文件加锁也不写，只回答"这次该不该让位"。 */
export function decideClaim(receipt, { source = SOURCE_PLUGIN, conversationId = null, now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const age = receiptAgeMs(receipt, now);
  if (age == null || age >= windowMs) return { allow: true, blockedBy: null, reason: "窗口空闲" };
  const last = receipt.last;
  const ageText = `${Math.round(age / 1000)}s 前`;
  const who = last.source === SOURCE_PROXY ? "代理" : "插件";
  if (source === SOURCE_PROXY) {
    // 代理只让位给插件（它自己那套按会话的节流仍在内存里）
    if (last.source === SOURCE_PLUGIN) return { allow: false, blockedBy: "peer-window", reason: `插件 ${ageText}刚注入过（代理让位）` };
    return { allow: true, blockedBy: null, reason: "窗口内只有代理自己的注入，按代理自己的节流口径处理" };
  }
  // 插件
  if (last.source === SOURCE_PROXY) return { allow: false, blockedBy: "peer-window", reason: `代理 ${ageText}刚注入过（插件让位）` };
  if (conversationId && last.conversationId === conversationId) {
    return { allow: false, blockedBy: "throttle", reason: `同一会话 ${ageText}刚注入过，未到 ${Math.round(windowMs / 1000)}s` };
  }
  return { allow: true, blockedBy: null, reason: `窗口内只有别的会话（${last.conversationId ?? "?"}）注入过` };
}

function acquire(file, { retries = LOCK_RETRIES, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lockFile = `${file}.lock`;
  for (let i = 0; i < retries; i += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return lockFile;
    } catch (e) {
      if (e?.code !== "EEXIST") return null; // 目录不存在之类：认领失败，别死磕
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        /* 刚被别人删了：继续重试 */
      }
      sleepSync(waitMs);
    }
  }
  return null;
}

function release(lockFile) {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 这一轮能不能由 `source` 注入；能就顺手把回执写成"我刚注入过"。
 * @returns {{allowed: boolean, blockedBy: string|null, reason: string, receipt: object}}
 */
export function claimReceipt(file = DEFAULT_RECEIPT_FILE, options = {}) {
  const { source = SOURCE_PLUGIN, conversationId = null, chars = 0, ids = [], now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = options;
  const before = readReceipt(file);
  const early = decideClaim(before, { source, conversationId, now, windowMs });
  if (!early.allow) return { allowed: false, allow: false, ...early, receipt: before };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 目录建不了：下面 openSync 会失败，走 fail-closed */
  }
  const lockFile = acquire(file);
  if (!lockFile) {
    return { allowed: false, allow: false, blockedBy: "receipt-busy", reason: "注入回执的锁没抢到（宁可这轮不注入，也不注入两次）", receipt: before };
  }
  try {
    // 拿到锁以后**复核一遍**：可能就在这几毫秒里另一边写进去了
    const current = readReceipt(file);
    const again = decideClaim(current, { source, conversationId, now, windowMs });
    if (!again.allow) return { allowed: false, allow: false, ...again, reason: `${again.reason}（复核对上）`, receipt: current };

    const next = {
      version: 1,
      last: {
        at: new Date(now).toISOString(),
        source,
        conversationId: conversationId ?? null,
        chars: Number(chars) || 0,
        ids: Array.isArray(ids) ? ids.slice(0, 8) : [],
      },
      updated_at: new Date(now).toISOString(),
    };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return { allowed: true, allow: true, blockedBy: null, reason: "窗口空闲，认领成功", receipt: next };
  } catch (e) {
    return { allowed: false, allow: false, blockedBy: "receipt-io", reason: `回执写不进去（这轮不注入）：${e?.message ?? e}`, receipt: before };
  } finally {
    release(lockFile);
  }
}

/** 只读地看窗口状态（给 status.mjs 用），**不写**。 */
export function inspectReceipt(file = DEFAULT_RECEIPT_FILE, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const receipt = readReceipt(file);
  const ageMs = receiptAgeMs(receipt, now);
  const last = receipt.last;
  return {
    file,
    last,
    ageMs,
    windowMs,
    open: ageMs == null || ageMs >= windowMs,
    lastSource: last?.source ?? null,
    lastConversation: last?.conversationId ?? null,
    lastChars: last?.chars ?? 0,
    lastIds: last?.ids ?? [],
  };
}

/** 清掉回执（测试 / 运维手动解锁用）。 */
export function resetReceipt(file = DEFAULT_RECEIPT_FILE) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(`${file}.lock`, { force: true });
  } catch {
    /* ignore */
  }
  return emptyReceipt();
}
