#!/usr/bin/env node
/**
 * MAINPATH-1-REJECT1 新增断言（覆盖 ①②③）。全程用测试替身，**不写生产库**。
 *
 *   node scripts/verify-reject1.mjs
 *
 * 覆盖：
 *   T1 工具轮不产生占位证据（3 个工具轮 + 1 个收尾轮 → 只落 1 条带正文的证据）
 *   T2 同一 turn 多段 assistant 合并（不许只取第一段或最后一段）
 *   T3 状态判据真的会变红（只有工具轮的场景 → status 非 GREEN 且 exit≠0）
 *   T4 双写收口：同 turn 已有其它来源且更全 → 让位，不写第二条
 *   T5 同 turn 重复提交 → 服务端幂等，仍只有一条
 *   T6 无正文的收尾轮 → 计入 capture_empty，且**不写占位证据**
 */
import http from 'node:http'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createMockUpstream, createMockMemory } from './reject1-mocks.mjs'

const ROOT = 'D:\\MemoryLib\\logs\\reject1'
const EVID_A = join(ROOT, 'evidence-A')
const LOG_A = join(ROOT, 'log-A')
const EVID_B = join(ROOT, 'evidence-B')
const LOG_B = join(ROOT, 'log-B')

for (const d of [ROOT]) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {}
}
for (const d of [EVID_A, LOG_A, EVID_B, LOG_B]) mkdirSync(d, { recursive: true })

let pass = 0
const fails = []
function check(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}  ::  ${detail}`)
  } else {
    fails.push(`${name} :: ${detail}`)
    console.log(`FAIL  ${name}  ::  ${detail}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function post(port, path, body, headers = {}) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const bufs = []
        res.on('data', (c) => bufs.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(bufs).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        const bufs = []
        res.on('data', (c) => bufs.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(bufs).toString('utf8') }))
      })
      .on('error', reject)
  })
}

function startProxy({ port, upstreamPort, memoryPort, evidenceDir, logDir }) {
  const child = spawn(
    process.execPath,
    [
      'D:\\MemoryLib\\scripts\\capture-proxy.mjs',
      '--port',
      String(port),
      '--upstream',
      `http://127.0.0.1:${upstreamPort}/v1`,
      '--memory',
      `http://127.0.0.1:${memoryPort}`,
      '--evidence-dir',
      evidenceDir,
      '--settle-ms',
      '0',
      '--dedupe-window-ms',
      '600000',
    ],
    { stdio: 'ignore', env: { ...process.env, CAPTURE_PROXY_LOGDIR: logDir } },
  )
  return child
}

