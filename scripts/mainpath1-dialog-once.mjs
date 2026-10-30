#!/usr/bin/env node
/**
 * MAINPATH-1 端到端一次性验证：经代理跑「一轮真实对话」，并打出全部可核证据。
 *
 *   node scripts/mainpath1-dialog-once.mjs
 *
 * 证据输出：
 *   1. 对话前后 data/memory/evidence/conversations 的 .md 条数
 *   2. 代理日志里对应的 capture_ok 行（本脚本请求的 reqId 窗口）
 *   3. 新证据文件的绝对路径与其内文（user/assistant 两段是否都在）
 *   4. 上游真实返回的正文（证明这轮对话真的发生过，不是伪造）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import http from 'node:http'

const CREDS = 'C:\\Users\\admin\\.dsh\\.credentials.yaml'
const EVID = 'D:\\MemoryLib\\data\\memory\\evidence\\conversations'
const LOG = 'D:\\MemoryLib\\logs\\capture-proxy.log'
const PROXY_PORT = Number(process.env.PROXY_PORT || 8899)
const MODEL = process.env.VERIFY_MODEL || 'deepseek-flash'
const KEY_ENV = process.env.VERIFY_KEY_ENV || 'DEEPSEEK_API_KEY'

const PROMPT =
  '用一句话（不超过 40 字）说明：在 DSH 与模型服务之间插一个本地代理来捕获对话，为什么比插件旁路更可靠。'

function apiKey(name = KEY_ENV) {
  const text = readFileSync(CREDS, 'utf8')
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(name + ':'))
  if (!line) throw new Error(`${name} not found`)
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
}

const countEvidence = () => readdirSync(EVID).filter((f) => f.endsWith('.md')).length

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const before = countEvidence()
  const logBefore = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0
  console.log(`T0  evidenceMdFiles=${before}  logLines=${logBefore}`)
  console.log(`PROMPT: ${PROMPT}`)

  // 一轮真实对话：completions API + SSE 流式（DeepSeek 直连的生产协议）
  const payload = JSON.stringify({
    model: MODEL,
    stream: true,
    max_tokens: 512,
    messages: [{ role: 'user', content: PROMPT }],
  })

  const t0 = Date.now()
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${apiKey()}`,
        },
      },
      (r) => {
        const bufs = []
        r.on('data', (c) => bufs.push(c))
        r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(bufs).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.setTimeout(180000, () => req.destroy(new Error('timeout')))
    req.end(payload)
  })

  console.log(`\n上游响应 status=${res.status} 字节=${res.text.length} 耗时=${Date.now() - t0}ms`)

  // 从 SSE 里拼出助手正文（completions 格式：choices[0].delta.content；reasoning_content 不算正文）
  let assistant = ''
  let reasoningChars = 0
  let chunkCount = 0
  for (const line of res.text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const raw = t.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      const ev = JSON.parse(raw)
      const d = ev.choices?.[0]?.delta
      if (!d) continue
      chunkCount += 1
      if (typeof d.reasoning_content === 'string') reasoningChars += d.reasoning_content.length
      if (typeof d.content === 'string') assistant += d.content
    } catch {}
  }
  console.log(`SSE chunk 数=${chunkCount}  推理内容字符=${reasoningChars}（不计入正文）  含[DONE]=${res.text.includes('[DONE]')}`)
  console.log(`助手正文(经 SSE 累积): ${assistant.trim() || '（空）'}`)

  await sleep(3000) // 等代理异步落库

  const logLines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
  const newLines = logLines.slice(logBefore)
  const okLines = newLines.filter((l) => l.includes('"capture_ok"'))
  console.log(`\nT1  evidenceMdFiles=${countEvidence()}  (Δ=${countEvidence() - before})`)
  console.log(`本窗口新增代理日志 ${newLines.length} 行，其中 capture_ok ${okLines.length} 行：`)
  for (const l of okLines) console.log(`  ${l}`)

  let evidencePath = null
  for (const l of okLines) {
    const m = /"evidenceId":"([^"]+)"/.exec(l)
    if (m) evidencePath = `${EVID}\\${m[1]}.md`
  }

  if (evidencePath && existsSync(evidencePath)) {
    console.log(`\n落盘证据文件: ${evidencePath}  size=${statSync(evidencePath).size}B`)
    const md = readFileSync(evidencePath, 'utf8')
    const hasUser = md.includes('## 用户')
    const hasAssistant = md.includes('## 助手')
    const notCaptured = md.includes('［未取到')
    console.log(`  含「## 用户」=${hasUser} 含「## 助手」=${hasAssistant} 有未取到占位=${notCaptured}`)
    console.log('  ── 文件内容 ──')
    console.log(
      md
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    )
    const verdict = hasUser && hasAssistant && !notCaptured && okLines.length >= 1
    console.log(`\nENDOFFLINE VERDICT: ${verdict ? 'GREEN（一轮真实对话已完整落库）' : 'RED'}`)
    process.exit(verdict ? 0 : 1)
  }

  console.log('\nENDOFFLINE VERDICT: RED（没有找到本轮落盘证据）')
  process.exit(1)
}

main().catch((e) => {
  console.error('CRASHED:', e.message)
  process.exit(3)
})
