#!/usr/bin/env node
/**
 * MAINPATH-2 一条命令看清「提炼这条线还活着吗」。
 *
 *   node scripts/refine-status.mjs
 *   node scripts/refine-status.mjs --json
 *   node scripts/refine-status.mjs --logdir D:\MemoryLib\logs --state D:\MemoryLib\state\refine-state.json
 *
 * 为什么要有它：提炼现在活在代理里（不再是谁记得手动跑），那就必须能一眼回答
 * 「它还在跑吗 / 上次成功是什么时候 / 待提炼多少 / 失败多少 / 死信多少」——
 * 否则"旁路静默死"这个病只是换了个地方复发。
 *
 * 退出码（可直接进告警/CI）：
 *   0 = 健康（开着、没卡住、没有死信堆积）
 *   1 = 有问题（关掉了 / 锁卡住太久 / 有死信 / 最近失败且后来没成功）
 *   2 = 还没跑过（状态文件不存在，通常代表代理没起来过）
 */
import fs from "node:fs/promises";
import path from "node:path";

import { loadState, summarizeState } from "./refine-worker.mjs";
import { defaultPaths, loadTriggerState, inspectLock, countPendingFromState, LOCK_STALE_MS } from "./refine-trigger.mjs";

function argOf(argv, name, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

function msAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = now - t;
  if (d < 0) return `${Math.round(-d / 1000)}s 后（时钟偏差？）`;
  if (d < 60_000) return `${Math.round(d / 1000)}s 前`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m 前`;
  return `${(d / 3_600_000).toFixed(1)}h 前`;
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const stateFile = argOf(argv, "state", "D:\\MemoryLib\\state\\refine-state.json");
  const logDir = argOf(argv, "logdir", "D:\\MemoryLib\\logs");
  const evidenceDir = argOf(argv, "evidence", "D:\\MemoryLib\\data\\memory\\evidence\\conversations");
  const asJson = json;

  const paths = defaultPaths({ logDir, stateFile });
  const trigger = await loadTriggerState(paths.triggerStateFile);
  const lock = await inspectLock(paths.lockFile);
  const pendingFromTrigger = await countPendingFromState(stateFile);

  let summary = null;
  try {
    const state = await loadState(stateFile);
    let evidenceTotal = null;
    try {
      evidenceTotal = (await fs.readdir(evidenceDir)).filter((n) => n.endsWith(".md")).length;
    } catch {
      evidenceTotal = null;
    }
    summary = summarizeState(state, { evidenceTotal });
  } catch {
    summary = null;
  }

  const workerLogExists = await fs
    .readFile(paths.workerLogFile, "utf8")
    .then(() => true)
    .catch(() => false);

  const enabled = trigger.enabled === null || trigger.enabled === undefined ? null : Boolean(trigger.enabled);
  const running = lock.exists && !lock.stale;
  const lockStuck = lock.exists && lock.stale;

  const payload = {
    refine: {
      enabled, // true=代理会在落库后自动触发；false=手动模式
      raw: trigger.enabled === null ? "未记录（代理还没起来过）" : enabled ? "on" : "off",
      running,
      lockAgeMs: lock.ageMs,
      lockStuck,
      lastTriggerAt: trigger.lastTriggerAt ?? null,
      lastTriggerAgo: msAgo(trigger.lastTriggerAt),
      lastSuccessAt: trigger.lastSuccessAt ?? null,
      lastSuccessAgo: msAgo(trigger.lastSuccessAt),
      lastFailureAt: trigger.lastFailureAt ?? null,
      lastError: trigger.lastError ?? null,
      lastReason: trigger.lastReason ?? null,
      triggered: trigger.triggered ?? 0,
      succeeded: trigger.succeeded ?? 0,
      failed: trigger.failed ?? 0,
      timedOut: trigger.timedOut ?? 0,
      skipped: {
        throttle: trigger.skippedByThrottle ?? 0,
        lock: trigger.skippedByLock ?? 0,
        workerLock: trigger.skippedByWorkerLock ?? 0,
        noPending: trigger.skippedByNoPending ?? 0,
        disabled: trigger.skippedByDisabled ?? 0,
      },
      workerLogFile: paths.workerLogFile,
      workerLogExists,
      triggerStateFile: paths.triggerStateFile,
    },
    pending: summary
      ? {
          source: "refine-state",
          evidence_total: summary.evidence_total,
          pending: summary.pending,
          done: summary.done,
          failed: summary.failed,
          dead: summary.dead,
          skipped: summary.skipped,
          last_success_at: summary.last_success_at,
          last_run_at: summary.last_run_at,
          last_run_order: summary.last_run?.order ?? null,
          failure_reasons: summary.failure_reasons,
        }
      : {
          source: "refine-state（读不到，改用兜底口径）",
          evidence_total: null,
          pending: pendingFromTrigger.pending,
          done: pendingFromTrigger.done,
          failed: pendingFromTrigger.failed,
          dead: pendingFromTrigger.dead,
          skipped: pendingFromTrigger.skipped,
          last_success_at: pendingFromTrigger.last_success_at ?? null,
          last_run_at: pendingFromTrigger.last_run_at ?? null,
          failure_reasons: {},
        },
    health: null,
    verdict: null,
  };

  // 判定：能直接进告警的五档
  const problems = [];
  if (enabled === null) problems.push("代理还没起来过（没有提炼触发状态文件）");
  else if (enabled === false) problems.push("提炼触发已关闭（--refine=off）⇒ 现在是手动模式，新对话不会被提炼");
  if (lockStuck) problems.push(`锁卡住 ${Math.round(lock.ageMs / 60000)} 分钟（超过 ${LOCK_STALE_MS / 60000} 分钟视为残留）`);
  if (payload.pending.dead > 0) problems.push(`有 ${payload.pending.dead} 条死信，需要 --requeue-dead 或人工判断`);
  if (trigger.lastFailureAt && (!trigger.lastSuccessAt || Date.parse(trigger.lastFailureAt) > Date.parse(trigger.lastSuccessAt))) {
    problems.push(`最近一次失败之后没有成功过：${trigger.lastError ?? ""}`);
  }
  if (payload.pending.pending > 0 && !running && enabled) {
    problems.push(`有 ${payload.pending.pending} 条待提炼且当前没有提炼进程在跑（等下一次对话或手动跑一遍）`);
  }

  payload.health = problems.length ? "attention" : "ok";
  payload.verdict = problems.length ? { level: "ATTENTION", problems } : { level: "OK", problems: [] };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(payload.health === "ok" ? 0 : 1);
  }

  const p = payload.refine;
  const q = payload.pending;
  const lines = [
    "══════ 提炼（MAINPATH-2：活在捕获代理里）══════",
    `模式            : ${enabled === null ? "未知（代理还没起来过）" : enabled ? "自动（落库后自动触发）" : "手动（--refine=off）"}`,
    `提炼进程在跑吗  : ${running ? `是（锁 ${Math.round(lock.ageMs / 1000)}s 前建立）` : lockStuck ? `否，但留有 ${Math.round(lock.ageMs / 60000)} 分钟前的残留锁` : "否"}`,
    `最近一次触发    : ${p.lastTriggerAt ? `${p.lastTriggerAt}（${p.lastTriggerAgo}）` : "（还没触发过）"}`,
    `最近一次成功    : ${p.lastSuccessAt ? `${p.lastSuccessAt}（${p.lastSuccessAgo}）` : "（还没有成功的触发）"}`,
    `最近一次失败    : ${p.lastFailureAt ? `${p.lastFailureAt}  ${p.lastError ?? ""}` : "（没有失败记录）"}`,
    `本轮决策原因    : ${p.lastReason ?? "（无）"}`,
    "",
    "── 待办（口径与 refine-worker --status 一致）──",
    `证据总数        : ${q.evidence_total ?? "(未统计)"}`,
    `待提炼          : ${q.pending}`,
    `已提炼          : ${q.done}`,
    `失败（会重试）  : ${q.failed}`,
    `死信            : ${q.dead}`,
    `跳过（太短等）  : ${q.skipped}`,
    `库里最近成功    : ${q.last_success_at ?? "(还没有成功的提炼轮次)"}`,
    `上一轮排序      : ${
      q.last_run_order
        ? `newest-first=${q.last_run_order.newestFirst ? "on" : "off"} old-quota=${q.last_run_order.oldQuota}（${q.last_run_order.newSlots} 新 : ${q.last_run_order.oldSlots} 老）`
        : "(还没跑过)"
    }`,
    "",
    "── 触发累计 ──",
    `发起 ${p.triggered}  成功 ${p.succeeded}  失败 ${p.failed}  超时 ${p.timedOut}`,
    `跳过：节流 ${p.skipped.throttle}  锁 ${p.skipped.lock}  worker被锁跳过 ${p.skipped.workerLock}  无待办 ${p.skipped.noPending}  已关闭 ${p.skipped.disabled}`,
    `worker 日志      : ${p.workerLogFile}${p.workerLogExists ? "" : "（还没有这个文件）"}`,
  ];
  const reasons = Object.entries(q.failure_reasons ?? {});
  if (reasons.length) {
    lines.push("", "失败原因：");
    for (const [reason, count] of reasons) lines.push(`  ×${count}  ${reason}`);
  }
  lines.push("");
  if (problems.length) {
    lines.push("判定：ATTENTION");
    for (const item of problems) lines.push(`  ! ${item}`);
  } else {
    lines.push("判定：OK");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(payload.health === "ok" ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`refine-status 失败：${e?.stack ?? e}\n`);
  process.exit(1);
});
