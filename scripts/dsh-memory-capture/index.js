// DSH 实时自动记忆捕获插件（Cordis）— IN-PLUGIN-1 第一步：只做捕获
//
// 形态：DSH **原生 Cordis 插件**，跑在 DSH web 进程内，监听 ctx.on('session/event')，
// 把每个 turn 的真人消息 + 助手正文提交给 memory-lib 的 /v1/conversations/capture。
//
// 为什么要有这个文件（而不是继续挂在代理上）：
//   捕获以前挂在出向网关（capture-proxy 8899）上，于是"能不能捕获"取决于
//   "这个会话的 provider 指向哪"。实测：老会话跑了一下午 8 小时，代理日志 0 行、一条没进库。
//   用户裁决：捕获由智能体每轮自己发一份，**与用哪个模型无关**。
//
// ── 注入（IN-PLUGIN-2 接回来的第二步）────────────────────────────────
// `inject = ["systemPrompt"]` + `ctx.systemPrompt.section()`：把 `POST /v1/recall/brief`
// 的简报（≤600 字、标「不可信输入」、`{{` 已拆）挂进每一轮的系统提示。
// brief 在旁路预热（启动 / 每 60 秒 / 每轮结束），section 同步取现成块；
// 与代理共用 `logs/inject-receipt.json` 保证同一轮只有一边注入。详见下方 INJECT 段注释。
//
// ── 相对旧实现的四处返工（范围单 §三，今天断 2.5 天的根因）────────────
//   ① 旧：maxTurn 单调游标 —— 第 N 轮失败后只要第 N+1 轮成功，游标就越过 N，
//      那一轮**永远不再重试**（"失败仍推进游标"）。新：**按 turn 记账**，
//      失败不推进；同一 turn 最多 3 次，超限进死信（落文件、带原因）。
//   ② 旧：内存里的 retry 数组无限增长、无上限、进程重启就全丢。
//      新：待发的一律先落盘到 queue/，逐条处理；接口是"文件队列 + 死信"，不维护无界内存队列。
//   ③ 旧：没有任何可见性。新：同目录 status.mjs，一条命令答出
//      最近成功时间 / 连续失败数 / 死信条数 / 待发条数。
//   ④ 旧：同步 fs + fetch 无超时 + 异步链没有兜底。新：**全异步**、每次请求
//      5s 超时、所有入口全包 try/catch —— 任何异常只记账，绝不抛回宿主、绝不阻塞 turn。
//
// 与外部轮询捕获器（<dshHome>/memory-capture/capture.mjs）**不再共享水位**：
// 那份已停用，且旧水位用的是有缺陷的 maxTurn 口径。旧 state.json 只当档案读，不参与判定。

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  MAX_ATTEMPTS,
  MAX_TEXT,
  POST_TIMEOUT_MS,
  PRUNE_DONE_DAYS,
  RETRY_INTERVAL_MS,
  buildCaptureEvent,
  emptyState,
  legacySessionCount,
  nextAttemptVerdict,
  postCapture,
  sessionIdOf,
  summarizeState,
  textOf,
  turnKeyOf,
  workspaceOf,
} from "./capture-core.mjs";

const name = "memory-capture";
// IN-PLUGIN-2：把注入接回来。挂 systemPrompt 服务才能拿到 ctx.systemPrompt.section()。
const inject = ["systemPrompt"];

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const WORK_DIR = process.env.INPLUGIN1_WORK_DIR ?? path.join(HOME, "memory-capture");
const STATE_FILE = path.join(WORK_DIR, "capture-state-v2.json");
const LEGACY_STATE_FILE = path.join(WORK_DIR, "state.json");
const QUEUE_DIR = path.join(WORK_DIR, "queue");
const DEAD_DIR = path.join(WORK_DIR, "dead");
const LOG_FILE = path.join(WORK_DIR, "realtime.log");
const PATCH_FILE = path.join(HOME, "profiles", "web", "cordis.patch.yml");
const API_BASE = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const SECRET_CACHE_MS = 60_000;

// ---------------------------------------------------------------- REFINE-TRIGGER-1：提炼触发
//
// 为什么要有这一段：捕获已经在插件里了（与模型无关），但**提炼触发还挂在代理上**，
// 而代理只服务"走代理的会话"⇒ 老会话捕获进库的东西永远不会被自动提炼
// （实测：待提炼 921 条、没有提炼进程在跑）。
//
// 三条纪律：
//   ① **复用**代理那份 `refine-trigger.mjs`（同一个文件，不另写一套），所以节流/锁/fail-open
//      的口径天然一致；模块路径可用 DSH_REFINE_MODULE 覆盖。
//   ② **与代理共用同一个 lock 与 trigger 状态文件**（默认都落在 D:\MemoryLib\logs 与 state），
//      所以两边同一时刻只会有一个提炼进程；谁先抢到锁谁跑。
//   ③ 提炼是**独立子进程**（refine-worker.mjs，要调模型几十秒），插件只负责"发一个 trigger"，
//      绝不等待结果、绝不把提炼跑进宿主进程。
const REFINE = {
  enabled: !/^(off|false|0|no)$/i.test(String(process.env.DSH_REFINE_ENABLED ?? "on").trim()),
  modulePath: process.env.DSH_REFINE_MODULE ?? "D:\\MemoryLib\\scripts\\refine-trigger.mjs",
  workerPath: process.env.DSH_REFINE_WORKER ?? "D:\\MemoryLib\\scripts\\refine-worker.mjs",
  logDir: process.env.DSH_REFINE_LOG_DIR ?? "D:\\MemoryLib\\logs",
  stateFile: process.env.DSH_REFINE_STATE ?? "D:\\MemoryLib\\state\\refine-state.json",
  evidenceDir: process.env.DSH_REFINE_EVIDENCE ?? "D:\\MemoryLib\\data\\memory\\evidence\\conversations",
  api: process.env.DSH_REFINE_API ?? API_BASE,
  dataRoot: process.env.DSH_REFINE_DATA_ROOT ?? "D:\\MemoryLib\\data\\memory",
  limit: Number(process.env.DSH_REFINE_LIMIT ?? 10),
  minIntervalMs: Number(process.env.DSH_REFINE_MIN_INTERVAL_MS ?? 60_000),
};

let refineModule = null; // 惰性 import：模块不在/报错也绝不能影响捕获
let refineBroken = false;

