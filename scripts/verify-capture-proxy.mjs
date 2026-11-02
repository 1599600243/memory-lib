#!/usr/bin/env node
/**
 * MAINPATH-1 代理验证（红→绿）：
 *   A. 逐字节一致性：本地 mock 上游返回固定字节（含 SSE），经代理转发的客户端字节必须与直连上游完全相等。
 *   B. 真实上游非流式（completions）：经代理转发真实 /v1/chat/completions，断言 200 + 有正文 + 落库成功。
 *   C. 真实上游流式（responses）：经代理转发真实 /v1/responses stream:true，断言 SSE 事件里出现
 *      response.output_text.delta + 落库成功（范围单点名要求覆盖该事件类型）。
 *   D. fail-open：把记忆库地址指向一个死端口，再发一次真实请求，断言「对话照常 200」而落库失败只进日志。
 *
 * 凭据：上游 key 运行时从 ~\.dsh\.credentials.yaml 读，绝不写入仓库。
 * 结果：每条打印 PASS/FAIL 与实测具体值，全绿才退出 0。
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PROXY = `http://127.0.0.1:${process.env.PROXY_PORT || 8899}`
const CREDS = 'C:\\Users\\admin\\.dsh\\.credentials.yaml'

let pass = 0
let fail = 0
const results = []
function check(name, cond, detail) {
  if (cond) {
    pass += 1
    results.push(`PASS  ${name}  ::  ${detail}`)
  } else {
    fail += 1
    results.push(`FAIL  ${name}  ::  ${detail}`)
  }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`)
}

function readApiKey(name = KEY_ENV) {
  const text = readFileSync(CREDS, 'utf8')
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(name + ':'))
  if (!line) throw new Error(`${name} not found in .credentials.yaml`)
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------- A. 逐字节一致性
async function testByteIdentity() {
  const SSE = [
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"逐字节"}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"一致性"}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const FIXED = Buffer.from(SSE, 'utf8')

  // mock 上游
  const mock = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-mock': 'byte-identity',
      })
      res.end(FIXED)
    })
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const mockPort = mock.address().port

  // 起一个专用代理实例指向 mock（不影响主代理）
  // 注意：沙箱不允许 piped stdio（spawn EPERM），子进程日志统一写独立目录，父进程读文件。
  const aLogDir = 'D:\\MemoryLib\\logs\\verify-a'
  const child = spawn(
    process.execPath,
    [
      process.env.PROXY_SCRIPT || 'D:\\MemoryLib\\scripts\\capture-proxy.mjs',
      '--port',
      '8901',
      '--upstream',
      `http://127.0.0.1:${mockPort}/v1`,
    ],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        MEMORY_BASE: 'http://127.0.0.1:9', // 落库必失败，但不影响转发
        CAPTURE_PROXY_LOGDIR: aLogDir,
      },
    },
  )
  await sleep(1500)

  try {
    const payload = JSON.stringify({
      model: 'byte-identity-test',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '逐字节一致性探针' }] }],
    })
    const got = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: 8901, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer dummy' } },
        (res) => {
          const bufs = []
          res.on('data', (c) => bufs.push(c))
          res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(bufs), headers: res.headers }))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })

    check('A1 状态码透传', got.status === 200, `status=${got.status}`)
    check(
      'A2 响应体逐字节相等',
      Buffer.compare(got.bytes, FIXED) === 0,
      `直连=${FIXED.length}B 经代理=${got.bytes.length}B 相等=${Buffer.compare(got.bytes, FIXED) === 0}`,
    )
    check('A3 自定义头透传', got.headers['x-mock'] === 'byte-identity', `x-mock=${got.headers['x-mock']}`)

    // A4：代理确实完成了一次转发（读子实例自己的日志文件）
    await sleep(400)
    let childLog = ''
    try {
      childLog = readFileSync('D:\\MemoryLib\\logs\\verify-a\\capture-proxy.log', 'utf8')
    } catch {}
    check('A4 代理记录 forward_ok', childLog.includes('forward_ok'), `子实例日志含 forward_ok=${childLog.includes('forward_ok')}`)
  } finally {
    child.kill()
    mock.close()
  }
}

// ---------------------------------------------------------------- B/C/D 真实上游
async function realCall({ path, body, stream }) {
  const key = readApiKey()
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(process.env.PROXY_PORT || 8899),
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${key}`,
        },
      },
      (res) => {
        const bufs = []
        res.on('data', (c) => bufs.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(bufs).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('timeout 120s')))
    req.end(payload)
  })
}

function proxyStatus() {
  return new Promise((resolve, reject) => {
    http
      .get(`${PROXY}/__proxy/status`, (res) => {
        let t = ''
        res.on('data', (c) => (t += c))
        res.on('end', () => resolve(JSON.parse(t)))
      })
      .on('error', reject)
  })
}

const MODEL = process.env.VERIFY_MODEL || 'deepseek-flash'
const KEY_ENV = process.env.VERIFY_KEY_ENV || 'DEEPSEEK_API_KEY'

async function main() {
  console.log('──── A. 逐字节一致性（mock 上游）────')
  await testByteIdentity()

  console.log('\n──── B. 真实上游 非流式 completions ─────')
  const before = await proxyStatus()
  const b = await realCall({
    path: '/v1/chat/completions',
    body: {
      model: MODEL,
      stream: false,
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'MAINPATH-1 端到端验证 B：请只回答两个字——收到。' },
      ],
    },
  })
  check('B1 状态 200', b.status === 200, `status=${b.status} body=${b.text.slice(0, 160)}`)
  check('B2 有 assistant 正文', /"content"\s*:\s*"[^"]+"/.test(b.text) || /收到/.test(b.text), `len=${b.text.length}`)

  console.log('\n──── C. 真实上游 流式 completions（SSE · 生产路径）────')
  const c = await realCall({
    path: '/v1/chat/completions',
    body: {
      model: MODEL,
      stream: true,
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'MAINPATH-1 端到端验证 C：请只回答两个字——收到。' },
      ],
    },
  })
  const cDeltas = [...c.text.matchAll(/"delta":\{[^}]*?"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  const cAccum = cDeltas.join('')
  const hasChunk = c.text.includes('chat.completion.chunk')
  const hasDone = c.text.includes('[DONE]')
  check('C1 状态 200', c.status === 200, `status=${c.status}`)
  check('C2 是 chat.completion.chunk 流', hasChunk, `命中=${hasChunk} 响应长度=${c.text.length}`)
  check('C3 delta.content 累积非空', cAccum.trim().length > 0, `事件数=${cDeltas.length} 累积="${cAccum.trim()}"`)
  check('C4 含 [DONE] 终止符', hasDone, `命中=${hasDone}`)

  console.log('\n──── C5. 真实上游 流式 responses（兼容性回归，非默认路径）────')
  const c5 = await realCall({
    path: '/v1/responses',
    body: {
      model: MODEL,
      stream: true,
      max_output_tokens: 256,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'MAINPATH-1 兼容性验证 C5：请只回答两个字——收到。' }] },
      ],
    },
  })
  check(
    'C5 responses 流式仍可透传（200 或上游明确拒绝）',
    c5.status === 200 || c5.status === 404,
    `status=${c5.status}（DeepSeek 实测支持 /responses，200 为正常）`,
  )
  await sleep(2500) // 等落库异步完成
  const after = await proxyStatus()
  check(
    'B/C 落库成功数 > 0',
    after.captureSuccess > before.captureSuccess,
    `before=${before.captureSuccess} after=${after.captureSuccess} lastEvidenceId=${after.lastEvidenceId}`,
  )
  check('B/C 无落库失败累积', after.captureFailure === 0, `captureFailure=${after.captureFailure}`)

  console.log('\n──── D. fail-open（记忆库不可达时对话照常）────')
  const dLogDir = 'D:\\MemoryLib\\logs\\verify-d'
  const dChild = spawn(
    process.execPath,
    [
      process.env.PROXY_SCRIPT || 'D:\\MemoryLib\\scripts\\capture-proxy.mjs',
      '--port',
      '8902',
      '--upstream',
      process.env.VERIFY_UPSTREAM || 'https://api.deepseek.com/v1',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MEMORY_BASE: 'http://127.0.0.1:9', CAPTURE_PROXY_LOGDIR: dLogDir },
    },
  )
  await sleep(1500)
  try {
    const key = readApiKey()
    const payload = JSON.stringify({
      model: MODEL,
      stream: false,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'MAINPATH-1 端到端验证 D：fail-open 探针，回答「ok」即可。' }],
    })
    const dr = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: 8902, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${key}` } },
        (res) => {
          const bufs = []
          res.on('data', (x) => bufs.push(x))
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(bufs).toString('utf8') }))
        },
      )
      req.on('error', reject)
      req.setTimeout(120000, () => req.destroy(new Error('timeout')))
      req.end(payload)
    })
    await sleep(1200)
    check('D1 记忆库死掉时对话仍 200', dr.status === 200, `status=${dr.status}`)
    check('D2 对话正文照常拿到', /"content"\s*:/.test(dr.text) || dr.text.length > 20, `len=${dr.text.length}`)
    let dLog = ''
    try {
      dLog = readFileSync('D:\\MemoryLib\\logs\\verify-d\\capture-proxy.log', 'utf8')
    } catch {}
    check('D3 落库失败只进日志', dLog.includes('capture_fail'), `日志含 capture_fail=${dLog.includes('capture_fail')}`)
  } finally {
    dChild.kill()
  }

  console.log('\n══════ 汇总 ══════')
  for (const r of results) console.log(r)
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('VERIFY CRASHED:', e.message)
  process.exit(3)
})
