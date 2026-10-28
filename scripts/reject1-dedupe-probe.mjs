#!/usr/bin/env node
/**
 * 只读探测：拿真实证据目录里一条 dsh-session 条目，验证代理的去重匹配逻辑能否命中它。
 * 不写任何东西。
 *
 *   node scripts/reject1-dedupe-probe.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const EVID = 'D:\\MemoryLib\\data\\memory\\evidence\\conversations'
const WINDOW_MS = 600000

const normalizeText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function sectionText(body, name) {
  const lines = body.split(/\r?\n/)
  const out = []
  let cur = null
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      cur = h[1].trim()
      continue
    }
    if (cur === name) out.push(line)
  }
  return out.join('\n').trim()
}

function meta(file) {
  const md = readFileSync(join(EVID, file), 'utf8')
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(md)
  const fm = {}
  if (fmMatch) for (const line of fmMatch[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, '')
  }
  const body = fmMatch ? fmMatch[2] : md
  const userText = sectionText(body, '用户')
  return {
    file,
    source: fm.source || '',
    capturedAt: fm.capturedAt || '',
    userText,
    userKey: createHash('sha1').update(normalizeText(userText).slice(0, 200)).digest('hex'),
    assistantChars: sectionText(body, '助手').length,
  }
}

const files = readdirSync(EVID).filter((f) => f.endsWith('.md'))
const metas = files.map(meta)

// 找最近的一条 dsh-session（旁路）条目作为「目标 turn」
const dsh = metas.filter((m) => m.source === 'dsh-session' && m.userText.length > 20 && m.assistantChars > 20)
dsh.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
if (!dsh.length) {
  console.log('没有可用的 dsh-session 样本')
  process.exit(2)
}
const target = dsh[0]
console.log(`目标 turn（旁路写的）: ${target.file}`)
console.log(`  source=${target.source}  capturedAt=${target.capturedAt}`)
console.log(`  用户段 ${target.userText.length} 字，助手段 ${target.assistantChars} 字`)
console.log(`  用户段前 60 字: ${JSON.stringify(normalizeText(target.userText).slice(0, 60))}`)

const now = Date.now()
const hits = metas.filter((m) => {
  if (m.userKey !== target.userKey) return false
  if (m.source === 'capture-proxy') return false
  const t = Date.parse(m.capturedAt || 0)
  if (Number.isFinite(t) && now - t > WINDOW_MS) return false
  return true
})
hits.sort((a, b) => b.assistantChars - a.assistantChars)

console.log(`\n按代理同一套逻辑（userKey 匹配 + 仅非 capture-proxy 来源 + ${WINDOW_MS / 60000} 分钟窗口）命中 ${hits.length} 条：`)
for (const h of hits) console.log(`  ${h.file}  source=${h.source}  助手=${h.assistantChars}字`)

// 同一 turn 在两种来源下各有多少条（双写实况）
const dupGroup = metas.filter((m) => m.userKey === target.userKey)
console.log(`\n该 turn 在证据库里共有 ${dupGroup.length} 条：`)
const bySrc = {}
for (const m of dupGroup) bySrc[m.source || '(none)'] = (bySrc[m.source || '(none)'] ?? 0) + 1
for (const [s, n] of Object.entries(bySrc)) console.log(`  ${s.padEnd(20)} ${n} 条`)

const proxyOnes = dupGroup.filter((m) => m.source === 'capture-proxy')
if (proxyOnes.length) {
  const emptyOnes = proxyOnes.filter((m) => m.assistantChars <= 20)
  console.log(`  其中代理写的 ${proxyOnes.length} 条里有 ${emptyOnes.length} 条助手段 ≤20 字（占位）`)
}

console.log(`\n结论：${hits.length > 0 ? 'GREEN 代理会命中该 turn 并让位（不写第二条）' : 'RED 匹配不到，需检查'}`)
process.exit(hits.length > 0 ? 0 : 1)