async function loadRefineModule() {
  if (refineModule) return refineModule;
  if (refineBroken) return null;
  try {
    const mod = await import(pathToFileURL(REFINE.modulePath).href);
    if (typeof mod.maybeRefine !== "function") throw new Error("模块里没有 maybeRefine");
    refineModule = mod;
    return mod;
  } catch (e) {
    refineBroken = true; // 只报一次，别每轮刷日志
    await log(`WARN 提炼触发模块加载失败（捕获不受影响）：${e?.message ?? e}`);
    return null;
  }
}

/**
 * 捕获成功后异步触发一次提炼。**绝不 await 结果、绝不抛回调用方**。
 * 真正的决策（60 秒节流、锁、有没有待提炼）全在 refine-trigger.mjs 里，这里只负责"叫一声"。
 */
async function triggerRefine(conversationId) {
  if (!REFINE.enabled) return;
  try {
    const mod = await loadRefineModule();
    if (!mod) return;
    const p = mod.defaultPaths({ logDir: REFINE.logDir, stateFile: REFINE.stateFile });
    const r = await mod.maybeRefine({
      stateFile: p.triggerStateFile,
      lockFile: p.lockFile,
      logFile: p.triggerLogFile,
      workerPath: REFINE.workerPath,
      workerLogFile: p.workerLogFile,
      refineStateFile: p.refineStateFile,
      evidenceDir: REFINE.evidenceDir,
      enabled: true,
      conversationId: conversationId ?? null,
      limit: REFINE.limit,
      minIntervalMs: REFINE.minIntervalMs,
      globalMinIntervalMs: REFINE.minIntervalMs,
      extraArgs: ["--api", REFINE.api, "--data-root", REFINE.dataRoot],
      log: (rec) => void log(`REFINE ${JSON.stringify(rec)}`),
    });
    if (r?.triggered) {
      await log(`REFINE-DONE ok=${r.ok === true} pending=${r.pending ?? "-"} dur=${r.durationMs ?? "-"}ms${r.error ? ` err=${r.error}` : ""}`);
    }
  } catch (e) {
    // fail-open：提炼这条路怎么炸都不许影响捕获与对话
    await log(`REFINE-WARN ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------- IN-PLUGIN-2：注入长期记忆
//
// 为什么要有这一段：捕获与提炼触发都已经在插件里了（与模型无关），但**注入还挂在代理上**
// ⇒ 只有"走代理的会话"才会自动带上记忆，老会话（不走代理）永远拿不到背景。
//
// 五条纪律（范围单 §二-1）：
//   ① 内容来自 `POST /v1/recall/brief`（format=prompt），**≤600 字**；
//   ② 必须标「不可信输入，仅供背景」，并把 `{{` 拆成 `{ {`
//      —— `systemPrompt` 的变量插值是**严格**的：畸形/未知引用会让整轮 prompt 组装直接抛错，
//      所以这里沿用代理那份 `buildInjectionBlock()`（先拆再截），一个字都不自己重写；
//   ③ **同一会话 60 秒节流**，且与代理**共用一份注入回执**（`logs/inject-receipt.json`），
//      保证同一轮只有一边注入（谁先谁后见 inject-receipt.mjs 的注释）；
//   ④ **工具轮不注入**（`tool/call`、`tool/result` 之后的那几步）；
//   ⑤ **fail-open**：brief 取不到 / 超时（≤3s）⇒ 这轮不注入，对话照常；日志记原因。
//
// 关键的实现约束（决定代码长这样）：
//   `systemPrompt.section()` 的 `text` 必须是**同步**函数（system-prompt 的 assemble 里是
//   `section.text(context)`，不 await），而 brief 是网络调用。
//   所以注入分两半：
//     · `ctx.systemPrompt.section()` 提供**槽位**（name/order 就是范围单说的那个），
//       它的 text 恒为 ""（空 section 会被 host 丢掉，不占任何字）；
//     · `ctx.on("system-prompt/assemble")` 这个 **waterfall** 在每次真正组装 prompt 前跑，
//       它是 async 的 ⇒ 在这里按 ≤3s 预算取 brief、认领回执、再把**本轮的文本**填进那个槽位。
//   为什么不用"预热缓存 + section 同步取"：那样注入的永远是**上一轮**的记忆，
//   用户问"记忆库是几层"时拿到的却是上一个话题的背景 —— 相关性会差一轮。
//   waterfall 是 async 的，取的 query 就是用户**这一句**，相关性不打折；
//   超时就放弃（fail-open），不阻塞事件循环。
const INJECT = {
  enabled: !/^(off|false|0|no)$/i.test(String(process.env.DSH_INJECT_ENABLED ?? "on").trim()),
  modulePath: process.env.DSH_INJECT_MODULE ?? "D:\\MemoryLib\\scripts\\inject-context.mjs",
  receiptModulePath: process.env.DSH_INJECT_RECEIPT_MODULE ?? "D:\\MemoryLib\\scripts\\inject-receipt.mjs",
  receiptFile: process.env.DSH_INJECT_RECEIPT ?? "D:\\MemoryLib\\logs\\inject-receipt.json",
  briefUrl: process.env.DSH_INJECT_BRIEF_URL ?? `${API_BASE}/v1/recall/brief`,
  maxChars: Number(process.env.DSH_INJECT_MAX_CHARS ?? 600),
  throttleMs: Number(process.env.DSH_INJECT_THROTTLE_MS ?? 60_000),
  timeoutMs: Number(process.env.DSH_INJECT_TIMEOUT_MS ?? 3_000),
  agent: process.env.DSH_INJECT_AGENT ?? "pilot-01",
  role: process.env.DSH_INJECT_ROLE ?? "reader",
  sectionName: "memory-lib:recall",
  sectionOrder: 150, // 约定：0=人格，100-199=工具/指引类
};

// ---------------------------------------------------------------- IN-PLUGIN-3：问句按会话隔离
//
// 为什么要有这一段（真机事故，见 orders/IN-PLUGIN-3-query-isolation.md）：
//   改前 `injectRuntime.lastUserTexts` 是个**模块级数组**，任何会话的真人消息都往里塞；
//   query = 全局最后 4 条拼起来 ⇒ 给 A 会话组装的背景，可能是拿**最后说话的那个会话（B）**
//   的话去检索的。实测：干净会话问「我们记忆库是几层？」，注入日志 queryChars=136，
//   而该会话最后一条真人消息只有 32 字，注入的 4 条里也没有那条「记忆库收敛为8层」。
//
// 三条纪律：
//   ① **按会话隔离**：Map<sessionId, string[]>，与 sections 同一套生命周期；
//      会话结束（session/end-seed / 宿主 session/disposed）就删掉，别无限增长。
//   ② **问句保守**：默认只用**最后一条**真人消息；只有它去空白后 <6 字（「发」「继续」「嗯」）时，
//      才回补**同一会话**的前一条，最多 2 条。绝不跨会话、绝不把长历史整段拼进去。
//   ③ **有上限且确定性淘汰**：最多留 500 个会话；每次写入先把该会话删掉再设回去
//      ⇒ 这张表的插入序就是"最近触达序"，淘汰时取**最前面**那个。
//      纯按事件顺序淘汰，不看时钟：同一串事件永远淘汰同一个会话（可断言、可复现）。
const QUERY = {
  maxMessages: 2, // 一次 query 最多用几条真人消息（最后一条 + 至多回补一条）
  shortChars: Number(process.env.DSH_INJECT_SHORT_QUERY_CHARS ?? 6), // 去空白后 <6 字 ⇒ 算"太短，要回补"
  keepMessages: 2, // 每个会话只留最近几条（回补最多只要 2 条，多留没用还占内存）
  maxSessions: Number(process.env.DSH_INJECT_MAX_QUERY_SESSIONS ?? 500), // 会话数上限
  maxTextChars: 2000, // 单条真人文本入库上限（与改前一致）
  maxQueryChars: 4000, // 最终 query 上限（与改前一致）
  headChars: 60, // 日志里 queryHead 取问句前多少字
};

// ---------------------------------------------------------------- IN-PLUGIN-4：首步也要拿得到本轮问句
//
// 为什么还要这一段（真机回归，见 orders/IN-PLUGIN-4-first-step-injection.md）：
//   IN-PLUGIN-3 把"问句按会话隔离"修对了，真机立刻暴露另一件事 ——
//   **一轮里的第 1 个 model step 永远拿不到本轮用户的话** ⇒ blockedBy=no-query ⇒ 单步轮次永不注入。
//   宿主真正的顺序（dsh-agent-loop/lib/index.js，版本以已部署的 @deepseek-ai/dsh-agent-loop 为准）：
//     496  const claimed = this.inbox.claim(target, turn)          // 先把消息从 inbox 取走
//     497  await this.loopCtx.systemPrompt.assemble(...)           // ★ 组装 prompt（我们的 waterfall 在这里跑）
//     548  this.session.append("step/start", {turn, step})
//     554  for (const m of decision.messages) this.session.append("user/message", m)   // ★ 用户的话这时才落盘
//   旧代码唯一的写入点是 `session/event` 的 `user/message`，它就来自第 554 行
//   ⇒ 第 1 步 assemble 时问句表**还是空的**；第 2 步才看得到（于是"多步才注入"）。
//   只读解压真机会话日志也一致：turn/start → step/start → user/message（见开发报告 §二）。
//
// 为什么不走范围单的"首选"（在 assemble 的 assembly/context 里取本轮用户消息）：那两处**没有会话消息**。
//   · assembly = { sections:[{name,text}], contexts:[{name,text}], tools:[...], variables:{...} }
//     （dsh-system-prompt/lib/index.js:267-282 构造出这四键；活 host 的 Event 契约同）
//     —— contexts 是 time-context 这类"动态上下文提供者"，不是对话消息；
//   · context  = { agent, scope: agent, signal? }（dsh-agent/lib/types/dispatch.js assembleContextFor）
//     —— 唯一能通到消息的是 context.agent.session，但第 554 行之前本轮消息**还没进 session**。
//
// 所以走范围单的"备选"：宿主在**入队时**就发 `agent/inbox/inserted`
//   （dsh-agent-loop:357-360 —— send() → inbox.splice → emit("agent/inbox/inserted", {message})），
//   它早于 turn/start、早于 assemble；payload = { agent, message }，message 就是宿主随后要落盘的
//   那条 UserMessage（source.kind === "user"）。在这个时刻记一笔，首步就有本轮问句了。
//   **仍然按会话隔离**（key = agent.id，与 session.id 同一身份），没有回退成全局数组。
// 同一条消息因此会到两次（入队一次 + 落盘一次）⇒ rememberUserText 里做"相邻同文本只留一条"。

// 会话结束信号：DSH 的 `session/event` 里终态只有这一个（见宿主 SessionEventMap）。
const SESSION_END_EVENTS = new Set(["session/end-seed"]);

// IN-PLUGIN-4：`agent/inbox/inserted` 里哪些来源才算"用户说的话"。
// 真机会话日志实测到的 source.kind：user / agent-instructions / plugin / skill-catalog；
// 后三种也是以 user/message 落盘的，只看 payload 不看 kind 会把它们当成用户问句。
const INBOX_USER_KIND = "user";
const RUNTIME_CONTEXT_PREFIX = "Current runtime context";

let injectModules = null; // { ctx: 注入纯函数, receipt: 回执 } 惰性加载；坏了只报一次
let injectBroken = false;

const injectRuntime = {
  // IN-PLUGIN-3：**问句的唯一来源**。sessionId -> 该会话最近几条真人文本。
  // 改前这里是模块级数组 `lastUserTexts`（所有会话共用）⇒ 这就是注入串味的根因。
  queryTexts: new Map(),
  sections: new Map(), // sessionId -> { toolRound, served, declined }
  stats: { ok: 0, skipped: 0, failed: 0, briefOk: 0, briefFail: 0, lastReason: null, inboxSeeds: 0 },
  lastOk: null,
  lastSkip: null,
  inflight: new Map(), // sessionId -> Promise（同一会话的并发组装只取一次 brief）
};

async function loadInjectModules() {
  if (injectModules) return injectModules;
  if (injectBroken) return null;
  try {
    const ctxMod = await import(pathToFileURL(INJECT.modulePath).href);
    const rcptMod = await import(pathToFileURL(INJECT.receiptModulePath).href);
    if (typeof ctxMod.fetchBrief !== "function" || typeof ctxMod.buildInjectionBlock !== "function") {
      throw new Error("inject-context.mjs 里没有 fetchBrief/buildInjectionBlock");
    }
    if (typeof rcptMod.claimReceipt !== "function") throw new Error("inject-receipt.mjs 里没有 claimReceipt");
    injectModules = { ctx: ctxMod, receipt: rcptMod };
    return injectModules;
  } catch (e) {
    injectBroken = true; // 只报一次
    await log(`WARN 注入模块加载失败（注入停用，捕获/提炼不受影响）：${e?.message ?? e}`);
    return null;
  }
}

/** 注入用的身份：与代理同一套（`pilot-01/reader` 有 search；capture-ingest 只有 propose）。 */
async function loadInjectAuth() {
  const base = await loadAuth();
  if (!base) return null;
  return { credential_ref: base.credential_ref, secret: base.secret, principal: { agent_id: INJECT.agent, role_id: INJECT.role } };
}

function sessionStateOf(sessionId) {
  let st = injectRuntime.sections.get(sessionId);
  if (!st) {
    st = { toolRound: false, served: false, declined: false };
    injectRuntime.sections.set(sessionId, st);
    // 会话多了别让这张表无界增长
    if (injectRuntime.sections.size > 500) {
      const first = injectRuntime.sections.keys().next();
      if (!first.done && first.value !== sessionId) injectRuntime.sections.delete(first.value);
    }
  }
  return st;
}

/**
 * IN-PLUGIN-3：上限 500 个会话，**确定性**淘汰。
 * 淘汰"插入序最前面的那个" = 最早被触达的会话（每次写入都会把该会话移到末尾）。
 * 不看时钟、不随机：同一串事件永远淘汰同一个会话，测试可以断言具体是哪一个。
 */
function evictQueryTexts(keepSessionId) {
  while (injectRuntime.queryTexts.size > QUERY.maxSessions) {
    const first = injectRuntime.queryTexts.keys().next();
    if (first.done || first.value === keepSessionId) return;
    injectRuntime.queryTexts.delete(first.value);
  }
}

/**
 * 记一条真人消息到**本会话**的问句表。别的会话读不到（这就是隔离）。
 * IN-PLUGIN-4：同一条消息会来两次（宿主入队一次 `agent/inbox/inserted`、落盘一次 `user/message`），
 * 相邻同文本只留一条 —— 否则短句回补（<6 字）会把"自己"当成上一条，问句变成「继续\n继续」。
 * @returns {boolean} 是否新增了一条（false = 重复被吸收，或入参非法）
 */
function rememberUserText(sessionId, text) {
  const t = String(text ?? "").slice(0, QUERY.maxTextChars);
  if (!sessionId || !t || !t.trim()) return false;
  const arr = (injectRuntime.queryTexts.get(sessionId) ?? []).slice();
  if (arr.length && arr[arr.length - 1] === t) {
    // 内容没变 ⇒ 不新增，但仍算"最近触达"（这张表的插入序就是淘汰顺序）
    injectRuntime.queryTexts.delete(sessionId);
    injectRuntime.queryTexts.set(sessionId, arr);
    return false;
  }
  arr.push(t);
  if (arr.length > QUERY.keepMessages) arr.splice(0, arr.length - QUERY.keepMessages);
  injectRuntime.queryTexts.delete(sessionId); // 先删再设 ⇒ 插入序 = 最近触达序（淘汰靠它）
  injectRuntime.queryTexts.set(sessionId, arr);
  evictQueryTexts(sessionId);
  return true;
}

/**
 * IN-PLUGIN-4：宿主**入队**时就把本轮用户文本记到本会话问句表。
 * 这一步发生在 turn/start 与 assemble 之前（宿主 send() → inbox.splice → emit），
 * 所以一轮的**第 1 个 model step** 也有话可用 —— 这是"单步轮次也能注入"的唯一依靠。
 * 只认宿主的真人消息：`source.kind === "user"` 且不是运行时上下文快照；
 * 其它来源（agent-instructions / plugin / skill-catalog）跳过，它们同样是 user/message 落盘的。
 * @param payload - 宿主 `agent/inbox/inserted` 的 payload：{ agent, message }
 * @returns {{sessionId: string, first: boolean, chars: number, head: string} | null} 记上了才返回
 */
function rememberInboxMessage(payload) {
  const agent = payload?.agent;
  const message = payload?.message;
  if (!message) return null;
  const sessionId = agent?.id ?? sessionIdOf(agent?.session);
  if (!sessionId) return null;
  if (message?.source?.kind !== INBOX_USER_KIND) return null;
  const text = textOf(message?.content);
  if (!text || text.startsWith(RUNTIME_CONTEXT_PREFIX)) return null;
  const first = (injectRuntime.queryTexts.get(sessionId)?.length ?? 0) === 0;
  const added = rememberUserText(sessionId, text);
  if (!added) return null; // 重复的入队（或与落盘那条同文本）⇒ 表里没变化，不记日志
  injectRuntime.stats.inboxSeeds += 1;
  return { sessionId, first, chars: text.length, head: queryHeadOf(text) };
}

/** 会话结束/被销毁：把这个会话的问句删掉（别无限增长，也别让复活的会话捡到旧话）。 */
function dropSessionQuery(sessionId) {
  return injectRuntime.queryTexts.delete(sessionId);
}

/**
 * 本轮 brief 的 query —— **只看这个会话自己的话**：
 *   · 最后一条真人消息去空白后 ≥6 字 ⇒ 就它一个（默认路径）；
 *   · 更短（「发」「继续」「嗯」）⇒ 回补**同一会话**的前一条，最多 2 条；
 *   · 没有前一条可用（新会话第一句就是短句）⇒ 只有这一条，**绝不从别的会话借**。
 */
function buildQueryFor(sessionId) {
  const arr = injectRuntime.queryTexts.get(sessionId);
  if (!arr || !arr.length) return { text: "", used: 0 };
  const last = arr[arr.length - 1] ?? "";
  if (last.trim().length >= QUERY.shortChars) return { text: last.slice(0, QUERY.maxQueryChars), used: 1 };
  const prev = arr.length > 1 ? (arr[arr.length - 2] ?? "") : "";
  if (!prev.trim()) return { text: last.slice(0, QUERY.maxQueryChars), used: 1 };
  return { text: `${prev}\n${last}`.slice(0, QUERY.maxQueryChars), used: 2 };
}

/**
 * 日志用的问句头部（前 60 字，原样截断，不压空白 —— 要是真实问句的**忠实前缀**）。
 * 这次排查缺的就是这个：只有 queryChars 时，没法看出"背景是基于哪句话检索来的"。
 */
function queryHeadOf(query) {
  return String(query ?? "").slice(0, QUERY.headChars);
}

/** 从 assemble 的 context 里取会话 id（几种形状都认；取不到就当"不知道是谁"，不注入）。 */
function sessionIdFromContext(context) {
  const agent = context?.agent;
  const session = agent?.session;
  const id = session?.id ?? session?.header?.id ?? agent?.sessionId ?? context?.session?.id ?? null;
  return typeof id === "string" && id ? id : null;
}

/**
 * 把注入块填进**本轮**的 assembly。返回新的 assembly（不改原对象）。
 * 任何异常都只记日志、原样返回 —— prompt 组装绝不因为记忆注入而失败。
 */
async function injectIntoAssembly(assembly, context) {
  if (!INJECT.enabled) return assembly;
  const sessionId = sessionIdFromContext(context);
  if (!sessionId) return assembly;

  const st = sessionStateOf(sessionId);
  if (st.toolRound) return assembly; // ④ 工具轮不注入
  if (st.served) return assembly; // 同一轮只注入一次（后续 step 不再取、不再占窗口）
  if (st.declined) return assembly; // 本轮已判过"让位/没内容"，别每个 step 都重判

  // 槽位必须已经在 assembly 里；被别的插件整段替换掉（complete section）时明说，不硬塞
  const slot = (assembly.sections ?? []).find((s) => s.name === INJECT.sectionName);
  // IN-PLUGIN-3：先把"这一轮拿哪句话去检索"算出来（纯内存读，无副作用、不联网），
  // 好让**每一条**注入日志都带 queryHead + sessionId —— 排查时一眼看出"基于哪句话"。
  // 注意：query 为空时**仍然照旧**在 no-credential 之后才判 no-query，跳过原因的优先级没有变。
  const { text: query, used: queryUsed } = buildQueryFor(sessionId);
  const queryHead = queryHeadOf(query);

  if (!slot) {
    st.declined = true;
    injectRuntime.stats.skipped += 1;
    injectRuntime.stats.lastReason = "no-section-slot";
    await log(`inject_skipped ${JSON.stringify({ conversationId: sessionId, sessionId, blockedBy: "no-section-slot", queryHead, reason: "prompt 里没有 memory-lib:recall 槽位（可能被 complete section 整段替换），不注入" })}`);
    return assembly;
  }

  const mods = await loadInjectModules();
  if (!mods) return assembly;

  // 先**只读**看一眼回执：窗口被占着（自己刚注入过 / 代理刚注入过）就别白打一次 brief。
  // 真正的认领在取到内容之后（拿不到内容不许占窗口），两处判定用的是同一个纯函数。
  const peekDecision = mods.receipt.decideClaim(mods.receipt.readReceipt(INJECT.receiptFile), {
    source: mods.receipt.SOURCE_PLUGIN,
    conversationId: sessionId,
    windowMs: INJECT.throttleMs,
  });
  if (!peekDecision.allow) {
    st.declined = true;
    injectRuntime.stats.skipped += 1;
    injectRuntime.stats.lastReason = peekDecision.blockedBy;
    const rec = { conversationId: sessionId, sessionId, blockedBy: peekDecision.blockedBy, queryHead, reason: peekDecision.reason, stage: "prefetch" };
    injectRuntime.lastSkip = rec;
    await log(`inject_skipped ${JSON.stringify(rec)}`);
    return assembly;
  }

  const auth = await loadInjectAuth();
  if (!auth) {
    st.declined = true;
    injectRuntime.stats.failed += 1;
    injectRuntime.stats.lastReason = "no-credential";
    await log(`inject_skipped ${JSON.stringify({ conversationId: sessionId, sessionId, blockedBy: "no-credential", queryHead, reason: "拿不到 read 身份，不注入" })}`);
    return assembly;
  }

  // IN-PLUGIN-3：query 已在上面按**本会话**算好（改前是全局 lastUserTexts 拼 4 条 ⇒ 串味）
  if (!query) {
    st.declined = true;
    injectRuntime.stats.skipped += 1;
    injectRuntime.stats.lastReason = "no-query";
    await log(`inject_skipped ${JSON.stringify({ conversationId: sessionId, sessionId, blockedBy: "no-query", queryHead, reason: "这个会话还没说话（或只说了一句空白），不知道要取什么，不注入" })}`);
    return assembly;
  }

  // ⑤ fail-open：brief 有硬超时（默认 3s），拿不到就不注入
  const brief = await mods.ctx.fetchBrief({
    url: INJECT.briefUrl,
    credentialRef: auth.credential_ref,
    secret: auth.secret,
    principal: auth.principal,
    query,
    maxChars: INJECT.maxChars,
    timeoutMs: INJECT.timeoutMs,
  });
  if (!brief.ok) {
    st.declined = true;
    injectRuntime.stats.failed += 1;
    injectRuntime.stats.lastReason = brief.error ?? "brief-failed";
    await log(`inject_failed ${JSON.stringify({ conversationId: sessionId, sessionId, error: brief.error ?? "unknown", queryHead, briefMs: brief.ms, reason: "brief 失败，不注入（对话照常）", url: INJECT.briefUrl })}`);
    return assembly;
  }
  if (brief.empty || !brief.text) {
    st.declined = true;
    injectRuntime.stats.skipped += 1;
    injectRuntime.stats.lastReason = "empty";
    await log(`inject_skipped ${JSON.stringify({ conversationId: sessionId, sessionId, blockedBy: "empty", queryHead, reason: "记忆里没有相关内容，不注入（也不许编）", briefMs: brief.ms })}`);
    return assembly;
  }
  injectRuntime.stats.briefOk += 1;

  const block = mods.ctx.buildInjectionBlock(brief.text, INJECT.maxChars);
  // INJECT-FIX-1：maxChars 是完整段预算。helper 已按整条装箱，这里对渲染结果再做硬断言；
  // 任何空段/超预算都 fail-open，不认领回执，也不把半句塞进系统提示。
  if (!block || block.length > INJECT.maxChars) {
    st.declined = true;
    injectRuntime.stats.skipped += 1;
    injectRuntime.stats.lastReason = block ? "render-over-budget" : "no-whole-item-fits";
    await log(`inject_skipped ${JSON.stringify({ conversationId: sessionId, sessionId, blockedBy: injectRuntime.stats.lastReason, queryHead, briefMs: brief.ms, maxChars: INJECT.maxChars, renderedChars: block.length, reason: "完整注入段没有可用整条或渲染后超预算，不注入" })}`);
    return assembly;
  }
  const renderedItems = block.split(/\r?\n/u).slice(1).filter((line) => line.trim()).length;
  const sourceItems = String(brief.text).split(/\r?\n/u).filter((line) => line.trim()).length;
  const idLimit = renderedItems < sourceItems ? renderedItems : 8;
  const ids = (brief.included ?? []).map((x) => x?.id).filter((x) => typeof x === "string").slice(0, idLimit);

  // ③ 与代理共用一份回执：同一会话 60 秒内只注入一次，代理刚注入过就让位
  const claim = mods.receipt.claimReceipt(INJECT.receiptFile, {
    source: mods.receipt.SOURCE_PLUGIN,
    conversationId: sessionId,
    chars: block.length,
    ids,
    windowMs: INJECT.throttleMs,
  });
  if (!claim.allowed) {
    st.declined = true;
    injectRuntime.stats.skipped += 1;
    injectRuntime.stats.lastReason = claim.blockedBy;
    const rec = { conversationId: sessionId, sessionId, blockedBy: claim.blockedBy, queryHead, reason: claim.reason, briefMs: brief.ms };
    injectRuntime.lastSkip = rec;
    await log(`inject_skipped ${JSON.stringify(rec)}`);
    return assembly;
  }

  st.served = true;
  injectRuntime.stats.ok += 1;
  injectRuntime.stats.lastReason = null;
  const record = {
    conversationId: sessionId,
    sessionId,
    injectChars: block.length,
    memoryChars: brief.text.length,
    includedIds: ids,
    briefMs: brief.ms,
    queryChars: query.length,
    queryMessages: queryUsed, // IN-PLUGIN-3：这次问句用了几条真人消息（1 = 只有最后一句；2 = 回补了上一条）
    queryHead,
    maxChars: INJECT.maxChars,
    agent: `${INJECT.agent}/${INJECT.role}`,
  };
  injectRuntime.lastOk = record;
  await log(`inject_ok ${JSON.stringify(record)}`);

  return {
    ...assembly,
    sections: assembly.sections.map((s) => (s.name === INJECT.sectionName ? { ...s, text: block } : s)),
  };
}

// ---------------------------------------------------------------- 日志 / 状态（全异步）

// ---------------------------------------------------------------- 日志 / 状态（全异步）
async function ensureDirs() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  await fsp.mkdir(QUEUE_DIR, { recursive: true });
  await fsp.mkdir(DEAD_DIR, { recursive: true });
}

async function log(msg) {
  try {
    await fsp.mkdir(WORK_DIR, { recursive: true });
    await fsp.appendFile(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 日志写不进去也绝不能影响宿主 */
  }
}

async function readState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed, turns: { ...(parsed?.turns ?? {}) }, stats: { ...emptyState().stats, ...(parsed?.stats ?? {}) } };
  } catch {
    return emptyState();
  }
}

async function writeState(state) {
  await ensureDirs();
  const pruned = pruneDone(state);
  pruned.updated_at = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(pruned, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, STATE_FILE);
  return pruned;
}

/** done 记录只留 7 天，避免状态文件无界增长（队列另有硬上限）。 */
function pruneDone(state) {
  const cutoff = Date.now() - PRUNE_DONE_DAYS * 86400_000;
  const turns = {};
  for (const [key, entry] of Object.entries(state.turns ?? {})) {
    const at = entry?.at ? Date.parse(entry.at) : NaN;
    if (entry?.status === "done" && Number.isFinite(at) && at < cutoff) continue;
    turns[key] = entry;
  }
  return { ...state, turns };
}

// ---------------------------------------------------------------- 凭据

let secretCache = { at: 0, value: null };

async function loadAuth() {
  if (secretCache.value && Date.now() - secretCache.at < SECRET_CACHE_MS) return secretCache.value;
  let ref = process.env.MEMORY_LIB_CRED_REF;
  let secret = process.env.MEMORY_LIB_SECRET;
  // 配置文件是密钥的唯一真相来源：进程内 env 可能是启动时的旧值，
  // 密钥轮换后若没重启 DSH，env 仍是旧值 ⇒ 采集持续 401（2026-09-23 实测）。
  try {
    const yml = await fsp.readFile(PATCH_FILE, "utf8");
    ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? ref;
    secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? secret;
  } catch {
    /* 读不到配置就看 env */
  }
  // 捕获身份必须自洽：注册表里不存在 admin-01 + capture-ingest 这种组合
  // ⇒ 服务端会正确返回 UNKNOWN_ROLE（2026-10-15 起单日 18 万次 403 的根因）。
  const agent = process.env.MEMORY_LIB_CAPTURE_AGENT ?? "pilot-01";
  const role = process.env.MEMORY_LIB_CAPTURE_ROLE ?? "capture-ingest";
  const value = ref && secret ? { credential_ref: ref, secret, principal: { agent_id: agent, role_id: role } } : null;
  secretCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- 文件队列

function queueFileOf(turnKey) {
  const h = crypto.createHash("sha1").update(turnKey).digest("hex").slice(0, 16);
  return path.join(QUEUE_DIR, `${h}.json`);
}

async function enqueueFile(payload) {
  await ensureDirs();
  const file = queueFileOf(payload.event_id);
  try {
    await fsp.access(file);
    return file; // 已经在队列里，不重复写
  } catch {
    /* 不存在才写 */
  }
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
  return file;
}

async function listQueue() {
  try {
    const names = await fsp.readdir(QUEUE_DIR);
    return names.filter((n) => n.endsWith(".json")).sort().map((n) => path.join(QUEUE_DIR, n));
  } catch {
    return [];
  }
}

async function moveToDead(file, payload, reason) {
  await ensureDirs();
  const target = path.join(DEAD_DIR, path.basename(file));
  const record = { ...payload, dead_at: new Date().toISOString(), reason };
  try {
    await fsp.writeFile(target, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch {
    /* 死信写不进去也别抛 */
  }
  try {
    await fsp.rm(file, { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 运行时

function createRuntime(ctx) {
  const buffers = new Map(); // sessionId -> { turn, messages, workspace }
  let draining = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      const files = await listQueue();
      if (!files.length) return;
      const auth = await loadAuth();
      if (!auth) {
        await log("WARN 缺少 memory-lib 凭证，队列暂不发送（留在 queue/ 里）");
        return;
      }
      for (const file of files) {
        let payload;
        try {
          payload = JSON.parse(await fsp.readFile(file, "utf8"));
        } catch (e) {
          await log(`WARN 队列文件读不了 ${path.basename(file)}: ${e?.message}`);
          continue;
        }
        const key = payload?.event_id;
        if (!key) {
          await fsp.rm(file, { force: true }).catch(() => {});
          continue;
        }
        let state = await readState();
        const entry = state.turns[key];
        if (entry?.status === "done") {
          await fsp.rm(file, { force: true }).catch(() => {});
          continue;
        }
        if (entry?.status === "dead") {
          await moveToDead(file, payload, entry.lastError ?? "dead");
          continue;
        }
        const attempts = Number(entry?.attempts ?? 0);
        const result = await postCapture({ auth, event: payload, apiBase: API_BASE, timeoutMs: POST_TIMEOUT_MS });
        state = await readState();
        const at = new Date().toISOString();
        if (result.ok) {
          state.turns[key] = { status: "done", attempts: attempts + 1, at, evidenceId: result.evidenceId ?? null, lastAttemptAt: at, lastError: null };
          state.stats.submitted = (state.stats.submitted ?? 0) + 1;
          state.stats.lastSuccessAt = at;
          state.stats.consecutiveFailures = 0;
          state.stats.lastError = null;
          await writeState(state);
          await fsp.rm(file, { force: true }).catch(() => {});
          await log(`OK ${key} evidence=${result.evidenceId ?? "-"} ${result.ms}ms`);
          // REFINE-TRIGGER-1：捕获成功 ⇒ 顺手叫一声提炼（不 await、不影响本轮）
          void triggerRefine(payload.conversation_id);
          continue;
        }
        const nextAttempts = attempts + 1;
        const verdict = nextAttemptVerdict(nextAttempts, MAX_ATTEMPTS);
        state.turns[key] = {
          status: verdict === "dead" ? "dead" : "pending",
          attempts: nextAttempts,
          at,
          lastAttemptAt: at,
          lastError: result.error ?? "unknown",
        };
        state.stats.failed = (state.stats.failed ?? 0) + 1;
        state.stats.lastFailureAt = at;
        state.stats.consecutiveFailures = (state.stats.consecutiveFailures ?? 0) + 1;
        state.stats.lastError = result.error ?? "unknown";
        if (verdict === "dead") state.stats.dead_lettered = (state.stats.dead_lettered ?? 0) + 1;
        await writeState(state);
        if (verdict === "dead") {
          await moveToDead(file, payload, `连续失败 ${nextAttempts} 次：${result.error ?? "unknown"}`);
          await log(`DEAD ${key} 连续失败 ${nextAttempts} 次，进死信：${result.error ?? "unknown"}`);
        } else {
          await log(`FAIL ${key}（第 ${nextAttempts}/${MAX_ATTEMPTS} 次）：${result.error ?? "unknown"}（留在队列）`);
        }
      }
    } catch (e) {
      await log(`DRAIN-ERR ${e?.message ?? e}`);
    } finally {
      draining = false;
    }
  };

  const enqueue = async (sessionId, turn, messages, workspace) => {
    try {
      if (!messages.length || turn == null) return;
      const payload = buildCaptureEvent({ sessionId, turn, messages, workspace });
      const state = await readState();
      if (state.turns[payload.event_id]?.status === "done") return; // 已发过，幂等跳过
      await enqueueFile(payload);
      await drain();
    } catch (e) {
      await log(`ENQUEUE-ERR ${e?.message ?? e}`);
    }
  };

  const onSessionEvent = (session, event) => {
    try {
      const sessionId = sessionIdOf(session);
      if (!sessionId || !event?.type) return;
      if (SESSION_END_EVENTS.has(event.type)) {
        // IN-PLUGIN-3：会话结束 ⇒ 删掉它的问句（Q5：不留无主条目）。
        // 只清问句表；sections 自己的上限照旧（改这块不属于本单范围）。
        const dropped = dropSessionQuery(sessionId);
        buffers.delete(sessionId);
        if (dropped) void log(`QUERY-DROP ${JSON.stringify({ sessionId, event: event.type, querySessions: injectRuntime.queryTexts.size })}`);
        return;
      }
      if (event.type === "turn/start") {
        buffers.set(sessionId, { turn: event.data?.turn ?? null, workspace: workspaceOf(session), messages: [] });
        // IN-PLUGIN-2：新一轮 ⇒ 重置"这一轮还能不能注入"的三个开关
        const st = sessionStateOf(sessionId);
        st.toolRound = false;
        st.served = false;
        st.declined = false;
        return;
      }
      if (event.type === "tool/call" || event.type === "tool/result") {
        // ④ 工具轮不注入：一旦本轮出现过工具调用，后面的 model step 一律不给记忆
        sessionStateOf(sessionId).toolRound = true;
        return;
      }
      if (event.type === "turn/end") {
        const buf = buffers.get(sessionId);
        buffers.delete(sessionId);
        if (buf && buf.turn != null) void enqueue(sessionId, buf.turn, buf.messages, buf.workspace);
        // 下一轮开奖：用这一轮的真人文本当 query，把注入块预热好
        // （IN-PLUGIN-2：注入块改为按轮取，这里不再预热）
        return;
      }
      const buf = buffers.get(sessionId);
      if (!buf) return;
      if (event.type === "user/message") {
        if (event.data?.source?.kind !== "user") return; // 跳过系统注入的消息
        const text = textOf(event.data?.content);
        if (!text || text.startsWith("Current runtime context")) return;
        buf.messages.push({ role: "user", content: text.slice(0, MAX_TEXT) });
        // IN-PLUGIN-3：只记到**本会话**的问句表（改前是模块级全局数组 ⇒ 注入串味）
        rememberUserText(sessionId, text);
      } else if (event.type === "assistant/message") {
        const text = textOf(event.data?.message?.content); // 只取正文，丢掉 reasoning
        if (text) buf.messages.push({ role: "assistant", content: text.slice(0, MAX_TEXT) });
      }
    } catch (e) {
      // 事件处理绝不能把异常抛回宿主
      void log(`HANDLER-ERR ${e?.message ?? e}`);
    }
  };

  /** 状态快照（给 status.mjs 复用同一套口径）。 */
  const snapshot = async () => {
    const state = await readState();
    const queue = await listQueue();
    let dead = 0;
    try {
      dead = (await fsp.readdir(DEAD_DIR)).filter((n) => n.endsWith(".json")).length;
    } catch {
      dead = 0;
    }
    let legacySessions = 0;
    try {
      legacySessions = legacySessionCount(JSON.parse(await fsp.readFile(LEGACY_STATE_FILE, "utf8")));
    } catch {
      legacySessions = 0;
    }
    return { ...summarizeState(state, { pending: queue.length, dead }), legacy_sessions_archived: legacySessions, work_dir: WORK_DIR, api_base: API_BASE };
  };

  /** 注入侧快照（status.mjs 与测试用；只读，不触发任何网络）。 */
  const injectSnapshot = () => ({
    enabled: INJECT.enabled,
    modulesLoaded: Boolean(injectModules),
    ...injectRuntime.stats,
    lastOk: injectRuntime.lastOk,
    lastSkip: injectRuntime.lastSkip,
    // IN-PLUGIN-3：问句表按会话隔离后的规模与内容（Q5 用它看"会不会无界增长"）。
    // 只放叶子字段（sessionId / 条数 / 长度 / 前 60 字），不回传任何活对象。
    querySessions: {
      size: injectRuntime.queryTexts.size,
      cap: QUERY.maxSessions,
      maxMessages: QUERY.maxMessages,
      shortChars: QUERY.shortChars,
      sessions: [...injectRuntime.queryTexts.entries()].map(([sid, texts]) => {
        const last = texts[texts.length - 1] ?? "";
        return { sessionId: sid, messages: texts.length, lastChars: last.length, lastHead: queryHeadOf(last) };
      }),
    },
    receiptFile: INJECT.receiptFile,
    briefUrl: INJECT.briefUrl,
    maxChars: INJECT.maxChars,
    throttleMs: INJECT.throttleMs,
    timeoutMs: INJECT.timeoutMs,
    sectionName: INJECT.sectionName,
    sectionOrder: INJECT.sectionOrder,
  });

  return { onSessionEvent, drain, snapshot, injectSnapshot, buffers, dropQuery: dropSessionQuery };
}

// ---------------------------------------------------------------- Cordis 入口

function apply(ctx) {
  const rt = createRuntime(ctx);

  void log(
    `INFO 捕获插件已加载（捕获 + 提炼触发 + 注入）api=${API_BASE} work=${WORK_DIR} refine=${REFINE.enabled ? "on" : "off"} module=${REFINE.modulePath} lockDir=${REFINE.logDir} inject=${INJECT.enabled ? "on" : "off"} brief=${INJECT.briefUrl} receipt=${INJECT.receiptFile} maxChars=${INJECT.maxChars} throttleMs=${INJECT.throttleMs} timeoutMs=${INJECT.timeoutMs}`,
  );

  // 定时补发：队列里积压的（上一次失败/上一次进程留下的）每 60 秒尝试一轮
  ctx.effect(() => {
    const timer = setInterval(() => {
      void rt.drain();
    }, RETRY_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, "memory-capture: retry loop");

  // IN-PLUGIN-2：把注入块挂成 systemPrompt 的一个 section。
  // 防御式注册：宿主没有 systemPrompt 服务时（单测的假 ctx、精简 profile）只记一条日志，
  // 绝不让"没有注入"变成"插件起不来"。inject 声明里已经写了 ["systemPrompt"]，
  // 真宿主会在服务就绪后再 apply —— 这里的兜底是给测试和降级场景用的。
  const sp = typeof ctx.get === "function" ? ctx.get("systemPrompt") : ctx.systemPrompt;
  if (sp && typeof sp.section === "function") {
    // 槽位：text 恒为 ""（真正的文本由下面的 assemble waterfall 每轮填进去）。
    // 空 section 会被 host 丢掉，所以不注入时它一个字都不占。
    ctx.effect(
      () =>
        sp.section({
          name: INJECT.sectionName,
          order: INJECT.sectionOrder,
          text: "",
        }),
      "memory-capture: recall section",
    );
    void log(`INFO 注入 section 已挂载 name=${INJECT.sectionName} order=${INJECT.sectionOrder}（文本由 assemble waterfall 每轮填入）`);

    // IN-PLUGIN-2：真正干活的地方。waterfall 是 async 的 ⇒ 这里按 ≤3s 预算取 brief、认领回执、
    // 把这一轮的文本填进槽位。任何异常都原样返回 assembly（fail-open）。
    // 不传 next 的监听器会拿到(assembly, context, next)，我们**先让下游跑完**再改自己那一段。
    ctx.on("system-prompt/assemble", async (assembly, context, next) => {
      let current = assembly;
      try {
        current = typeof next === "function" ? await next() : assembly;
      } catch (e) {
        void log(`INJECT-WARN 下游 assemble 出错（本次不注入）：${e?.message ?? e}`);
        return assembly;
      }
      try {
        return await injectIntoAssembly(current, context);
      } catch (e) {
        void log(`INJECT-WARN ${e?.message ?? e}`);
        return current;
      }
    });
    void loadInjectModules(); // 提前把模块加载好，别让第一次组装多等一次 import
  } else {
    void log("WARN 没有 systemPrompt 服务，注入不生效（捕获与提炼不受影响）");
  }

  ctx.on("session/event", (session, event) => {
    rt.onSessionEvent(session, event);
  });

  // IN-PLUGIN-3：宿主销毁会话时也清一次问句表。
  // `session/end-seed` 走的是 session/event；`session/disposed` 是宿主 ctx 上的独立事件
  // （实测 dsh-host-apiproxy 用它清 openCalls），两条路都清，别只押一个。
  if (typeof ctx.on === "function") {
    ctx.on("session/disposed", (session) => {
      try {
        const sid = sessionIdOf(session);
        if (sid && rt.dropQuery(sid)) void log(`QUERY-DROP ${JSON.stringify({ sessionId: sid, event: "session/disposed" })}`);
      } catch (e) {
        void log(`QUERY-DROP-ERR ${e?.message ?? e}`);
      }
    });
  }

  // IN-PLUGIN-4：宿主**入队**事件 —— 本轮用户文本在首步 assemble 之前就拿得到（本单的核心）。
  // 无 scope 的监听器能收到所有 agent 的插入事件（dsh-scope：untagged 监听器全局放行），
  // 但写入仍然只写 `agent.id` 这一个会话的槽位 ⇒ 隔离没退。
  if (typeof ctx.on === "function") {
    ctx.on("agent/inbox/inserted", (payload) => {
      try {
        const rec = rememberInboxMessage(payload);
        // 每个会话只记第一笔（后续每轮都记会把日志刷满）；总量看 injectSnapshot().inboxSeeds
        if (rec?.first) void log(`INBOX-QUERY ${JSON.stringify(rec)}`);
      } catch (e) {
        void log(`INBOX-ERR ${e?.message ?? e}`);
      }
    });
  }

  void rt.drain(); // 启动即补发一轮
  return { snapshot: rt.snapshot, injectSnapshot: rt.injectSnapshot };
}

export { apply, inject, name };
