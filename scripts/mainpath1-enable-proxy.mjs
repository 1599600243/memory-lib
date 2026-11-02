#!/usr/bin/env node
/**
 * MAINPATH-1 投用脚本：把 DSH 的默认对话路由指向本地捕获代理。
 *
 * ⚠️ 本脚本必须由**有 ~\.dsh\ 写权限**的角色执行（开发岗会话被沙箱限制为 workspace-write，
 *    实测该目录全部 DENY，见 reports/MAINPATH-1-dev-report.md「未覆盖什么」）。
 *
 * 用法：
 *   node scripts/mainpath1-enable-proxy.mjs                 # 只算不写：生成 backups\settings.yaml.candidate 供 diff
 *   node scripts/mainpath1-enable-proxy.mjs --apply         # 备份后真写
 *
 * 全部参数（括号内为默认值，默认走 DeepSeek 直连）：
 *   --upstream <URL>        (https://api.deepseek.com/v1)  代理自己往哪转
 *   --model <id>            (deepseek-flash)               DSH 请求的 model id
 *   --api-key-env <NAME>    (DEEPSEEK_API_KEY)             provider 从哪个环境变量取 key
 *   --api <kind>            (openai-completions)           openai-completions | openai-responses
 *   --context-window <n>    (1048576)
 *   --max-tokens <n>        (65536)
 *   --port <n>              (8899)                         本地代理端口
 *   --provider-id <id>      (mainpath-proxy)               注入 settings 的 provider 名
 *
 * 做的事（最小侵入，不动现有 gpt/cc/grok/img/deepseek 五个 provider）：
 *   1. 在 llm-pi-ai.providers 下新增 mainpath-proxy 提供方，baseURL 指向 http://127.0.0.1:<port>/v1
 *   2. 把 agent-default-model.provider / model 指向它
 *   3. 写盘前备份为 settings.yaml.bak-<时间戳>
 *
 * 为什么不是"只改一个 baseURL"：实测 agent-default-model.provider 当前值是 deepseek-official，
 * 它不在 settings.yaml 的 llm-pi-ai.providers 里（属框架内置路由），改任何 pi-ai provider 的 baseURL
 * 都不会让默认流量经过代理。必须新增/切换 provider 才真正生效。
 *
 * 为什么默认 DeepSeek 直连而非聚合网关：blackaicoding 网关 2026-10-19 出过两次故障
 * （短暂不可达 / insufficient balance），不能当默认。DeepSeek 官方直连实测 /v1/models 200，
 * 可用模型 deepseek-flash、deepseek-v4-pro。
 *
 * 回滚：把备份拷回去再重启 DSH（见报告里的一行命令）。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'

const DSH_SETTINGS = 'C:\\Users\\admin\\.dsh\\settings.yaml'
const BACKUP_DIR = 'D:\\MemoryLib\\backups'
const CANDIDATE = `${BACKUP_DIR}\\settings.yaml.candidate`

const APPLY = process.argv.includes('--apply')
const argOf = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d)
const PORT = argOf('port', '8899')
const MODEL = argOf('model', 'deepseek-flash')
const API_KEY_ENV = argOf('api-key-env', 'DEEPSEEK_API_KEY')
const API_KIND = argOf('api', 'openai-completions')
const UPSTREAM = argOf('upstream', 'https://api.deepseek.com/v1')
const CTX_WINDOW = argOf('context-window', '1048576')
const MAX_TOKENS = argOf('max-tokens', '65536')
const PROVIDER_ID = argOf('provider-id', 'mainpath-proxy')

if (!['openai-completions', 'openai-responses'].includes(API_KIND)) {
  throw new Error(`--api must be openai-completions or openai-responses, got: ${API_KIND}`)
}

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const src = readFileSync(DSH_SETTINGS, 'utf8')
const lines = src.split(/\r?\n/)

// ---- 1. 定位 agent-default-model 块
const admIdx = lines.findIndex((l) => /^agent-default-model:\s*$/.test(l))
if (admIdx < 0) throw new Error('agent-default-model block not found')
let admEnd = admIdx + 1
while (admEnd < lines.length && (lines[admEnd].startsWith(' ') || lines[admEnd].trim() === '')) admEnd++

let providerTouched = false
let modelTouched = false
for (let i = admIdx + 1; i < admEnd; i++) {
  if (/^\s+provider:\s*\S+/.test(lines[i])) {
    lines[i] = `  provider: ${PROVIDER_ID}`
    providerTouched = true
  } else if (/^\s+model:\s*\S+/.test(lines[i])) {
    lines[i] = `  model: ${MODEL}`
    modelTouched = true
  }
}
if (!providerTouched) lines.splice(admIdx + 1, 0, `  provider: ${PROVIDER_ID}`)
if (!modelTouched) lines.splice(admIdx + 1, 0, `  model: ${MODEL}`)

// ---- 2. 在 llm-pi-ai.providers 下插入新 provider（放在 agent-presets 之前）
const alreadyPresent = lines.some((l) => new RegExp(`^\\s{4}${PROVIDER_ID}:\\s*$`).test(l))
if (!alreadyPresent) {
  const anchor = lines.findIndex((l) => /^agent-presets:\s*$/.test(l))
  if (anchor < 0) throw new Error('agent-presets anchor not found')
  const block = [
    `    ${PROVIDER_ID}:`,
    `      displayName: MAINPATH-1 capture proxy (local)`,
    `      # 由 scripts/mainpath1-enable-proxy.mjs 注入；DSH 只看到本地代理，代理再转发真正的上游。`,
    `      # 代理需以 --upstream ${UPSTREAM} 启动（真正的上游写在这条注释里，DSH 不读它）。`,
    `      api: ${API_KIND}`,
    `      baseURL: http://127.0.0.1:${PORT}/v1`,
    `      apiKeyEnv: ${API_KEY_ENV}`,
    `      defaultContextWindow: ${CTX_WINDOW}`,
    `      defaultMaxTokens: ${MAX_TOKENS}`,
    `      models:`,
    `        - id: ${MODEL}`,
    `          name: ${MODEL}`,
    `          contextWindow: ${CTX_WINDOW}`,
    `          maxTokens: ${MAX_TOKENS}`,
    ``,
  ]
  lines.splice(anchor, 0, ...block)
}

const out = lines.join('\n')

mkdirSync(BACKUP_DIR, { recursive: true })
writeFileSync(CANDIDATE, out, 'utf8')
console.log(`candidate written: ${CANDIDATE}  (${out.length} bytes)`)

// ---- 3. 打印差异摘要
const before = src.split(/\r?\n/)
console.log('\n── diff（原始 → 候选）──')
const show = (tag, ls) => ls.forEach((l, i) => console.log(`${tag} ${String(i + 1).padStart(4)}| ${l}`))
const srcAdm = before.slice(admIdx, admEnd)
console.log('[agent-default-model] before:')
show('  -', srcAdm)
const candAdmLines = out.split(/\r?\n/)
const cAdmIdx = candAdmLines.findIndex((l) => /^agent-default-model:\s*$/.test(l))
console.log('[agent-default-model] after:')
show('  +', candAdmLines.slice(cAdmIdx, cAdmIdx + (admEnd - admIdx) + 2))
const insIdx = candAdmLines.findIndex((l) => new RegExp(`^\\s{4}${PROVIDER_ID}:\\s*$`).test(l))
if (insIdx >= 0) {
  console.log('[new provider] after:')
  show('  +', candAdmLines.slice(insIdx, insIdx + 14))
}

console.log('\n── 配套的代理启动命令（baseURL 生效前必须先起代理，否则对话 502）──')
console.log(
  `node D:\\MemoryLib\\scripts\\capture-proxy.mjs --port ${PORT} --upstream ${UPSTREAM}`,
)

if (!APPLY) {
  console.log('\nDRY-RUN：未写入 settings.yaml。加 --apply 才会备份并落盘。')
  console.log(`将执行的备份：${DSH_SETTINGS} -> ${BACKUP_DIR}\\settings.yaml.bak-${ts()}`)
  process.exit(0)
}

// ---- 4. 真写（先备份）
const bak = `${BACKUP_DIR}\\settings.yaml.bak-${ts()}`
copyFileSync(DSH_SETTINGS, bak)
writeFileSync(DSH_SETTINGS, out, 'utf8')
console.log(`\nAPPLIED. backup=${bak}`)
console.log(`回滚一行：Copy-Item "${bak}" "${DSH_SETTINGS}" -Force; Restart DSH`)
console.log('然后重启 DSH 让 baseURL 生效（配置在启动时加载）。')
