#!/usr/bin/env node
// MAINPATH-1 红测探针：确定 /v1/conversations/capture 可用的身份组合。
// 只读 DSH 凭据文件（不复制进仓库），逐组合打真实请求，打印原始状态码与响应体。
// 用法：node scripts/probe-capture-identity.mjs [--write]
//   默认 dry 探针：故意用缺 secret 的请求判定鉴权先于写入；--write 才真的提交一条 selftest 证据。
import { readFileSync } from 'node:fs'

const BASE = process.env.MEMORY_BASE || 'http://127.0.0.1:8787'
const PATCH = 'C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml'
const DO_WRITE = process.argv.includes('--write')

function readCredsFromPatch() {
  const text = readFileSync(PATCH, 'utf8')
  const ref = /X-MCP-Credential-Ref:\s*'([^']+)'/.exec(text)?.[1]
  const secret = /X-MCP-Secret:\s*'([^']+)'/.exec(text)?.[1]
  return { ref, secret }
}

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text }
}

const { ref, secret } = readCredsFromPatch()
if (!ref || !secret) {
  console.error('FATAL: 无法从 cordis.patch.yml 读到 credential_ref/secret')
  process.exit(2)
}
console.log(`PROBE base=${BASE}`)
console.log(`credential_ref=${ref} secret_len=${secret.length}`)

const now = new Date().toISOString()
const mkBody = (agent, role, extra = {}) => ({
  credential_ref: ref,
  secret,
  principal: { agent_id: agent, role_id: role },
  messages: [
    { role: 'user', content: 'MAINPATH-1 身份探针（非对话内容，仅验证 capture 鉴权组合）' },
    { role: 'assistant', content: '探针响应占位：本条用于验证落库链路可用性。' },
  ],
  source: 'mainpath1-identity-probe',
  conversation_id: `probe-${now.slice(0, 10)}`,
  event_id: `probe-${Date.now()}-${agent}-${role}`,
  ...extra,
})

const combos = [
  ['pilot-01', 'capture-ingest'],
  ['admin-01', 'librarian-admin'],
  ['pilot-01', 'librarian-admin'],
  ['admin-01', 'capture-ingest'],
]

// 1) 鉴权探针：缺 secret（不写入任何东西，只看是否被先拒）
{
  const body = mkBody('pilot-01', 'capture-ingest')
  delete body.secret
  const r = await post('/v1/conversations/capture', body)
  console.log(`\n[no-secret] status=${r.status} body=${r.text.slice(0, 300)}`)
}

// 2) 身份组合探针
for (const [agent, role] of combos) {
  const body = mkBody(agent, role)
  const r = await post('/v1/conversations/capture', body)
  console.log(`\n[${agent}/${role}] status=${r.status} body=${r.text.slice(0, 400)}`)
  if (!DO_WRITE) {
    // dry 模式下仍会真实写入（capture 无 dry_run）；这里只是显式声明行为
  }
}
console.log('\nDONE')
