#!/usr/bin/env node
/**
 * MAINPATH-1-REJECT1 证据面分析：把双写、占位、配对一次性摊开。
 *
 *   node scripts/reject1-analyze-evidence.mjs [--since 2026-10-19T03:50] [--json]
 *
 * 输出：
 *   1. 按 source 分组计数
 *   2. capture-proxy 里 assistant 段为占位的条数与文件名
 *   3. 同一轮在两来源下的配对情况（按 calendarDate + 内容指纹近似配对）
 *   4. dsh-session 条目的 front-matter 字段（看它有没有 turn/sessionId 可用于去重）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const EVID = 'D:\\MemoryLib\\data\\memory\\evidence\\conversations'
const argOf = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d)
const SINCE = argOf('since', '2026-10-19T03:50:00Z')
const sinceMs = new Date(SINCE).getTime()

function parse(file) {
  const md = readFileSync(join(EVID, file), 'utf8')
  const fm = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(md)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, '')
    }
  }
  const body = m ? m[2] : md
  // 分段
  const sections = {}
  let cur = null
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) {
      cur = h[1].trim()
      sections[cur] = sections[cur] ?? []
    } else if (cur) {
      sections[cur].push(line)
    }
  }
  const text = (k) => (sections[k] ?? []).join('\n').trim()
  return {
    file,
    fm,
    userText: text('用户'),
    assistantText: text('助手'),
    sectionNames: Object.keys(sections),
  }
}

const files = readdirSync(EVID).filter((f) => f.endsWith('.md'))
const all = files.map(parse)

const inWindow = all.filter((r) => {
  const t = r.fm.capturedAt ? new Date(r.fm.capturedAt).getTime() : 0
  return t >= sinceMs
})

const placeholder = (r) => r.assistantText.includes('［未取到') || r.assistantText === ''

const bySource = {}
for (const r of all) {
  const s = r.fm.source || '(none)'
  bySource[s] = (bySource[s] ?? 0) + 1
}

console.log(`════ 全库 ${all.length} 条 · 窗口(>=${SINCE}) ${inWindow.length} 条 ════\n`)

console.log('── 按 source 计数（全库）──')
for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(28)} ${n}`)

console.log('\n── 窗口内 按 source 计数 ──')
const winBySource = {}
for (const r of inWindow) {
  const s = r.fm.source || '(none)'
  winBySource[s] = (winBySource[s] ?? 0) + 1
}
for (const [s, n] of Object.entries(winBySource).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(28)} ${n}`)

const proxyWin = inWindow.filter((r) => r.fm.source === 'capture-proxy')
const proxyEmpty = proxyWin.filter(placeholder)
console.log(`\n── capture-proxy 窗口内：${proxyWin.length} 条，其中 assistant 占位/空 ${proxyEmpty.length} 条 ──`)
console.log(`   empty 占比 = ${proxyWin.length ? ((proxyEmpty.length / proxyWin.length) * 100).toFixed(1) : 0}%`)
if (proxyEmpty.length) {
  console.log('   最近 5 条占位:')
  for (const r of proxyEmpty.slice(-5)) console.log(`     ${r.file}  userChars=${r.userText.length} sections=[${r.sectionNames.join(',')}]`)
}

console.log('\n── dsh-session 条目的 front-matter 字段（看有无 turn 标识可去重）──')
const dshWin = inWindow.filter((r) => (r.fm.source || '').includes('dsh-session'))
if (dshWin.length) {
  const sample = dshWin[dshWin.length - 1]
  console.log(`   sample=${sample.file}`)
  for (const [k, v] of Object.entries(sample.fm)) console.log(`     ${k}: ${String(v).slice(0, 80)}`)
  console.log(`   sections=[${sample.sectionNames.join(',')}]`)
  console.log(`   助手段长度=${sample.assistantText.length} 用户段长度=${sample.userText.length}`)
  const withPlaceholder = dshWin.filter(placeholder).length
  console.log(`   dsh-session 窗口内占位数=${withPlaceholder}/${dshWin.length}`)
} else {
  console.log('   （窗口内没有 dsh-session 条目）')
}

// 配对：用 user 文本前 60 字做键
console.log('\n── 同轮配对（user 文本前 60 字 + calendarDate）──')
const keyOf = (r) => `${r.fm.calendarDate}|${r.userText.slice(0, 60)}`
const groups = new Map()
for (const r of inWindow) {
  if (!r.userText) continue
  const k = keyOf(r)
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r)
}
let dupPairs = 0
for (const [k, rs] of groups) {
  const srcs = new Set(rs.map((r) => r.fm.source))
  if (rs.length > 1 && srcs.size > 1) {
    dupPairs += 1
    if (dupPairs <= 6) {
      console.log(`\n   [同轮双写] user="${k.split('|')[1]}..."`)
      for (const r of rs) {
        console.log(
          `     ${r.fm.source.padEnd(16)} ${r.file}  user=${r.userText.length} assistant=${r.assistantText.length}${placeholder(r) ? ' <占位>' : ''}`,
        )
      }
    }
  }
}
console.log(`\n   同轮跨来源重复组数 = ${dupPairs}`)

if (process.argv.includes('--json')) {
  console.log('\n' + JSON.stringify({ total: all.length, window: inWindow.length, bySource, winBySource, proxyWin: proxyWin.length, proxyEmpty: proxyEmpty.length, dupPairs }, null, 2))
}
