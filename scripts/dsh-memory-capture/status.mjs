#!/usr/bin/env node
/**
 * IN-PLUGIN-1：捕获插件的可见性命令 —— 一条命令回答四个问题：
 *   最近成功时间 / 连续失败数 / 死信条数 / 待发条数
 *
 *   node status.mjs                       # 用人看
 *   node status.mjs --json                # 机器读
 *   node status.mjs --work <dir>          # 指定工作目录（默认 <DSH_HOME>/memory-capture）
 *
 * 只读：不写任何文件、不发网络请求。
 * 退出码：0 = 正常（无死信、无连续失败）；1 = 需要注意（有死信或连续失败）；2 = 读不到状态
 */
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readSnapshot } from "./capture-core.mjs";

// REFINE-TRIGGER-1：同一条命令里也要能看见**提炼**那条线。
// 复用代理那份 refine-trigger.mjs（不另写一套节流/锁口径），模块路径与落点都可用环境变量覆盖。
const REFINE_LOG_DIR = process.env.DSH_REFINE_LOG_DIR ?? "D:\\MemoryLib\\logs";
const REFINE_STATE = process.env.DSH_REFINE_STATE ?? "D:\\MemoryLib\\state\\refine-state.json";
const REFINE_MODULE = process.env.DSH_REFINE_MODULE ?? "D:\\MemoryLib\\scripts\\refine-trigger.mjs";
const REFINE_EVIDENCE = process.env.DSH_REFINE_EVIDENCE ?? "D:\\MemoryLib\\data\\memory\\evidence\\conversations";

// IN-PLUGIN-2：注入那条线。回执是**代理与插件共用**的那一个文件，所以这里看到的就是真实现场。
const INJECT_RECEIPT_MODULE = process.env.DSH_INJECT_RECEIPT_MODULE ?? "D:\\MemoryLib\\scripts\\inject-receipt.mjs";
const INJECT_RECEIPT_FILE = process.env.DSH_INJECT_RECEIPT ?? "D:\\MemoryLib\\logs\\inject-receipt.json";
const INJECT_THROTTLE_MS = Number(process.env.DSH_INJECT_THROTTLE_MS ?? 60_000);

