#!/usr/bin/env node
/**
 * MAINPATH-1 对话捕获代理（本地，自包含，零第三方依赖）
 *
 *   DSH ──→ http://127.0.0.1:8899/v1 ──→ <upstream>/v1
 *                    └─ 旁路落库 memory-lib /v1/conversations/capture
 *
 * ── REJECT1 三处修复 ──────────────────────────────────────────────
 * ① 工具轮不再产生占位证据：按「turn」累积。工具轮只记正文段、不落库；
 *    该 turn 拿到最终正文才落一条；同 turn 多段 assistant 合并（\n\n 连接）。
 *    turn 标识 = sha1(截至最后一条 user 的消息前缀)——DSH agent 循环里同一轮的
 *    各次请求只会在末条 user **之后**追加 assistant/tool，所以该前缀恒定；
 *    下一轮有新的 user，前缀随之改变。
 * ② 状态三档：capture_ok / capture_empty / capture_failed（另设辅助 capture_deduped）。
 *    GREEN 要求 ok>0 且 empty 占比 < 阈值（默认 20%），否则 YELLOW/RED 且 exit≠0。
 * ③ 双写收口：落库前只读扫描证据目录；若同一 turn 已有**其它来源**的等长或更全条目，
 *    则让位（capture_deduped），不写第二条。eventId 按 turn 恒定，
 *    服务端 (source,conversationId,eventId) 幂等，重复请求不会产生第二条。
 * ─────────────────────────────────────────────────────────────────
 *
 * 不改写内容：请求/响应原始字节逐字节转发；SSE 逐 chunk 下发；解析走旁路副本。
 * fail-open：落库任何失败都不影响对话转发，只写日志 + 状态文件。
 *
 * 凭据：运行期从 DSH 的 cordis.patch.yml 读取（不落仓库）。
 * 身份：pilot-01 / capture-ingest（实测唯一可用组合）。
 */
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

// ---------------------------------------------------------------- 配置
function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const CFG = {
  host: argOf('host', process.env.CAPTURE_PROXY_HOST || '127.0.0.1'),
  port: Number(argOf('port', process.env.CAPTURE_PROXY_PORT || 8899)),
  upstream: argOf('upstream', process.env.CAPTURE_PROXY_UPSTREAM || 'https://api.deepseek.com/v1'),
  memoryBase: process.env.MEMORY_BASE || argOf('memory', 'http://127.0.0.1:8787'),
  logDir: process.env.CAPTURE_PROXY_LOGDIR || 'D:\\MemoryLib\\logs',
  patchFile:
    process.env.CAPTURE_PROXY_PATCH || 'C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml',
  evidenceDir:
    process.env.CAPTURE_PROXY_EVIDENCE_DIR ||
    argOf('evidence-dir', 'D:\\MemoryLib\\data\\memory\\evidence\\conversations'),
  dedupeWindowMs: Number(argOf('dedupe-window-ms', process.env.CAPTURE_PROXY_DEDUPE_WINDOW_MS || 600000)),
  settleMs: Number(argOf('settle-ms', process.env.CAPTURE_PROXY_SETTLE_MS || 20000)),
  emptyRatioMax: Number(argOf('empty-ratio-max', process.env.CAPTURE_PROXY_EMPTY_RATIO_MAX || 0.2)),
  principal: { agent_id: 'pilot-01', role_id: 'capture-ingest' },
  maxParseBytes: 32 * 1024 * 1024,
  turnIdleMs: Number(argOf('turn-idle-ms', 30 * 60 * 1000)),
}

const LOG_FILE = join(CFG.logDir, 'capture-proxy.log')
const STATUS_FILE = join(CFG.logDir, 'capture-proxy-status.json')

const upURL = new URL(CFG.upstream)
const UP_ORIGIN = upURL.origin
const UP_PREFIX = upURL.pathname.replace(/\/+$/, '')

// ---------------------------------------------------------------- 日志 / 状态
mkdirSync(CFG.logDir, { recursive: true })

