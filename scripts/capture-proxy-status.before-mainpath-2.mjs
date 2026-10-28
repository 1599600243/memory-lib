#!/usr/bin/env node
/**
 * MAINPATH-1 可见性工具：一眼看出「最近 N 分钟有没有**真的有正文**地落库」。
 *
 *   node scripts/capture-proxy-status.mjs                  # 最近 15 分钟
 *   node scripts/capture-proxy-status.mjs --minutes 5
 *   node scripts/capture-proxy-status.mjs --minutes 60 --verbose
 *
 * ── REJECT1 ② 三档判据 ────────────────────────────────────────────
 *   capture_ok     落库且 assistant 正文非空
 *   capture_empty  该轮结束但没有正文（工具轮/被截断）——**不写占位证据**，只计数
 *   capture_failed 上游非 2xx、或写入失败
 *   （辅助）capture_deduped  同一 turn 已被其它来源覆盖，让位不写；不计入分母
 *
 *   分母 total = ok + empty + failed（deduped 不计）
 *   RED    : ok==0，或 empty>=50%，或 failed>=20%
 *   YELLOW : empty>=阈值（默认 20%），或 failed>0
 *   GREEN  : ok>0 且 empty<阈值 且 failed==0
 *
 * 退出码：0=GREEN  1=RED  2=YELLOW  3=日志不存在
 *   —— 只要不是 GREEN，exit 就非 0（可用于告警/CI 卡口）。
 */
import { readFileSync, existsSync } from 'node:fs'

function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const LOG_FILE = argOf('log', process.env.CAPTURE_PROXY_LOG || 'D:\\MemoryLib\\logs\\capture-proxy.log')
const MINUTES = Number(argOf('minutes', 15))
const EMPTY_MAX = Number(argOf('empty-ratio-max', process.env.CAPTURE_PROXY_EMPTY_RATIO_MAX || 0.2))
const VERBOSE = process.argv.includes('--verbose')
const since = Date.now() - MINUTES * 60 * 1000

if (!existsSync(LOG_FILE)) {
  console.error(`STATUS: NO_LOG (${LOG_FILE} 不存在——代理从未启动过)`)
  process.exit(3)
}

const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
const win = []
for (const line of lines) {
  try {
    const rec = JSON.parse(line)
    if (new Date(rec.ts).getTime() >= since) win.push(rec)
  } catch {
    /* 跳过坏行 */
  }
}

const count = (ev) => win.filter((r) => r.event === ev)
const ok = count('capture_ok')
const empty = count('capture_empty')
const failed = win.filter((r) => r.event === 'capture_failed' || r.event === 'capture_throw')
const deduped = count('capture_deduped')
const toolRounds = count('turn_tool_round')
const fwd = count('forward_ok')
const upErr = win.filter((r) => r.event === 'upstream_error' || r.event === 'upstream_res_error')

const total = ok.length + empty.length + failed.length
const emptyRatio = total ? empty.length / total : 0
const failRatio = total ? failed.length / total : 0

let level
let reason
if (total === 0) {
  level = 'RED'
  reason = '窗口内没有任何落库尝试'
} else if (ok.length === 0) {
  level = 'RED'
  reason = `capture_ok=0（empty=${empty.length} failed=${failed.length}）`
} else if (emptyRatio >= 0.5) {
  level = 'RED'
  reason = `empty 占比 ${(emptyRatio * 100).toFixed(1)}% ≥ 50%`
} else if (failRatio >= 0.2) {
  level = 'RED'
  reason = `failed 占比 ${(failRatio * 100).toFixed(1)}% ≥ 20%`
} else if (emptyRatio >= EMPTY_MAX) {
  level = 'YELLOW'
  reason = `empty 占比 ${(emptyRatio * 100).toFixed(1)}% ≥ 阈值 ${(EMPTY_MAX * 100).toFixed(0)}%`
} else if (failed.length > 0) {
  level = 'YELLOW'
  reason = `capture_failed=${failed.length}`
} else {
  level = 'GREEN'
  reason = `ok=${ok.length} empty=${empty.length} failed=${failed.length}`
}

const allRecs = lines
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)
const lastOk = allRecs.filter((r) => r.event === 'capture_ok').pop()

console.log(`══════ capture-proxy 最近 ${MINUTES} 分钟 ══════`)
console.log(`判定            : ${level}   （${reason}）`)
console.log(`转发成功        : ${fwd.length} 条`)
console.log(`工具轮          : ${toolRounds.length} 轮   （只累积，不落库）`)
console.log(`落库成功        : ${ok.length} 条   capture_ok（有正文）`)
console.log(`空轮            : ${empty.length} 条   capture_empty（无正文，未写证据）`)
console.log(`落库失败        : ${failed.length} 条   capture_failed`)
console.log(`让位去重        : ${deduped.length} 条   capture_deduped（其它来源已覆盖）`)
console.log(`empty 占比      : ${(emptyRatio * 100).toFixed(1)}%   （分母=ok+empty+failed=${total}，阈值 ${(EMPTY_MAX * 100).toFixed(0)}%）`)
console.log(`上游错误        : ${upErr.length} 条`)
console.log(
  `最后一次成功    : ${lastOk ? `${lastOk.ts}  evidenceId=${lastOk.evidenceId ?? '-'}  assistantChars=${lastOk.assistantChars ?? '-'}` : '（全日志无成功记录）'}`,
)

if (failed.length) {
  console.log(`\n最近失败原因:`)
  for (const f of failed.slice(-5)) console.log(`  ${f.ts}  ${f.reason ?? f.error ?? ''}`)
}
if (empty.length) {
  console.log(`\n最近空轮原因:`)
  for (const s of empty.slice(-5)) console.log(`  ${s.ts}  ${s.reason ?? ''}  rounds=${s.rounds ?? '-'} toolRounds=${s.toolRounds ?? '-'}`)
}
if (deduped.length) {
  console.log(`\n最近让位原因:`)
  for (const d of deduped.slice(-5)) console.log(`  ${d.ts}  winner=${d.winner ?? '-'} (${d.winnerSource ?? '-'}) ${d.winnerAssistantChars}≥${d.ourAssistantChars}`)
}

if (VERBOSE) {
  console.log(`\n── 窗口内全部记录 ──`)
  for (const r of win) {
    const detail = r.evidenceId || r.error || r.reason || r.extractNote || ''
    console.log(`${r.ts}  ${r.reqId ?? '-'}  ${r.event}  ${r.path ?? ''}  ${detail}`)
  }
}

process.exit(level === 'GREEN' ? 0 : level === 'YELLOW' ? 2 : 1)
