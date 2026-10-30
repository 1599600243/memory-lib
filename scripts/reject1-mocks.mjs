#!/usr/bin/env node
/**
 * REJECT1 测试替身（仅测试用，生产不用）
 *
 *  createMockUpstream(): 可控上游，按请求头 x-mock-round 返回不同形态：
 *      tool        纯工具轮（delta.tool_calls，无 content）
 *      tool-text   工具轮但带一段正文（用于验证多段合并）
 *      seg1/seg2   普通正文段
 *      final       最终正文
 *      nostream-tool / nostream-final   非流式形态
 *   两种协议都支持（/v1/chat/completions、/v1/responses）。
 *
 *  createMockMemory(dir): 模拟 memory-lib 的 capture 端点，行为对齐真实服务端：
 *      - 幂等键 = (source, conversation_id, event_id)  ← 与 conversation-memory.mjs 的
 *        eventFingerprint 一致；重复提交返回 deduped:true 且不新增文件
 *      - 写出的证据文件 front-matter 与 `## 用户` / `## 助手` 结构与生产一致
 */
import http from 'node:http'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export function createMockUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {}
      const round = String(req.headers['x-mock-round'] || 'final')
      const isResponses = (req.url || '').includes('/responses')
      const wantsStream = body.stream === true

      const TEXT = {
        seg1: '第一段正文',
        seg2: '第二段正文',
        final: '最终答案',
        'tool-text': '工具轮附带的正文',
      }[round] || '默认正文'

      if (!wantsStream) {
        // 非流式 JSON
        if (isResponses) {
          const output = []
          if (round.startsWith('tool') || round === 'nostream-tool') {
            output.push({ type: 'function_call', name: 'noop', arguments: '{}' })
          }
          if (round !== 'nostream-tool' && round !== 'tool') {
            output.push({ type: 'message', content: [{ type: 'output_text', text: TEXT }] })
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id: 'resp_mock', object: 'response', status: 'completed', output }))
          return
        }
        const msg = {}
        if (round === 'nostream-tool' || round === 'tool') {
          msg.tool_calls = [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }]
          msg.content = null
        } else {
          msg.content = TEXT
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'chatcmpl_mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', ...msg }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }] }))
        return
      }

      // 流式 SSE
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

      if (isResponses) {
        send({ type: 'response.created', response: { id: 'resp_mock' } })
        if (round === 'tool' || round === 'tool-text') {
          send({ type: 'response.output_item.added', item: { type: 'function_call', name: 'noop' } })
          send({ type: 'response.output_item.done', item: { type: 'function_call', name: 'noop', arguments: '{}' } })
        }
        if (round === 'tool-text') {
          send({ type: 'response.output_text.delta', delta: TEXT })
        }
        if (round === 'final' || round === 'seg1' || round === 'seg2') {
          send({ type: 'response.output_text.delta', delta: TEXT })
        }
        send({ type: 'response.completed', response: { id: 'resp_mock', output: [] } })
        res.end()
        return
      }

      send({ id: 'chatcmpl_mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' } }] })
      if (round === 'tool' || round === 'tool-text') {
        send({
          id: 'chatcmpl_mock',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }] } }],
        })
      }
      if (round === 'tool-text' || round === 'seg1' || round === 'seg2' || round === 'final') {
        send({ id: 'chatcmpl_mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: TEXT } }] })
      }
      send({
        id: 'chatcmpl_mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: round === 'tool' || round === 'tool-text' ? 'tool_calls' : 'stop' }],
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return server
}

export function createMockMemory(evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true })
  const seen = new Map() // idempotencyKey -> evidenceId
  const requests = []

  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    if (req.method === 'GET' && (url === '/v1/health' || url === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'mock-memory' }))
      return
    }
    if (req.method === 'GET' && url === '/__mock/requests') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(requests))
      return
    }
    if (req.method !== 'POST' || !url.startsWith('/v1/conversations/capture')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false}')
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"ok":false,"error":{"code":"BAD_REQUEST","message":"bad json"}}')
        return
      }
      requests.push({ at: new Date().toISOString(), event_id: body.event_id, conversation_id: body.conversation_id, source: body.source })
      const key = createHash('sha1')
        .update(JSON.stringify({ source: body.source, conversationId: body.conversation_id, eventId: body.event_id }))
        .digest('hex')
        .slice(0, 24)
      if (seen.has(key)) {
        const evidenceId = seen.get(key)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, evidenceId, evidencePath: join(evidenceDir, evidenceId + '.md'), deduped: true, duplicate: true }))
        return
      }
      const evidenceId = `conversation-${key}`
      const capturedAt = new Date().toISOString()
      const calendarDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
      const fm = [
        '---',
        `id: ${evidenceId}`,
        'type: conversation',
        `capturedAt: ${capturedAt}`,
        `calendarDate: ${calendarDate}`,
        'calendarTimezone: "Asia/Shanghai"',
        `source: "${body.source}"`,
        `conversationId: "${body.conversation_id}"`,
        `eventId: "${body.event_id}"`,
        'sessionId: ""',
        'frameworkId: "deepseek-harness"',
        `agentId: "${body.principal?.agent_id ?? 'pilot-01'}"`,
        `roleId: "${body.principal?.role_id ?? 'capture-ingest'}"`,
        `groupId: "${body.principal?.group_id ?? 'home-circle'}"`,
        `userId: "${body.principal?.user_id ?? 'user-owner'}"`,
        'partial: false',
        '---',
        '# 原始对话记录',
        '',
      ]
      const bodyMd = []
      for (const m of body.messages || []) {
        bodyMd.push(`## ${m.role === 'user' ? '用户' : '助手'}`, '', String(m.content ?? ''), '')
      }
      const path = join(evidenceDir, evidenceId + '.md')
      writeFileSync(path, fm.join('\n') + bodyMd.join('\n'), 'utf8')
      seen.set(key, evidenceId)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, evidenceId, evidencePath: path, deduped: false }))
    })
  })

  return { server, requests, files: () => readdirSync(evidenceDir).filter((f) => f.endsWith('.md')) }
}

if (process.argv[1] && process.argv[1].endsWith('reject1-mocks.mjs')) {
  const up = createMockUpstream()
  const mem = createMockMemory('D:\\MemoryLib\\logs\\mocks-evidence')
  up.listen(8910, '127.0.0.1', () => console.log('mock upstream on 8910'))
  mem.server.listen(8911, '127.0.0.1', () => console.log('mock memory on 8911'))
}
