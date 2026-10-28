#!/usr/bin/env node
// DOC-1-REJECT1 ①：把「问某一天返回几条」实测一次，作为清单 ①.1 的来源。
// 只读：POST /v1/search（空 query + calendarDate），不写任何东西。
import { readFileSync } from 'node:fs'

const BASE = process.env.MEMORY_BASE || 'http://127.0.0.1:8787'
const PATCH = 'C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml'
const text = readFileSync(PATCH, 'utf8')
const ref = /X-MCP-Credential-Ref:\s*'([^']+)'/.exec(text)?.[1]
const secret = /X-MCP-Secret:\s*'([^']+)'/.exec(text)?.[1]
const principal = { agent_id: process.env.AGENT || 'admin-01', role_id: process.env.ROLE || 'librarian-admin' }
const DATES = ['2026-10-04', '2026-10-10']

console.log(`now(UTC)   : ${new Date().toISOString()}`)
console.log(`target     : ${BASE}`)
console.log(`identity   : ${principal.agent_id}/${principal.role_id}`)
console.log(`口径       : POST /v1/search  query=""（空） + calendarDate=<该本地日>  ⇒ 该自然日枚举到的条目数`)
console.log('')

for (const calendarDate of DATES) {
  const body = { credential_ref: ref, secret, principal, query: '', calendarDate }
  const t0 = Date.now()
  const res = await fetch(`${BASE}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  const raw = await res.text()
  let data = null
  try { data = JSON.parse(raw) } catch { /* keep raw */ }
  const rows = Array.isArray(data?.results) ? data.results : []
  const ids = rows.map((r) => String(r.id ?? r.path ?? '')).slice(0, 3)
  console.log(`[${calendarDate}] HTTP ${res.status}   ${Date.now() - t0}ms`)
  console.log(`  count=${rows.length}  total_count=${data?.total_count ?? '(无该字段)'}  resolvedRange=${JSON.stringify(data?.resolvedRange ?? null)}`)
  console.log(`  first3=${JSON.stringify(ids)}`)
  // 逐条看一下日期落在哪几天（证明"都是那天的"）
  const days = new Map()
  for (const r of rows) {
    const d = String(r.calendarDate ?? r.capturedAt ?? r.updated_at ?? '').slice(0, 10)
    days.set(d, (days.get(d) ?? 0) + 1)
  }
  console.log(`  按返回条目的日期字段分布: ${JSON.stringify([...days.entries()])}`)
  console.log('')
}
