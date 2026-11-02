#!/usr/bin/env node
/**
 * MAINT10：把生产上那条验收探针标成 deprecated（只发一条 HTTP，重启/改配置一概不碰）。
 *
 *   node .\scripts\maint10-deprecate-probe.mjs                 # 只读预检 + 打印将要发的请求
 *   node .\scripts\maint10-deprecate-probe.mjs --apply         # 真的 deprecate
 *   node .\scripts\maint10-deprecate-probe.mjs --apply --id=别的id
 *
 * 默认目标：deploy15-probe-private
 * 凭据：运行期从 ~\.dsh\profiles\web\cordis.patch.yml 读（不落盘、不打印 secret）。
 * 身份：--agent（默认 admin-01）/ --role（默认 librarian-admin），可覆盖。
 *
 * 验证三段（--apply 时做）：
 *   ① POST /v1/memory/deprecate → 200 且 status=deprecated
 *   ② 落盘 frontmatter 里 status 变成 deprecated（读回来断言）
 *   ③ GET 语义 /v1/get 仍能读到；默认 /v1/search 不再返回它
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.MEMORY_BASE || 'http://127.0.0.1:8787'
const PATCH = 'C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml'
const argOf = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d)
const APPLY = process.argv.includes('--apply')
const ID = argOf('id', 'deploy15-probe-private')
const AGENT = argOf('agent', 'admin-01')
const ROLE = argOf('role', 'librarian-admin')

function creds() {
  const text = readFileSync(PATCH, 'utf8')
  const ref = /X-MCP-Credential-Ref:\s*'([^']+)'/.exec(text)?.[1]
  const secret = /X-MCP-Secret:\s*'([^']+)'/.exec(text)?.[1]
  if (!ref || !secret) throw new Error('credential_ref/secret not found in cordis.patch.yml')
  return { ref, secret }
}

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* keep text */ }
  return { status: res.status, data, text }
}

const { ref, secret } = creds()
const auth = { credential_ref: ref, secret, principal: { agent_id: AGENT, role_id: ROLE } }

console.log(`target   : ${BASE}`)
console.log(`id       : ${ID}`)
console.log(`identity : ${AGENT} / ${ROLE}   (secret ${secret.length} chars, not printed)`)
console.log(`mode     : ${APPLY ? 'APPLY（会改生产）' : 'DRY（只预检，不改任何东西）'}`)

// 预检：确认这条记录现在存在且读得到
const before = await post('/v1/get', { ...auth, id: ID })
console.log(`\n[预检] POST /v1/get → ${before.status}`)
if (before.status !== 200) {
  console.error(`预检失败：/v1/get 读不到 ${ID}（status=${before.status} ${before.text.slice(0, 200)}）`)
  console.error('先确认 id 拼写、以及当前身份是否可见这条记录。')
  process.exit(2)
}

if (!APPLY) {
  console.log('\n将要发送：POST /v1/memory/deprecate  { credential_ref, secret, principal, id }')
  console.log('加 --apply 才会真的执行。')
  process.exit(0)
}

// ① deprecate
const denied = await post('/v1/memory/deprecate', { ...auth, id: ID })
console.log(`\n[①] POST /v1/memory/deprecate → ${denied.status}`)
console.log(`     ${denied.text.slice(0, 300)}`)
if (denied.status !== 200 || denied.data?.ok !== true) {
  console.error('deprecate 失败：若 message 仍是 "buildFrontmatter is not defined"，说明 8787 上跑的还是旧版本（修复未部署）。')
  process.exit(1)
}

// ② 读回 frontmatter
const after = await post('/v1/get', { ...auth, id: ID })
const fm = after.data?.item?.frontmatter ?? after.data?.frontmatter ?? {}
const status = String(fm.status ?? '').replace(/^["']|["']$/g, '')
console.log(`[②] /v1/get → ${after.status}   status=${JSON.stringify(status)}   updatedAt=${JSON.stringify(fm.updatedAt ?? fm.updated_at ?? null)}`)
const okStatus = status === 'deprecated'

// ③ 默认检索不再返回
const search = await post('/v1/search', { ...auth, query: ID, limit: 10, graphExpand: false })
const rows = Array.isArray(search.data?.results) ? search.data.results : []
const stillListed = rows.some((r) => String(r.id ?? r.path ?? '').includes(ID))
console.log(`[③] /v1/search → ${search.status}   命中 ${rows.length} 条   仍返回该 id=${stillListed}`)

console.log(`\n结论：deprecate=${denied.status === 200 ? 'OK' : 'FAIL'}  status=${okStatus ? 'OK' : 'FAIL'}  默认检索已隐藏=${stillListed ? 'NO（仍返回！）' : 'OK'}`)
process.exit(okStatus && !stillListed ? 0 : 1)