const stats = {
  startedAt: new Date().toISOString(),
  listen: `http://${CFG.host}:${CFG.port}`,
  upstream: CFG.upstream,
  memoryBase: CFG.memoryBase,
  evidenceDir: CFG.evidenceDir,
  requests: 0,
  forwarded: 0,
  forwardErrors: 0,
  captureOk: 0,
  captureEmpty: 0,
  captureFailed: 0,
  captureDeduped: 0,
  // 兼容字段（前序脚本仍读这两个名字）
  captureSuccess: 0,
  captureFailure: 0,
  captureSkipped: 0,
  turnsOpen: 0,
  turnsFinalized: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastEvidenceId: null,
  consecutiveFailures: 0,
}

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj })
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch (e) {
    process.stderr.write(`[proxy] LOG WRITE FAILED ${e.message}\n`)
  }
  process.stdout.write(line + '\n')
}

function persistStatus() {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({ ...stats, verdict: verdictOf(stats) }, null, 2), 'utf8')
  } catch (e) {
    process.stderr.write(`[proxy] STATUS WRITE FAILED ${e.message}\n`)
  }
}

/** ② 三档判定 —— 与 capture-proxy-status.mjs 同一套公式（单一口径） */
function verdictOf(s) {
  const total = s.captureOk + s.captureEmpty + s.captureFailed
  if (total === 0) return { level: 'RED', reason: '窗口内没有任何落库尝试' }
  const emptyRatio = s.captureEmpty / total
  const failRatio = s.captureFailed / total
  if (s.captureOk === 0) return { level: 'RED', reason: `capture_ok=0（empty=${s.captureEmpty} failed=${s.captureFailed}）` }
  if (emptyRatio >= 0.5) return { level: 'RED', reason: `empty 占比 ${(emptyRatio * 100).toFixed(1)}% ≥ 50%` }
  if (failRatio >= 0.2) return { level: 'RED', reason: `failed 占比 ${(failRatio * 100).toFixed(1)}% ≥ 20%` }
  if (emptyRatio >= CFG.emptyRatioMax)
    return { level: 'YELLOW', reason: `empty 占比 ${(emptyRatio * 100).toFixed(1)}% ≥ ${(CFG.emptyRatioMax * 100).toFixed(0)}%` }
  if (s.captureFailed > 0) return { level: 'YELLOW', reason: `capture_failed=${s.captureFailed}` }
  return { level: 'GREEN', reason: `ok=${s.captureOk} empty=${s.captureEmpty} failed=${s.captureFailed}` }
}

// ---------------------------------------------------------------- 凭据
let credCache = null
function loadCreds() {
  if (credCache) return credCache
  if (process.env.MEMORY_CAPTURE_REF && process.env.MEMORY_CAPTURE_SECRET) {
    credCache = { ref: process.env.MEMORY_CAPTURE_REF, secret: process.env.MEMORY_CAPTURE_SECRET }
    return credCache
  }
  const text = readFileSync(CFG.patchFile, 'utf8')
  const ref = /X-MCP-Credential-Ref:\s*'([^']+)'/.exec(text)?.[1]
  const secret = /X-MCP-Secret:\s*'([^']+)'/.exec(text)?.[1]
  if (!ref || !secret) throw new Error('credential_ref/secret not found in patch file')
  credCache = { ref, secret }
  return credCache
}

// ---------------------------------------------------------------- 文本抽取
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** 解析请求体：user 文本 / model / turnKey */
function parseRequest(reqText) {
  const out = { userText: null, model: null, turnKey: null, kind: null }
  if (!reqText) return out
  let j
  try {
    j = JSON.parse(reqText)
  } catch {
    return out
  }
  out.model = j.model ?? null

  if (Array.isArray(j.messages)) {
    out.kind = 'completions'
    let idx = -1
    for (let i = j.messages.length - 1; i >= 0; i--) {
      if (j.messages[i]?.role === 'user') {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      out.userText = contentToText(j.messages[idx].content) || null
      out.turnKey = createHash('sha1').update(JSON.stringify(j.messages.slice(0, idx + 1))).digest('hex').slice(0, 16)
    }
    return out
  }

  out.kind = 'responses'
  if (typeof j.input === 'string') {
    out.userText = j.input
    out.turnKey = createHash('sha1').update(JSON.stringify({ input: j.input })).digest('hex').slice(0, 16)
    return out
  }
  if (Array.isArray(j.input)) {
    let idx = -1
    for (let i = j.input.length - 1; i >= 0; i--) {
      const it = j.input[i]
      if (it && (it.role === 'user' || (it.type === 'message' && !it.role))) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      out.userText = contentToText(j.input[idx].content ?? j.input[idx].text) || null
      out.turnKey = createHash('sha1').update(JSON.stringify(j.input.slice(0, idx + 1))).digest('hex').slice(0, 16)
    }
  }
  return out
}

/** 非流式响应：assistant 文本 + 是否工具轮 */
function extractFromJson(text) {
  const res = { assistant: null, hasToolCalls: false }
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return res
  }
  if (Array.isArray(j.output)) {
    const parts = []
    for (const item of j.output) {
      if (!item) continue
      if (item.type === 'function_call' || item.type === 'tool_call') res.hasToolCalls = true
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c?.text === 'string') parts.push(c.text)
      }
    }
    if (parts.length) res.assistant = parts.join('')
  }
  if (typeof j.output_text === 'string' && j.output_text) res.assistant = res.assistant || j.output_text
  if (Array.isArray(j.choices) && j.choices[0]) {
    const ch = j.choices[0]
    if (ch.finish_reason === 'tool_calls' || ch.finish_reason === 'function_call') res.hasToolCalls = true
    const m = ch.message ?? ch
    if (Array.isArray(m?.tool_calls) && m.tool_calls.length) res.hasToolCalls = true
    if (typeof m?.content === 'string' && m.content) res.assistant = m.content
    else if (Array.isArray(m?.content)) {
      const t = contentToText(m.content)
      if (t) res.assistant = t
    }
  }
  return res
}