async function refineSnapshot() {
  try {
    const mod = await import(pathToFileURL(REFINE_MODULE).href);
    const p = mod.defaultPaths({ logDir: REFINE_LOG_DIR, stateFile: REFINE_STATE });
    const st = await mod.loadTriggerState(p.triggerStateFile);
    const lock = await mod.inspectLock(p.lockFile);
    const wl = await mod.countWorkload({ stateFile: p.refineStateFile, evidenceDir: REFINE_EVIDENCE });
    return {
      ok: true,
      enabled: st.enabled,
      running: Boolean(lock.exists && !lock.stale),
      lockAgeMs: lock.ageMs ?? 0,
      triggered: st.triggered ?? 0,
      succeeded: st.succeeded ?? 0,
      failed: st.failed ?? 0,
      lastTriggerAt: st.lastTriggerAt ?? null,
      lastSuccessAt: st.lastSuccessAt ?? null,
      lastFailureAt: st.lastFailureAt ?? null,
      lastError: st.lastError ?? null,
      lastReason: st.lastReason ?? null,
      skippedThrottle: st.skippedByThrottle ?? 0,
      skippedLock: st.skippedByLock ?? 0,
      skippedWorkerLock: st.skippedByWorkerLock ?? 0,
      pending: wl.pending ?? null,
      triggerStateFile: p.triggerStateFile,
      lockFile: p.lockFile,
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 只读地用同一套口径拼出注入状态（带解析好的完整记录）。 */
async function injectSnapshot(workDir) {
  try {
    const rcpt = await import(pathToFileURL(INJECT_RECEIPT_MODULE).href);
    const info = rcpt.inspectReceipt(INJECT_RECEIPT_FILE, { windowMs: INJECT_THROTTLE_MS });
    const log = await readLogTail(path.join(workDir, "realtime.log"));
    const counts = { ok: 0, skipped: 0, failed: 0, briefOk: 0, briefFail: 0, empty: 0 };
    const skippedBy = {};
    let lastOk = null;
    let lastBrief = null;
    let lastBriefFail = null;
    let loaded = null;
    for (const line of log.split("\n")) {
      if (!line) continue;
      if (line.includes("inject_ok ")) {
        counts.ok += 1;
        lastOk = parseJsonAfter(line, "inject_ok");
      } else if (line.includes("inject_skipped ")) {
        counts.skipped += 1;
        const rec = parseJsonAfter(line, "inject_skipped");
        const key = rec?.blockedBy ?? "unknown";
        skippedBy[key] = (skippedBy[key] ?? 0) + 1;
      } else if (line.includes("INJECT-BRIEF ok ")) {
        counts.briefOk += 1;
        lastBrief = line.slice(line.indexOf("INJECT-BRIEF ok ") + "INJECT-BRIEF ok ".length).trim();
      } else if (line.includes("INJECT-BRIEF-FAIL")) {
        counts.briefFail += 1;
        counts.failed += 1;
        lastBriefFail = line.slice(line.indexOf("INJECT-BRIEF-FAIL") + "INJECT-BRIEF-FAIL".length).trim();
      } else if (line.includes("INJECT-BRIEF-EMPTY")) {
        counts.empty += 1;
        lastBriefFail = line.slice(line.indexOf("INJECT-BRIEF-EMPTY") + "INJECT-BRIEF-EMPTY".length).trim();
      } else if (line.includes("INFO 捕获插件已加载")) {
        loaded = line.slice(line.indexOf("INFO "));
      }
    }
    return { ok: true, okCount: counts.ok, skipped: counts.skipped, failed: counts.failed, briefOk: counts.briefOk, briefFail: counts.briefFail, empty: counts.empty, skippedBy, lastOk, lastBrief, lastBriefFail, loaded, receipt: info, logFile: path.join(workDir, "realtime.log") };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function parseJsonAfter(line, needle) {
  const i = line.indexOf(`${needle} {`);
  if (i < 0) return null;
  try {
    return JSON.parse(line.slice(i + needle.length + 1));
  } catch {
    return null;
  }
}

/** 只读日志尾巴：最多读最后 512KB，别把 status 变成大文件扫描。 */
async function readLogTail(file, maxBytes = 512 * 1024) {
  try {
    const fsp = await import("node:fs/promises");
    const st = await fsp.stat(file);
    if (st.size <= maxBytes) return await fsp.readFile(file, "utf8");
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      await fh.read(buf, 0, maxBytes, st.size - maxBytes);
      const text = buf.toString("utf8");
      const nl = text.indexOf("\n");
      return nl >= 0 ? text.slice(nl + 1) : text;
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

function human(ms) {
  if (ms == null) return "(还没成功过)";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m 前`;
  return `${(ms / 3_600_000).toFixed(1)}h 前`;
}

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const workDir = arg("work", process.env.INPLUGIN1_WORK_DIR ?? path.join(HOME, "memory-capture"));
const json = process.argv.includes("--json");

const snap = await readSnapshot({ workDir, apiBase: process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787" });
const refine = await refineSnapshot();
const inject2 = await injectSnapshot(workDir);

if (json) {
  process.stdout.write(`${JSON.stringify({ capture: snap, refine, inject: inject2 }, null, 2)}\n`);
} else {
  const ok = snap.dead_letters === 0 && snap.consecutive_failures === 0;
  const lines = [
    "══════ memory-capture（IN-PLUGIN-1 捕获 + REFINE-TRIGGER-1 提炼触发）══════",
    `工作目录        : ${snap.work_dir}`,
    `记忆服务        : ${snap.api_base}`,
    "",
    `最近一次成功    : ${snap.last_success_at ?? "(还没成功过)"}  ${human(snap.last_success_ago_ms)}`,
    `最近一次失败    : ${snap.last_failure_at ?? "(没有失败记录)"}`,
    `连续失败数      : ${snap.consecutive_failures}`,
    `最近失败原因    : ${snap.last_error ?? "(无)"}`,
    "",
    `待发（队列）    : ${snap.pending_queue}`,
    `死信            : ${snap.dead_letters}`,
    `已提交 turn     : ${snap.done_turns}（累计提交成功 ${snap.submitted_total} 次，失败 ${snap.failed_total} 次，死信 ${snap.dead_lettered_total} 条）`,
    `旧版水位档案    : ${snap.legacy_sessions_archived} 个会话（仅供参考，不参与判定）`,
    "",
    "── 提炼（与代理共用同一个 lock 与 trigger 状态文件）──",
  ];
  if (!refine.ok) {
    lines.push(`  读不到提炼状态：${refine.error}`);
  } else {
    lines.push(
      `开关            : ${refine.enabled === false ? "关（DSH_REFINE_ENABLED=off）" : "开"}`,
      `提炼进程在跑吗  : ${refine.running ? `是（锁 ${Math.round(refine.lockAgeMs / 1000)}s 前建立）` : "否"}`,
      `最近触发/成功   : ${refine.lastTriggerAt ?? "—"} / ${refine.lastSuccessAt ?? "—"}`,
      `最近失败        : ${refine.lastFailureAt ?? "—"}${refine.lastError ? `  ${refine.lastError}` : ""}`,
      `本轮决策原因    : ${refine.lastReason ?? "—"}`,
      `待提炼          : ${refine.pending ?? "?"}`,
      `发起 ${refine.triggered} 成功 ${refine.succeeded} 失败 ${refine.failed}`,
      `跳过：节流 ${refine.skippedThrottle} 锁 ${refine.skippedLock} worker被锁 ${refine.skippedWorkerLock}`,
      `状态文件        : ${refine.triggerStateFile}`,
    );
  }
  lines.push(
    "",
    "── 注入（与代理共用同一个注入回执，同一轮只会有一边注入）──",
  );
  if (!inject2.ok) {
    lines.push(`  读不到注入状态：${inject2.error}`);
  } else {
    const r = inject2.receipt;
    const ago = r.ageMs == null ? "从未" : `${Math.round(r.ageMs / 1000)}s 前`;
    lines.push(
      `最近一次注入    : ${r.last?.at ?? "—"}（${ago}）${r.lastSource ? ` by ${r.lastSource === "proxy" ? "代理" : "插件"}` : ""}`,
      `注入窗口        : ${r.open ? "空闲（可以注入）" : `占用中（${Math.round((r.windowMs - r.ageMs) / 1000)}s 后开）`}`,
      `最近注入会话/字数: ${r.lastConversation ?? "—"} / ${r.lastChars} 字`,
      `最近注入命中 id : ${(r.lastIds ?? []).join(", ") || "—"}`,
      `累计：成功 ${inject2.okCount} 跳过 ${inject2.skipped} 失败 ${inject2.failed}（预热成功 ${inject2.briefOk} 失败 ${inject2.briefFail} 空 ${inject2.empty}）`,
      `跳过原因        : ${Object.entries(inject2.skippedBy).map(([k, v]) => `${k} ${v}`).join("  ") || "—"}`,
      `最近预热        : ${inject2.lastBrief ?? inject2.lastBriefFail ?? "—"}`,
      `注入回执文件    : ${r.file}`,
    );
  }
  lines.push("", `判定            : ${ok ? "OK" : "注意"}`);
  if (!ok) {
    lines.push("  ! 有死信或连续失败，去 dead/ 看原因；重发：把 dead/ 里的文件移回 queue/ 后等下一轮（60s）");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

process.exit(snap.dead_letters === 0 && snap.consecutive_failures === 0 ? 0 : 1);
