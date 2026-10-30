#!/usr/bin/env node
// 诊断：列出上游可用模型（明文 key 不落盘，只从 credentials 运行时读）。
// 用法：node scripts/probe-upstream-models.mjs [--via proxy|direct] [--upstream URL]
import { readFileSync } from 'node:fs'

const CREDS = 'C:\\Users\\admin\\.dsh\\.credentials.yaml'
const via = process.argv.includes('--via')
  ? process.argv[process.argv.indexOf('--via') + 1]
  : 'direct'
const upstream = process.argv.includes('--upstream')
  ? process.argv[process.argv.indexOf('--upstream') + 1]
  : 'https://blackaicoding.com/v1'
const keyName = process.argv.includes('--key')
  ? process.argv[process.argv.indexOf('--key') + 1]
  : 'BLACKAI_GPT_API_KEY'

const text = readFileSync(CREDS, 'utf8')
const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(keyName + ':'))
if (!line) {
  console.error(`FATAL: ${keyName} not found`)
  process.exit(2)
}
const key = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
console.log(`key=${keyName} len=${key.length} via=${via} upstream=${upstream}`)

const url = via === 'proxy' ? 'http://127.0.0.1:8899/v1/models' : upstream.replace(/\/$/, '') + '/models'
console.log(`GET ${url}`)
const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000) })
const body = await res.text()
console.log(`status=${res.status}`)
try {
  const j = JSON.parse(body)
  const ids = (j.data || []).map((m) => m.id)
  console.log(`models(${ids.length}): ${ids.join(', ')}`)
} catch {
  console.log(body.slice(0, 800))
}
