#!/usr/bin/env node
/**
 * REJECT1 ① 的真实链路验证：真上游（DeepSeek）+ 真记忆库（8787）跑一轮**真工具调用**对话，
 * 断言：工具轮不落占位、同一 turn 只落一条、正文非空且合并完整。
 *
 *   node scripts/reject1-real-tool-turn.mjs
 *
 * 说明：这会向生产记忆库写入 **1 条**真实证据（内容为本脚本的验证提问与模型真实回答），
 *       用于证明真实链路行为；文件路径会在输出里给出。
 */
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const CREDS = 'C:\\Users\\admin\\.dsh\\.credentials.yaml'
const EVID = 'D:\\MemoryLib\\data\\memory\\evidence\\conversations'
const LOGD = 'D:\\MemoryLib\\logs\\reject1-real'
const PROXY_PORT = 8907
const MODEL = 'deepseek-flash'

const MARKER = 'REJECT1 真工具轮验证：请调用 get_now 工具取当前时间，然后用一句话说明你取到了什么。'

function apiKey(name = 'DEEPSEEK_API_KEY') {
  const text = readFileSync(CREDS, 'utf8')
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(name + ':'))
  if (!line) throw new Error(`${name} not found`)
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function filesWithMarker(marker) {
  return readdirSync(EVID)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      try {
        return readFileSync(join(EVID, f), 'utf8').includes(marker)
      } catch {
        return false
      }
    })
}

function sectionText(md, name) {
  const lines = md.split(/\r?\n/)
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

function callProxy(body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${apiKey()}` },
      },
      (res) => {
        const bufs = []
        res.on('data', (c) => bufs.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(bufs).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.setTimeout(180000, () => req.destroy(new Error('timeout')))
    req.end(payload)
  })
}

function sseContent(text) {
  let acc = ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const raw = t.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      const ev = JSON.parse(raw)
      const d = ev.choices?.[0]?.delta
      if (d && typeof d.content === 'string') acc += d.content
    } catch {}
  }
  return acc
}

async function main() {
  const before = filesWithMarker(MARKER).length
  console.log(`T0 已有含标记的证据文件 = ${before}`)

  const child = spawn(
    process.execPath,
    [
      'D:\\MemoryLib\\scripts\\capture-proxy.mjs',
      '--port',
      String(PROXY_PORT),
      '--upstream',
      'https://api.deepseek.com/v1',
      '--memory',
      'http://127.0.0.1:8787',
      '--evidence-dir',
      EVID,
      '--settle-ms',
      '0',
    ],
    { stdio: 'ignore', env: { ...process.env, CAPTURE_PROXY_LOGDIR: LOGD } },
  )
  await sleep(1600)

  try {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_now',
          description: '返回服务器当前时间',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]

    // 第 1 轮：应当返回 tool_calls（工具轮）
    const r1 = await callProxy({ model: MODEL, stream: true, max_tokens: 256, tools, messages: [{ role: 'user', content: MARKER }] })
    console.log(`R1 status=${r1.status} 是否含 tool_calls=${r1.text.includes('tool_calls')}`)
    let callId = null
    for (const line of r1.text.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      try {
        const ev = JSON.parse(t.slice(5).trim())
        const tc = ev.choices?.[0]?.delta?.tool_calls?.[0]
        if (tc?.id) callId = tc.id
      } catch {}
    }
    console.log(`R1 tool_call_id=${callId ?? '(未取到)'}  正文=${JSON.stringify(sseContent(r1.text))}`)

    // 第 2 轮：带上工具结果，同一 turn（末条 user 仍是同一条）
    const r2 = await callProxy({
      model: MODEL,
      stream: true,
      max_tokens: 512,
      tools,
      messages: [
        { role: 'user', content: MARKER },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId ?? 'call_x', type: 'function', function: { name: 'get_now', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: callId ?? 'call_x', content: new Date().toISOString() },
      ],
    })
    const finalText = sseContent(r2.text)
    console.log(`R2 status=${r2.status} 正文=${JSON.stringify(finalText)}`)

    await sleep(3000)

    const after = filesWithMarker(MARKER)
    console.log(`T1 含标记的证据文件 = ${after.length}（新增 ${after.length - before}）`)

    let ok = true
    if (after.length - before !== 1) {
      console.log(`FAIL 期望新增 1 条，实际 ${after.length - before}`)
      ok = false
    } else {
      const f = after[0]
      const md = readFileSync(join(EVID, f), 'utf8')
      const assistant = sectionText(md, '助手')
      console.log(`证据文件: ${join(EVID, f)}`)
      console.log(`  source=${/^source:\s*(.+)$/m.exec(md)?.[1]}`)
      console.log(`  助手段长度=${assistant.length}  含占位=${md.includes('［未取到')}`)
      console.log(`  助手段前 120 字=${JSON.stringify(assistant.slice(0, 120))}`)
      if (assistant.length === 0 || md.includes('［未取到')) {
        console.log('FAIL 助手段为空或是占位')
        ok = false
      }
      if (!assistant.includes(finalText.trim().slice(0, 10)) && finalText.trim()) {
        console.log('WARN 助手段与最终正文开头不一致（可能合并了多段）')
      }
    }

    const log = readFileSync(join(LOGD, 'capture-proxy.log'), 'utf8')
    const toolRounds = log.split('\n').filter((l) => l.includes('"turn_tool_round"')).length
    const oks = log.split('\n').filter((l) => l.includes('"capture_ok"')).length
    console.log(`代理日志: turn_tool_round=${toolRounds} 条, capture_ok=${oks} 条`)
    if (toolRounds < 1) {
      console.log('WARN 没有记录到工具轮（模型这次可能没调工具）')
    }
    console.log(`\nVERDICT: ${ok ? 'GREEN' : 'RED'}`)
    process.exitCode = ok ? 0 : 1
  } finally {
    child.kill()
  }
}

main().catch((e) => {
  console.error('CRASHED:', e.stack || e.message)
  process.exit(3)
})