/** 读证据文件里某段的正文 */
function section(file, name) {
  const md = readFileSync(file, 'utf8')
  const body = md.split(/\r?\n---\r?\n/).slice(1).join('\n---\n')
  const m = new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`).exec(body)
  return m ? m[1].trim() : ''
}

function filesWithUser(evidDir, marker) {
  return readdirSync(evidDir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      try {
        return readFileSync(join(evidDir, f), 'utf8').includes(marker)
      } catch {
        return false
      }
    })
}

async function main() {
  const up = createMockUpstream()
  const upPort = await listen(up)
  const mem = createMockMemory(EVID_A)
  const memPort = await listen(mem.server)

  const PROXY_A = 8905
  const PA = startProxy({ port: PROXY_A, upstreamPort: upPort, memoryPort: memPort, evidenceDir: EVID_A, logDir: LOG_A })
  await sleep(1500)

  const msgs = (text) => [{ role: 'user', content: text }]
  const chat = (text, round, stream = true) =>
    post(PROXY_A, '/v1/chat/completions', { model: 'mock', stream, messages: msgs(text) }, { 'x-mock-round': round })

  // ─────────── T1 工具轮不产占位证据
  console.log('\n──── T1 工具轮 ────')
  for (let i = 0; i < 3; i++) await chat('T1-工具轮场景', 'tool')
  const t1final = await chat('T1-工具轮场景', 'final')
  await sleep(800)
  const t1files = filesWithUser(EVID_A, 'T1-工具轮场景')
  check('T1a 只落一条证据', t1files.length === 1, `文件数=${t1files.length}（3 工具轮 + 1 收尾轮）`)
  check(
    'T1b 这条有正文',
    t1files.length === 1 && section(join(EVID_A, t1files[0]), '助手').includes('最终答案'),
    `助手="${t1files.length ? section(join(EVID_A, t1files[0]), '助手') : 'n/a'}"`,
  )
  check('T1c 无占位文本', t1files.every((f) => !readFileSync(join(EVID_A, f), 'utf8').includes('［未取到')), '无［未取到］占位')

  // ─────────── T2 多段合并
  console.log('\n──── T2 多段合并 ────')
  await chat('T2-多段场景', 'tool-text') // 工具轮但带正文
  await chat('T2-多段场景', 'tool') // 纯工具轮
  await chat('T2-多段场景', 'final') // 收尾
  await sleep(800)
  const t2files = filesWithUser(EVID_A, 'T2-多段场景')
  const t2assist = t2files.length === 1 ? section(join(EVID_A, t2files[0]), '助手') : ''
  check('T2a 只落一条', t2files.length === 1, `文件数=${t2files.length}`)
  check('T2b 含工具轮那段正文', t2assist.includes('工具轮附带的正文'), `助手前 60 字="${t2assist.slice(0, 60)}"`)
  check('T2c 含收尾那段正文', t2assist.includes('最终答案'), `助手长度=${t2assist.length}`)
  const t2md = t2files.length === 1 ? readFileSync(join(EVID_A, t2files[0]), 'utf8') : ''
  check('T2d 只有一个「## 助手」段', (t2md.match(/^## 助手$/gm) || []).length === 1, `段数=${(t2md.match(/^## 助手$/gm) || []).length}`)

  // ─────────── T6 无正文的收尾轮
  console.log('\n──── T6 空正文 ────')
  const beforeEmpty = JSON.parse((await get(PROXY_A, '/__proxy/status')).text)
  await chat('T6-空正文场景', 'empty')
  await sleep(600)
  const afterEmpty = JSON.parse((await get(PROXY_A, '/__proxy/status')).text)
  check('T6a 计入 capture_empty', afterEmpty.captureEmpty > beforeEmpty.captureEmpty, `before=${beforeEmpty.captureEmpty} after=${afterEmpty.captureEmpty}`)
  check('T6b 不写占位证据', filesWithUser(EVID_A, 'T6-空正文场景').length === 0, `文件数=${filesWithUser(EVID_A, 'T6-空正文场景').length}`)

  // ─────────── T5 幂等
  console.log('\n──── T5 同 turn 重复提交 ────')
  await chat('T5-幂等场景', 'final')
  await sleep(500)
  await chat('T5-幂等场景', 'final') // 第二遍：同 turn → 同 eventId
  await sleep(800)
  const t5files = filesWithUser(EVID_A, 'T5-幂等场景')
  check('T5a 仍然只有一条', t5files.length === 1, `文件数=${t5files.length}（提交 2 次，eventId 恒定）`)
  const t5reqs = mem.requests.filter((r) => (r.event_id || '').includes('turn-'))
  check('T5b 两次提交都到了服务端', t5reqs.length >= 2, `capture 请求数=${t5reqs.length}`)

  // ─────────── T4 双写收口（让位给更全的其它来源）
  console.log('\n──── T4 让位其它来源 ────')
  const seedId = 'conversation-seedsidshipper000001'
  const seedMd = [
    '---',
    `id: ${seedId}`,
    'type: conversation',
    `capturedAt: ${new Date().toISOString()}`,
    `calendarDate: ${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}`,
    'calendarTimezone: "Asia/Shanghai"',
    'source: "dsh-session"',
    'conversationId: "session-mock#turn-1"',
    'eventId: "session-mock#turn-1"',
    'sessionId: ""',
    'frameworkId: "deepseek-harness"',
    'agentId: "pilot-01"',
    'roleId: "capture-ingest"',
    'groupId: "home-circle"',
    'userId: "user-owner"',
    'partial: false',
    '---',
    '# 原始对话记录',
    '',
    '## 用户',
    '',
    'T4-双写场景',
    '',
    '## 助手',
    '',
    '旁路版本：' + '更全的内容'.repeat(60),
    '',
  ].join('\n')
  writeFileSync(join(EVID_A, seedId + '.md'), seedMd, 'utf8')

  const beforeDedup = JSON.parse((await get(PROXY_A, '/__proxy/status')).text)
  await chat('T4-双写场景', 'final')
  await sleep(900)
  const afterDedup = JSON.parse((await get(PROXY_A, '/__proxy/status')).text)
  const t4proxyFiles = filesWithUser(EVID_A, 'T4-双写场景').filter((f) => f !== seedId + '.md')
  check(
    'T4a 代理让位（capture_deduped +1）',
    afterDedup.captureDeduped > beforeDedup.captureDeduped,
    `before=${beforeDedup.captureDeduped} after=${afterDedup.captureDeduped}`,
  )
  check('T4b 没有产生第二条', t4proxyFiles.length === 0, `代理新增文件数=${t4proxyFiles.length}（只有 ${seedId}.md 一条）`)
  const dedupLog = readFileSync(join(LOG_A, 'capture-proxy.log'), 'utf8')
  const dedupLine = dedupLog.split('\n').filter((l) => l.includes('"capture_deduped"')).pop()
  check('T4c 日志写明谁是赢家', Boolean(dedupLine) && dedupLine.includes(seedId), dedupLine ? `winner 字段=${/\"winner\":\"([^\"]+)\"/.exec(dedupLine)?.[1]}` : '无 capture_deduped 行')

  // ─────────── T3 状态会变红（独立实例，日志只有工具轮）
  console.log('\n──── T3 状态变红 ────')
  const memB = createMockMemory(EVID_B)
  const memBPort = await listen(memB.server)
  const PROXY_B = 8906
  const PB = startProxy({ port: PROXY_B, upstreamPort: upPort, memoryPort: memBPort, evidenceDir: EVID_B, logDir: LOG_B })
  await sleep(1500)
  for (let i = 0; i < 4; i++) {
    await post(PROXY_B, '/v1/chat/completions', { model: 'mock', stream: true, messages: msgs('T3-只有工具轮') }, { 'x-mock-round': 'tool' })
  }
  await sleep(600)
  const statusB = JSON.parse((await get(PROXY_B, '/__proxy/status')).text)
  const statusRun = await new Promise((resolve) => {
    const c = spawn(
      process.execPath,
      ['D:\\MemoryLib\\scripts\\capture-proxy-status.mjs', '--log', join(LOG_B, 'capture-proxy.log'), '--minutes', '30'],
      { stdio: 'ignore' },
    )
    c.on('exit', (code) => resolve(code))
  })
  check('T3a 代理自身判 RED', statusB.verdict?.level === 'RED', `verdict=${JSON.stringify(statusB.verdict)}`)
  check('T3b status 脚本 exit≠0', statusRun !== 0, `exit=${statusRun}`)
  check('T3c 未落任何证据', readdirSync(EVID_B).filter((f) => f.endsWith('.md')).length === 0, `证据文件数=${readdirSync(EVID_B).filter((f) => f.endsWith('.md')).length}`)

  // ─────────── 汇总代理 A 的计数
  const finalA = JSON.parse((await get(PROXY_A, '/__proxy/status')).text)
  console.log('\n──── 代理 A 计数 ────')
  console.log(JSON.stringify({ captureOk: finalA.captureOk, captureEmpty: finalA.captureEmpty, captureFailed: finalA.captureFailed, captureDeduped: finalA.captureDeduped, turnsFinalized: finalA.turnsFinalized, verdict: finalA.verdict }, null, 2))
  check('A 无落库失败', finalA.captureFailed === 0, `captureFailed=${finalA.captureFailed}`)

  PA.kill()
  PB.kill()
  up.close()
  mem.server.close()
  memB.server.close()

  console.log(`\n══════ REJECT1 新增断言 ══════`)
  console.log(`PASS=${pass} FAIL=${fails.length}`)
  for (const f of fails) console.log(`  FAILED: ${f}`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('CRASHED:', e.stack || e.message)
  process.exit(3)
})