/** SSE 累积器：兼容 responses 事件与 completions delta；识别工具轮 */
function makeSseSink() {
  const state = { text: '', finalText: null, hasToolCalls: false, toolCallCount: 0, sawDone: false, buf: '' }
  return {
    state,
    push(chunkText) {
      state.buf += chunkText
      let idx
      while ((idx = state.buf.indexOf('\n\n')) >= 0) {
        const block = state.buf.slice(0, idx)
        state.buf = state.buf.slice(idx + 2)
        for (const raw of block.split('\n')) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') {
            state.sawDone = true
            continue
          }
          let ev
          try {
            ev = JSON.parse(payload)
          } catch {
            continue
          }
          if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
            state.text += ev.delta
          } else if (ev.type === 'response.output_item.added' || ev.type === 'response.output_item.done') {
            const t = ev.item?.type
            if (t === 'function_call' || t === 'tool_call') {
              state.hasToolCalls = true
              state.toolCallCount += 1
            }
          } else if (ev.type === 'response.completed' && ev.response) {
            const full = extractFromJson(JSON.stringify(ev.response))
            if (full.assistant) state.finalText = full.assistant
            if (full.hasToolCalls) state.hasToolCalls = true
          } else if (Array.isArray(ev.choices)) {
            const ch = ev.choices[0]
            if (ch?.finish_reason === 'tool_calls' || ch?.finish_reason === 'function_call') state.hasToolCalls = true
            const d = ch?.delta ?? ch?.message
            if (Array.isArray(d?.tool_calls) && d.tool_calls.length) {
              state.hasToolCalls = true
              state.toolCallCount += d.tool_calls.length
            }
            if (typeof d?.content === 'string' && d.content) state.text += d.content
            else if (Array.isArray(d?.content)) {
              const t = contentToText(d.content)
              if (t) state.text += t
            }
          }
        }
      }
    },
    result() {
      const t = state.finalText || state.text
      return { assistant: t && t.trim() ? t : null, hasToolCalls: state.hasToolCalls }
    },
  }
}

// ---------------------------------------------------------------- ③ 证据目录去重（只读）
const evidenceCache = new Map()

/** 逐行取 `## <name>` 段正文（比正则可靠，正文里可能含 ## 标题） */
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

function parseEvidenceMeta(file) {
  try {
    const md = readFileSync(join(CFG.evidenceDir, file), 'utf8')
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(md)
    const fm = {}
    if (fmMatch) {
      for (const line of fmMatch[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
        if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, '')
      }
    }
    const body = fmMatch ? fmMatch[2] : md
    const userText = sectionText(body, '用户')
    const assistantText = sectionText(body, '助手')
    return {
      file,
      source: fm.source || '',
      capturedAt: fm.capturedAt || '',
      calendarDate: fm.calendarDate || '',
      userKey: createHash('sha1').update(normalizeText(userText).slice(0, 200)).digest('hex'),
      assistantChars: assistantText.length,
      hasPlaceholder: body.includes('［未取到'),
    }
  } catch {
    return null
  }
}

