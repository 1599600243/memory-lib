#!/usr/bin/env node
/**
 * 诊断：DeepSeek 官方直连支持哪些端点/协议。
 * 决定 MAINPATH-1 的验证套件该测 completions 还是 responses。
 *
 *   node scripts/probe-deepseek-api.mjs
 *
 * 只发最小请求，不打印任何 key。
 */
import { readFileSync } from 'node:fs'

const CREDS = 'C:\\Users\\admin\\.dsh\\.credentials.yaml'
const UP = process.env.PROBE_UPSTREAM || 'https://api.deepseek.com/v1'
const argOf = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d)
const MODEL = argOf('model', 'deepseek-flash')
const KEY_ENV = argOf('key-env', 'DEEPSEEK_API_KEY')

function apiKey(name = KEY_ENV) {
  const text = readFileSync(CREDS, 'utf8')
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(name + ':'))
  if (!line) throw new Error(`${name} not found`)
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
}

async function hit(label, path, body) {
  const t0 = Date.now()
  try {
    const res = await fetch(UP + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    const text = await res.text()
    console.log(`\n[${label}] POST ${path}`)
    console.log(`  status=${res.status}  bytes=${text.length}  ${Date.now() - t0}ms`)
    console.log(`  content-type=${res.headers.get('content-type')}`)
    console.log(`  head=${text.slice(0, 260).replace(/\n/g, '\\n')}`)
    return { status: res.status, text }
  } catch (e) {
    console.log(`\n[${label}] POST ${path}  CRASHED: ${e.message}`)
    return { status: 0, text: '' }
  }
}

console.log(`upstream=${UP}`)
console.log(`key=${KEY_ENV} len=${apiKey().length} model=${MODEL}`)

// 1) responses 端点（旧上游走这个，DeepSeek 未必有）
await hit('responses', '/responses', {
  model: MODEL,
  stream: false,
  max_output_tokens: 32,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
})

// 2) completions 端点 非流式
await hit('completions-nostream', '/chat/completions', {
  model: MODEL,
  stream: false,
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hi' }],
})

// 3) completions 端点 流式（生产路径）
const s = await hit('completions-stream', '/chat/completions', {
  model: MODEL,
  stream: true,
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hi' }],
})
if (s.status === 200) {
  const deltas = [...s.text.matchAll(/"delta":\{"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  console.log(`  stream delta 事件数=${deltas.length} 累积="${deltas.join('')}"`)
  console.log(`  含 [DONE] 终止符=${s.text.includes('[DONE]')}`)
}

// 4) 上下文/上限探测：问模型自己（不可靠，仅参考）—— 跳过，靠 settings 显式声明
console.log('\nDONE')