function findOtherSourceForTurn(userText) {
  const userKey = createHash('sha1').update(normalizeText(userText).slice(0, 200)).digest('hex')
  let files
  try {
    files = readdirSync(CFG.evidenceDir).filter((f) => f.endsWith('.md'))
  } catch {
    return null
  }
  const now = Date.now()
  const hits = []
  for (const f of files) {
    if (!evidenceCache.has(f)) evidenceCache.set(f, parseEvidenceMeta(f))
    const meta = evidenceCache.get(f)
    if (!meta || meta.userKey !== userKey) continue
    if (meta.source === 'capture-proxy') continue
    const t = Date.parse(meta.capturedAt || 0)
    if (Number.isFinite(t) && now - t > CFG.dedupeWindowMs) continue
    hits.push(meta)
  }
  if (!hits.length) return null
  hits.sort((a, b) => b.assistantChars - a.assistantChars)
  return hits[0]
}

function invalidateEvidenceCache() {
  evidenceCache.clear()
}

// ---------------------------------------------------------------- turn 队列（①）
const turns = new Map()

function appendSegment(entry, text) {
  if (!text) return
  if (!entry.segments.includes(text)) entry.segments.push(text)
}

// ---------------------------------------------------------------- 落库（fail-open）
async function writeCapture({ entry, reqId }) {
  const assistantText = entry.segments.join('\n\n')
  const userText = entry.userText
  const now = new Date()
  const calendarDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)

  stats.lastAttemptAt = now.toISOString()

  // ① 空 turn：不写占位证据，只计 capture_empty（可被 ② 看见）
  if (!assistantText || !assistantText.trim()) {
    stats.captureEmpty += 1
    stats.captureSkipped += 1
    logLine({
      reqId,
      event: 'capture_empty',
      reason:
        entry.toolRounds > 0 && entry.rounds === entry.toolRounds
          ? 'tool-turn-only（整轮只有工具轮，没有正文）'
          : 'no assistant text',
      model: entry.model,
      path: entry.path,
      userChars: userText?.length ?? 0,
      rounds: entry.rounds,
      toolRounds: entry.toolRounds,
      turnKey: entry.turnKey,
    })
    persistStatus()
    return
  }

  // ③ 让位给等长/更全的其它来源（先等一个 settle 窗口，让旁路有机会先写）
  if (CFG.settleMs > 0) await new Promise((r) => setTimeout(r, CFG.settleMs))
  const other = findOtherSourceForTurn(userText)
  if (other && other.assistantChars >= assistantText.trim().length) {
    stats.captureDeduped += 1
    logLine({
      reqId,
      event: 'capture_deduped',
      reason: '同一 turn 已有其它来源且不更短，让位',
      winner: other.file,
      winnerSource: other.source,
      winnerAssistantChars: other.assistantChars,
      ourAssistantChars: assistantText.trim().length,
      turnKey: entry.turnKey,
      model: entry.model,
    })
    persistStatus()
    return
  }

  try {
    const creds = loadCreds()
    const body = {
      credential_ref: creds.ref,
      secret: creds.secret,
      principal: { ...CFG.principal, group_id: 'home-circle', user_id: 'user-owner' },
      messages: [
        { role: 'user', content: userText ?? '［未取到 user 文本］' },
        { role: 'assistant', content: assistantText },
      ],
      source: 'capture-proxy',
      conversation_id: `proxy-${calendarDate}`,
      event_id: `proxy-${calendarDate}-turn-${entry.turnKey}`,
    }
    const res = await fetch(`${CFG.memoryBase}/v1/conversations/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
    let parsed = {}
    try {
      parsed = JSON.parse(text)
    } catch {}
    stats.captureOk += 1
    stats.captureSuccess += 1
    stats.consecutiveFailures = 0
    stats.lastSuccessAt = new Date().toISOString()
    stats.lastEvidenceId = parsed.evidenceId ?? null
    stats.lastError = null
    invalidateEvidenceCache()
    logLine({
      reqId,
      event: 'capture_ok',
      evidenceId: parsed.evidenceId ?? null,
      dedupedByServer: parsed.deduped ?? false,
      userChars: userText?.length ?? 0,
      assistantChars: assistantText.trim().length,
      segments: entry.segments.length,
      rounds: entry.rounds,
      toolRounds: entry.toolRounds,
      model: entry.model,
      turnKey: entry.turnKey,
    })
  } catch (e) {
    stats.captureFailed += 1
    stats.captureFailure += 1
    stats.consecutiveFailures += 1
    stats.lastFailureAt = new Date().toISOString()
    stats.lastError = e.message
    logLine({ reqId, event: 'capture_failed', error: e.message, turnKey: entry.turnKey, model: entry.model })
  }
  persistStatus()
}

// ---------------------------------------------------------------- 转发
function buildTargetPath(incomingPath) {
  if (UP_PREFIX && incomingPath.startsWith(UP_PREFIX + '/')) return incomingPath
  if (incomingPath.startsWith('/v1/')) return incomingPath
  return UP_PREFIX + (incomingPath.startsWith('/') ? incomingPath : '/' + incomingPath)
}

function filterReqHeaders(headers) {
  const out = { ...headers }
  delete out.host
  delete out.connection
  delete out['proxy-connection']
  delete out['accept-encoding']
  return out
}

function filterResHeaders(headers) {
  const out = { ...headers }
  for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']) delete out[h]
  return out
}

const server = http.createServer((req, res) => {
  const reqId = randomUUID().slice(0, 8)
  const started = Date.now()
  const incomingPath = req.url || '/'

  if (incomingPath.startsWith('/__proxy/')) {
    if (incomingPath === '/__proxy/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, ...stats, verdict: verdictOf(stats), openTurns: [...turns.keys()] }, null, 2))
      return
    }
    if (incomingPath === '/__proxy/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, service: 'capture-proxy', upstream: CFG.upstream, memory: CFG.memoryBase }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"ok":false,"error":"unknown control endpoint"}')
    return
  }

  stats.requests += 1
  const chunks = []
  let reqBytes = 0
  req.on('data', (c) => {
    chunks.push(c)
    reqBytes += c.length
  })
  req.on('error', (e) => logLine({ reqId, event: 'client_req_error', error: e.message }))

  req.on('end', () => {
    const reqBody = Buffer.concat(chunks)
    const reqText = reqBody.length <= CFG.maxParseBytes ? reqBody.toString('utf8') : null
    const parsedReq = parseRequest(reqText)
    const userText = parsedReq.userText
    const model = parsedReq.model
    const turnKey = parsedReq.turnKey
    const wantsStream = reqText ? /"stream"\s*:\s*true/.test(reqText) : false

    const headers = filterReqHeaders(req.headers)
    headers['content-length'] = String(reqBody.length)

    const targetPath = buildTargetPath(incomingPath.split('?')[0])
    const query = (req.url || '').includes('?') ? '?' + (req.url || '').split('?')[1] : ''
    const targetUrl = new URL(UP_ORIGIN + targetPath + query)
    const client = targetUrl.protocol === 'https:' ? https : http

    const upReq = client.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
      },
      (upRes) => {
        const resHeaders = filterResHeaders(upRes.headers)
        res.writeHead(upRes.statusCode || 502, resHeaders)

        const encoding = (upRes.headers['content-encoding'] || '').toLowerCase()
        let decompressor = null
        if (encoding.includes('gzip')) decompressor = zlib.createGunzip()
        else if (encoding.includes('br')) decompressor = zlib.createBrotliDecompress()
        else if (encoding.includes('deflate')) decompressor = zlib.createInflate()

        const isSse = (upRes.headers['content-type'] || '').includes('text/event-stream')
        const sink = isSse ? makeSseSink() : null
        const plainChunks = []
        let plainBytes = 0

        const collect = (buf) => {
          if (sink) sink.push(buf.toString('utf8'))
          else {
            plainBytes += buf.length
            if (plainBytes <= CFG.maxParseBytes) plainChunks.push(buf)
          }
        }

        if (decompressor) {
          decompressor.on('data', collect)
          decompressor.on('error', (e) => logLine({ reqId, event: 'decompress_error', error: e.message }))
          upRes.pipe(decompressor)
        } else {
          upRes.on('data', collect)
        }

        // 逐字节转发（原始字节，不解压不改写）
        upRes.on('data', (chunk) => res.write(chunk))

        upRes.on('end', () => {
          res.end()
          stats.forwarded += 1
          const durationMs = Date.now() - started
          const upStatus = upRes.statusCode || 0

          let round = { assistant: null, hasToolCalls: false }
          let extractNote = 'ok'
          if (sink) {
            round = sink.result()
            if (!round.assistant && !round.hasToolCalls) extractNote = 'no text and no tool_calls in SSE'
          } else if (plainChunks.length) {
            round = extractFromJson(Buffer.concat(plainChunks).toString('utf8'))
            if (!round.assistant && !round.hasToolCalls) extractNote = 'no text and no tool_calls in JSON'
          } else {
            extractNote = 'response body too large or empty to parse'
          }

          logLine({
            reqId,
            event: 'forward_ok',
            method: req.method,
            path: incomingPath,
            model,
            stream: isSse || wantsStream,
            upstreamStatus: upStatus,
            reqBytes,
            durationMs,
            userChars: userText?.length ?? 0,
            hasToolCalls: round.hasToolCalls,
            roundChars: round.assistant?.length ?? 0,
            turnKey,
            extractNote,
          })

          const isDialogOk = upStatus >= 200 && upStatus < 300 && req.method === 'POST'
          if (!isDialogOk) {
            stats.captureSkipped += 1
            logLine({ reqId, event: 'capture_skipped', reason: `upstream_status_${upStatus}`, model, path: incomingPath })
            persistStatus()
            return
          }

          if (!turnKey) {
            stats.captureFailed += 1
            stats.captureFailure += 1
            logLine({ reqId, event: 'capture_failed', reason: 'cannot identify turn (no user message)', path: incomingPath })
            persistStatus()
            return
          }

          let entry = turns.get(turnKey)
          if (!entry) {
            entry = {
              turnKey,
              userText,
              segments: [],
              model,
              method: req.method,
              path: incomingPath,
              firstAt: Date.now(),
              lastAt: Date.now(),
              reqId,
              rounds: 0,
              toolRounds: 0,
            }
            turns.set(turnKey, entry)
            stats.turnsOpen = turns.size
          }
          entry.lastAt = Date.now()
          entry.rounds += 1
          if (round.hasToolCalls) entry.toolRounds += 1
          appendSegment(entry, round.assistant)

          if (round.hasToolCalls) {
            // ① 工具轮：只累积，不落库
            logLine({ reqId, event: 'turn_tool_round', turnKey, rounds: entry.rounds, segments: entry.segments.length })
            persistStatus()
            return
          }

          turns.delete(turnKey)
          stats.turnsOpen = turns.size
          stats.turnsFinalized += 1
          writeCapture({ entry, reqId }).catch((e) => {
            stats.captureFailed += 1
            stats.captureFailure += 1
            logLine({ reqId, event: 'capture_throw', error: e.message })
            persistStatus()
          })
        })

        upRes.on('error', (e) => {
          logLine({ reqId, event: 'upstream_res_error', error: e.message })
          try {
            res.end()
          } catch {}
        })
      },
    )

    upReq.on('error', (e) => {
      stats.forwardErrors += 1
      logLine({ reqId, event: 'upstream_error', error: e.message, path: incomingPath })
      persistStatus()
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      try {
        res.end(JSON.stringify({ ok: false, error: 'capture-proxy upstream error', detail: e.message }))
      } catch {}
    })

    if (reqBody.length) upReq.write(reqBody)
    upReq.end()
  })
})

// 陈旧 turn 清理（防内存泄漏；被清理的 turn 不落库，只记日志）
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, e] of turns) {
    if (now - e.lastAt > CFG.turnIdleMs) {
      turns.delete(k)
      stats.turnsOpen = turns.size
      logLine({ event: 'turn_evicted', turnKey: k, idleMs: now - e.lastAt, segments: e.segments.length })
    }
  }
}, 60000)
if (sweeper.unref) sweeper.unref()

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  } catch {}
})

server.listen(CFG.port, CFG.host, () => {
  logLine({
    event: 'proxy_start',
    listen: `http://${CFG.host}:${CFG.port}`,
    upstream: CFG.upstream,
    memory: CFG.memoryBase,
    evidenceDir: CFG.evidenceDir,
    settleMs: CFG.settleMs,
    dedupeWindowMs: CFG.dedupeWindowMs,
    emptyRatioMax: CFG.emptyRatioMax,
    logFile: LOG_FILE,
    principal: `${CFG.principal.agent_id}/${CFG.principal.role_id}`,
  })
  persistStatus()
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logLine({ event: 'proxy_stop', signal: sig, openTurns: turns.size })
    persistStatus()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500)
  })
}
