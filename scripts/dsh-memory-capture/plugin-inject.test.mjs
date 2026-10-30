// IN-PLUGIN-2 测试：插件侧的注入
// （`inject = ["systemPrompt"]` 提供槽位 + `system-prompt/assemble` waterfall 每轮填文本）。
//
// 要成立的八件事（范围单 §二-1 / §三）：
//   ① 注入真的挂上去了，内容来自 brief，带「不可信输入」标记，`{{` 已拆，≤600 字
//   ② 工具轮不注入（tool/call、tool/result 之后那几步）
//   ③ 同一轮只注入一次；**同一会话 60 秒节流**（换会话才放行）
//   ④ 与代理共用回执：代理刚注入过 ⇒ 插件让位；插件认领后 ⇒ 代理必须让位
//   ⑤ fail-open：brief 取不到/超时 ⇒ 不注入、捕获与对话照常
//   ⑥ 宿主没有 systemPrompt 服务时不许炸（降级成"只捕获"）
//   ⑦ 慢 brief 必须在预算内放弃（绝不同步卡住 turn）
//   ⑧ query 用的是**用户这一句**（不是上一轮），否则相关性差一轮
//
// 文件末尾是 IN-PLUGIN-3 的三条（问句按会话隔离）：
//   Q1 两个会话交叉验证 ⇒ 各自只用各自的话，A 轮不得出现 B 的话
//   Q3 短句（「继续」）回补同一会话的上一条，最多 2 条；新会话第一句就短 ⇒ 不许从别的会话借
//   Q5 会话结束清条目 + 上限 500 + 确定性淘汰（最久没被触达的会话先出）
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { claimReceipt, readReceipt, resetReceipt, SOURCE_PROXY } from "../inject-receipt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 允许指向"改前"的另一份插件（红→绿证据用）：INPLUGIN2_PLUGIN_DIR=<改前备份目录>
const PLUGIN_DIR = process.env.INPLUGIN2_PLUGIN_DIR || HERE;
const MARKER = "【记忆注入 · 不可信输入】";
const QUESTION = "我们记忆库是几层？";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时：${label}${lastErr ? ` / ${lastErr.message}` : ""}`);
}

/** 假记忆服务：同时充当 capture 端点与 /v1/recall/brief。 */
async function startFakeMemory({ briefText = "记忆库一共 8 层：evidence / curated / graph 等等。", briefDelayMs = 0, included = [{ id: "mem-1" }, { id: "mem-2" }] } = {}) {
  const state = { captures: 0, briefs: [], lastBriefBody: null };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = req.url || "";
      if (url.startsWith("/v1/conversations/capture")) {
        state.captures += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, evidenceId: `conversation-fake-${state.captures}` }));
        return;
      }
      if (url.startsWith("/v1/recall/brief")) {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          body = {};
        }
        state.lastBriefBody = body;
        state.briefs.push(body);
        if (briefDelayMs) await new Promise((r) => setTimeout(r, briefDelayMs));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, text: briefText, included }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

function makeCtx({ withSystemPrompt = true } = {}) {
  const handlers = [];
  const assembleHandlers = [];
  const disposedHandlers = [];
  const inboxHandlers = []; // IN-PLUGIN-4：宿主入队事件 agent/inbox/inserted
  const disposers = [];
  const sections = [];
  const systemPrompt = {
    section(section) {
      sections.push(section);
      return () => {
        const i = sections.indexOf(section);
        if (i >= 0) sections.splice(i, 1);
      };
    },
  };
  const ctx = {
    on(ev, fn) {
      if (ev === "session/event") handlers.push(fn);
      if (ev === "system-prompt/assemble") assembleHandlers.push(fn);
      if (ev === "session/disposed") disposedHandlers.push(fn); // IN-PLUGIN-3：宿主销毁会话
      if (ev === "agent/inbox/inserted") inboxHandlers.push(fn); // IN-PLUGIN-4：宿主入队
    },
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
    },
    get(name) {
      return withSystemPrompt && name === "systemPrompt" ? systemPrompt : undefined;
    },
  };
  if (withSystemPrompt) ctx.systemPrompt = systemPrompt;
  return {
    ctx,
    sections,
    assembleHandlers,
    disposedHandlers,
    inboxHandlers,
    emit(s, e) {
      handlers.forEach((fn) => fn(s, e));
    },
    emitDisposed(session) {
      disposedHandlers.forEach((fn) => fn(session));
    },
    /** IN-PLUGIN-4：宿主入队事件 —— payload 形状照宿主 agent-loop 的 { agent, message }。 */
    emitInboxInserted({ sessionId, text, kind = "user" }) {
      const payload = {
        agent: { id: sessionId, session: { id: sessionId } },
        message: { source: { kind }, content: [{ type: "text", text }] },
      };
      inboxHandlers.forEach((fn) => fn(payload));
    },
    disposeAll() {
      disposers.forEach((d) => {
        try {
          d();
        } catch {}
      });
    },
  };
}

async function bootPlugin({ workDir, apiBase, env = {} }) {
  process.env.DSH_HOME = workDir;
  process.env.INPLUGIN1_WORK_DIR = workDir;
  process.env.MEMORY_LIB_URL = apiBase;
  process.env.MEMORY_LIB_CRED_REF = "memory-lib/test";
  process.env.MEMORY_LIB_SECRET = "test";
  Object.assign(process.env, env);
  const mod = await import(`${new URL(`file:///${path.join(PLUGIN_DIR, "index.js").replace(/\\/g, "/")}`).href}?i2=${Date.now()}-${Math.random()}`);
  const h = makeCtx({ withSystemPrompt: env.__withSystemPrompt !== false });
  const api = mod.apply(h.ctx);
  return { ...h, api, mod };
}

function emitTurn(h, { sessionId, turn, text = QUESTION }) {
  h.emit({ id: sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn } });
  h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } });
}

/** 把这一轮说完（助手正文 + turn/end）⇒ 捕获才会真的发出去。 */
function finishTurn(h, { sessionId }) {
  h.emit({ id: sessionId }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "8 层。" }] } } });
  h.emit({ id: sessionId }, { type: "turn/end" });
}

/**
 * IN-PLUGIN-4：复刻宿主**真实**的首步顺序（orders/IN-PLUGIN-4 §三 + dsh-agent-loop/lib/index.js:357-360/496-554）：
 *
 *   ① `agent/inbox/inserted`   ← 宿主 send() 入队（**本轮用户的话在这里第一次可见**）
 *   ② `turn/start`
 *   ③ **assemble**             ← 我们的 waterfall 在这里跑（宿主系统提示组装）
 *   ④ `step/start`
 *   ⑤ `user/message`           ← 用户的话这时才落盘（= 旧代码唯一的写入点）
 *   ⑥ 后面几条 user/message 是宿主追加的运行时上下文/指引（kind ≠ user）
 *
 * 上面 `emitTurn()` 是"先落盘再 assemble"（同一轮第 2 步才是这个形状），
 * 所以老测试全绿也测不出"首步拿不到本轮问句"——这正是 IN-PLUGIN-3 上真机才炸的原因。
 */
async function assembleRealFirstStep(h, { sessionId, turn = 1, text, withHostContext = true }) {
  h.emitInboxInserted({ sessionId, text }); // ① 入队（source.kind = "user"）
  h.emit({ id: sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn } }); // ②
  const injected = await assemble(h, sessionId); // ③ 首步 assemble —— 这里就该有注入
  h.emit({ id: sessionId }, { type: "step/start", data: { turn, step: 1 } }); // ④
  h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } }); // ⑤
  if (withHostContext) {
    // ⑥ 真机实测：这三条也是以 user/message 落盘的
    h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "plugin" }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }] } });
    h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "agent-instructions" }, content: [{ type: "text", text: "<system-reminder>workspace instructions</system-reminder>" }] } });
    h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "skill-catalog" }, content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }] } });
  }
  return injected;
}

/**
 * 复刻宿主的组装：先按注册的 section 生成 assembly，再跑 system-prompt/assemble waterfall，
 * 最后读回 memory-lib:recall 那一段的文本（宿主 renderPrompt 就是取这个）。
 */
async function assemble(h, sessionId) {
  const sections = [
    { name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." },
    ...h.sections.map((s) => ({ name: s.name, text: typeof s.text === "function" ? s.text({}) : s.text })),
  ];
  const value = { sections, contexts: [], tools: [], variables: {} };
  const context = { agent: { session: { id: sessionId } }, scope: null };
  const chain = async (i) => {
    if (i >= h.assembleHandlers.length) return value;
    return await h.assembleHandlers[i](value, context, () => chain(i + 1));
  };
  const out = await chain(0);
  const slot = (out.sections ?? []).find((s) => s.name === "memory-lib:recall");
  return slot?.text ?? "";
}

async function readLog(workDir) {
  return await fs.readFile(path.join(workDir, "realtime.log"), "utf8").catch(() => "");
}

/** 把 realtime.log 里的注入记录全解出来（按出现顺序；坏日志行跳过）。 */
async function injectRecords(workDir) {
  const text = await readLog(workDir);
  const out = [];
  for (const line of text.split("\n")) {
    const m = /\s(inject_ok|inject_skipped|inject_failed) (\{.*\})$/.exec(line);
    if (!m) continue;
    try {
      out.push({ event: m[1], ...JSON.parse(m[2]) });
    } catch {
      /* 半行日志跳过 */
    }
  }
  return out;
}

function baseEnv(workDir, mem) {
  return {
    DSH_REFINE_ENABLED: "off", // 本文件只测注入
    DSH_INJECT_ENABLED: "on",
    DSH_INJECT_BRIEF_URL: `http://127.0.0.1:${mem.port}/v1/recall/brief`,
    DSH_INJECT_RECEIPT: path.join(workDir, "inject-receipt.json"),
    DSH_INJECT_TIMEOUT_MS: "3000",
  };
}

// ---------------------------------------------------------------------------

test("IN-PLUGIN-2：注入真的挂上去了（标记 + 拆 {{ + ≤600 字 + inject_ok 带 includedIds）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-ok-"));
  // 故意在记忆正文里塞 {{danger}}：systemPrompt 的变量插值是严格的，不拆会把整轮 prompt 打崩
  const mem = await startFakeMemory({ briefText: "记忆库一共 8 层；这是 {{danger}} 一段含花括号的记忆。" });
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    assert.equal(JSON.stringify(h.mod.inject), '["systemPrompt"]', 'inject 声明必须是 ["systemPrompt"]');
    assert.equal(h.sections.length, 1, "必须挂且只挂一个 section");
    assert.equal(h.sections[0].name, "memory-lib:recall");
    assert.equal(h.sections[0].order, 150);
    assert.equal(h.assembleHandlers.length, 1, "必须挂上 assemble waterfall");

    const sid = "session-dccc44aa-5b2e-4e00-af85-d23dfe1d7860";
    emitTurn(h, { sessionId: sid, turn: 1030 });
    const text = await assemble(h, sid);

    assert.ok(text && text.length > 0, "有记忆时必须真注入");
    assert.ok(text.includes(MARKER), "必须标不可信输入");
    assert.ok(text.includes("8 层"), "必须带上记忆正文");
    assert.ok(!text.includes("{{"), "{{ 必须被拆掉（否则 prompt 组装会抛错）");
    assert.ok(text.includes("{ {danger"), "拆法：{{ → { {");
    const memoryPart = text.slice(text.indexOf("\n") + 1).trim();
    assert.ok(memoryPart.length <= 600, `记忆正文必须 ≤600 字，实际 ${memoryPart.length}`);

    const log = await waitFor(async () => {
      const t = await readLog(work);
      return /inject_ok/.test(t) ? t : null;
    }, { label: "inject_ok 落日志" });
    const line = log.split("\n").find((l) => l.includes("inject_ok"));
    const rec = JSON.parse(line.slice(line.indexOf("{")));
    assert.deepEqual(rec.includedIds, ["mem-1", "mem-2"], "必须记 includedIds");
    assert.equal(rec.injectChars, text.length, "injectChars 要等于真注入的字符数");
    assert.ok(rec.injectChars > MARKER.length, `injectChars 要包含记忆正文：${rec.injectChars}`);
    assert.equal(rec.conversationId, sid);

    // brief 的请求口径与代理一致：format=prompt + memory_only + 身份 pilot-01/reader
    assert.equal(mem.state.lastBriefBody.format, "prompt");
    assert.equal(mem.state.lastBriefBody.memory_only, true);
    assert.deepEqual(mem.state.lastBriefBody.principal, { agent_id: "pilot-01", role_id: "reader" });
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("INJECT-FIX-1 F1：插件按完整段 600 预算并让 includedIds 与实际正文条数一致", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "inject-fix-budget-"));
  const first = `- [2026-10-28] ${"甲".repeat(330)}。`;
  const second = `- [2026-10-28] ${"乙".repeat(330)}。`;
  const mem = await startFakeMemory({ briefText: `${first}\n${second}`, included: [{ id: "first" }, { id: "second" }] });
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    emitTurn(h, { sessionId: "fix-budget", turn: 1 });
    const text = await assemble(h, "fix-budget");
    const bodyLines = text.split("\n").slice(1).filter(Boolean);
    assert.equal(text.length <= 600, true, `完整注入段必须 ≤600，实际 ${text.length}`);
    assert.deepEqual(bodyLines, [first], "放不下的第二条必须整条丢弃");
    assert.equal(text.endsWith("…"), false, "不许截半句");
    const log = await waitFor(async () => /inject_ok/.test(await readLog(work)) ? await readLog(work) : null, { label: "预算 inject_ok" });
    const line = log.split("\n").find((row) => row.includes("inject_ok"));
    const rec = JSON.parse(line.slice(line.indexOf("{")));
    assert.deepEqual(rec.includedIds, ["first"], "回执 items 必须与实际正文条数一致");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：query 用的是用户**这一句**（相关性不打折）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-query-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const sid = "session-query";
    emitTurn(h, { sessionId: sid, turn: 1, text: QUESTION });
    await assemble(h, sid);
    await waitFor(() => (mem.state.briefs.length >= 1 ? true : null), { label: "brief 被调用" });
    assert.ok(
      String(mem.state.lastBriefBody.query ?? "").includes(QUESTION),
      `brief 的 query 必须含用户当前这一句，实际：${JSON.stringify(mem.state.lastBriefBody.query)}`,
    );
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：工具轮不注入（tool/call、tool/result 之后那几步不给记忆）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-tool-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const sid = "session-toolround";
    emitTurn(h, { sessionId: sid, turn: 1 });
    assert.ok(await assemble(h, sid), "第一轮第一步该注入");
    h.emit({ id: sid }, { type: "tool/call", data: { name: "pwsh" } });
    assert.equal(await assemble(h, sid), "", "工具轮不许注入");
    h.emit({ id: sid }, { type: "tool/result", data: {} });
    assert.equal(await assemble(h, sid), "", "工具结果之后也不许注入");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：同一轮只注入一次；同一会话 60 秒节流（新会话才放行）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-throttle-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const sid = "session-A";
    emitTurn(h, { sessionId: sid, turn: 1 });
    assert.ok(await assemble(h, sid), "第一轮第一步该注入");
    assert.equal(await assemble(h, sid), "", "同一轮第二步不许重复注入");
    const callsAfterFirstTurn = mem.state.briefs.length;

    // 新一轮、同一会话、窗口内 ⇒ 被节流（而且**不该再打一次 brief**）
    h.emit({ id: sid }, { type: "turn/end" });
    emitTurn(h, { sessionId: sid, turn: 2 });
    assert.equal(await assemble(h, sid), "", "同一会话 60 秒内不许再注入");
    await waitFor(async () => {
      const t = await readLog(work);
      return /"blockedBy":"throttle"/.test(t) ? t : null;
    }, { label: "节流日志" });
    assert.equal(mem.state.briefs.length, callsAfterFirstTurn, "被节流时不许白打 brief");

    // 换个会话 ⇒ 放行（节流是按会话的，不是全局掐死）
    emitTurn(h, { sessionId: "session-B", turn: 1 });
    assert.ok(await assemble(h, "session-B"), "别的会话该照常注入");

    // 2026-10-26: 「同一轮只注入一次」原本是**装饰性断言** —— 把
    // `if (st.served) return assembly` 改成 `if (false && st.served)` 它依然绿，
    // 因为第二步还会被"同一会话 60 秒节流"挡掉，只看"返回空"分不清谁挡的。
    // 这里在会话-B 上先把回执清掉：此后唯一还能挡住重复注入的只剩 served 标志，
    // 再加一条"brief 次数不许增加"。去掉 `if (st.served)` 分支，这两条必然变红。
    const briefsBeforeSecondStep = mem.state.briefs.length;
    resetReceipt(path.join(work, "inject-receipt.json"));
    assert.equal(await assemble(h, "session-B"), "", "同一轮第二步不许重复注入（回执已清，只剩 served 能拦）");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      mem.state.briefs.length,
      briefsBeforeSecondStep,
      "同一轮第二步不许再打 brief —— 去掉 `if (st.served)` 分支这里必然变红",
    );
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：与代理共用回执 —— 代理刚注入过，插件必须让位（同一轮不会两次）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-peer-"));
  const mem = await startFakeMemory();
  try {
    const receiptFile = path.join(work, "inject-receipt.json");
    const claimed = claimReceipt(receiptFile, { source: SOURCE_PROXY, conversationId: "some-proxy-key", chars: 640, ids: ["x"] });
    assert.equal(claimed.allowed, true);

    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), DSH_INJECT_RECEIPT: receiptFile },
    });
    const sid = "session-peer";
    emitTurn(h, { sessionId: sid, turn: 1 });
    assert.equal(await assemble(h, sid), "", "代理刚注入过，插件必须让位");
    await waitFor(async () => {
      const t = await readLog(work);
      return /"blockedBy":"peer-window"/.test(t) ? t : null;
    }, { label: "让位日志" });

    const after = readReceipt(receiptFile);
    assert.equal(after.last.source, SOURCE_PROXY, "让位时不许把回执改成自己的");
    assert.equal(after.last.conversationId, "some-proxy-key");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：插件先认领后，代理那边读到的就是「插件注入过」", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-order-"));
  const mem = await startFakeMemory();
  try {
    const receiptFile = path.join(work, "inject-receipt.json");
    resetReceipt(receiptFile);
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), DSH_INJECT_RECEIPT: receiptFile },
    });
    const sid = "session-order";
    emitTurn(h, { sessionId: sid, turn: 1 });
    assert.ok(await assemble(h, sid), "插件该注入");

    const receipt = readReceipt(receiptFile);
    assert.equal(receipt.last.source, "plugin", "回执必须写着 source=plugin");
    assert.equal(receipt.last.conversationId, sid);
    assert.ok(receipt.last.ids.length >= 1, "回执要带 includedIds");

    const proxyClaim = claimReceipt(receiptFile, { source: SOURCE_PROXY, conversationId: "proxy-key-same-turn" });
    assert.equal(proxyClaim.allowed, false, "插件已认领，代理必须让位");
    assert.equal(proxyClaim.blockedBy, "peer-window");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：fail-open —— brief 死了/超时，捕获照常成功、对话不受影响", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-failopen-"));
  const deadPort = await freePort();
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), DSH_INJECT_BRIEF_URL: `http://127.0.0.1:${deadPort}/v1/recall/brief` },
    });
    const sid = "session-deadbrief";
    emitTurn(h, { sessionId: sid, turn: 1 });
    assert.equal(await assemble(h, sid), "", "brief 拿不到 ⇒ 不注入");
    finishTurn(h, { sessionId: sid });
    await waitFor(() => (mem.state.captures === 1 ? true : null), { label: "捕获仍然成功" });
    const snap = await h.api.snapshot();
    assert.equal(snap.done_turns, 1);
    assert.equal(snap.dead_letters, 0);
    await waitFor(async () => {
      const t = await readLog(work);
      return /inject_failed/.test(t) ? t : null;
    }, { label: "失败被记账" });
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：宿主没有 systemPrompt 服务时不许炸（降级成只捕获）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-nosp-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), __withSystemPrompt: false },
    });
    assert.equal(h.sections.length, 0, "没有服务就不该有 section");
    assert.equal(h.assembleHandlers.length, 0, "没有服务就不该挂 waterfall");
    emitTurn(h, { sessionId: "session-nosp", turn: 1 });
    await waitFor(async () => {
      const t = await readLog(work);
      return /没有 systemPrompt 服务/.test(t) ? t : null;
    }, { label: "留下 WARN" });
    finishTurn(h, { sessionId: "session-nosp" });
    await waitFor(() => (mem.state.captures === 1 ? true : null), { label: "捕获照常" });
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-2：brief 慢也要在预算内放弃（绝不长时间挂住 prompt 组装）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-slow-"));
  const mem = await startFakeMemory({ briefDelayMs: 5000 }); // 服务端故意 5 秒才回
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), DSH_INJECT_TIMEOUT_MS: "300" },
    });
    emitTurn(h, { sessionId: "session-slow", turn: 1 });
    const t0 = Date.now();
    const text = await assemble(h, "session-slow");
    const elapsed = Date.now() - t0;
    assert.equal(text, "", "超时就不注入");
    assert.ok(elapsed < 2500, `超时必须在截止时间内放弃，实际等了 ${elapsed}ms`);
    await waitFor(async () => {
      const t = await readLog(work);
      return /inject_failed/.test(t) ? t : null;
    }, { label: "超时被记下来" });
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

// ───────────────────────────────────────────────────────────────────────────
// IN-PLUGIN-3：问句按会话隔离（orders/IN-PLUGIN-3-query-isolation.md §四 Q1/Q3/Q5）
//
// 改前的病（真机，2026-10-20）：`injectRuntime.lastUserTexts` 是**模块级数组**，
// query = 全局最后 4 条拼起来 ⇒ 给 A 会话组装的背景，用的是"最后说话的那个会话（B）"的话。
// 实测干净会话问「我们记忆库是几层？」，注入日志 queryChars=136，而该会话最后一条真人消息只有 32 字。
// 下面三条在改前代码上必须**红**（串味/字段缺失/表不存在），改后必须**绿**。
// ───────────────────────────────────────────────────────────────────────────

test("IN-PLUGIN-3 Q1：A/B 两会话交叉验证 —— 各自只用各自的话，A 轮不得出现 B 的话", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i3-q1-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      // 节流窗口置 0：本测试要连着几轮都真注入，只看"这一轮拿的是哪句话"
      env: { ...baseEnv(work, mem), DSH_INJECT_THROTTLE_MS: "0" },
    });
    const A = "session-aaaa1111";
    const B = "session-bbbb2222";
    const textA1 = "我们记忆库是几层？";
    const textB1 = "RANK-1 的独立验收结论到底怎么说";
    const textA2 = "那第 3 层放的是什么";

    // ① A 会话问第一句
    emitTurn(h, { sessionId: A, turn: 1, text: textA1 });
    assert.ok(await assemble(h, A), "A 该注入");
    // ② 紧接着 B 会话问另一个主题 —— 改前这里会把 A 的话一起拼进 query
    emitTurn(h, { sessionId: B, turn: 1, text: textB1 });
    assert.ok(await assemble(h, B), "B 该注入");
    // ③ 回到 A 会话再问一句 —— 改前这里会把 A1 与 B1 的话一起拼进 query
    emitTurn(h, { sessionId: A, turn: 2, text: textA2 });
    assert.ok(await assemble(h, A), "A 第二轮该注入");

    const queries = mem.state.briefs.map((b) => String(b?.query ?? ""));
    assert.equal(queries.length, 3, `应当正好 3 次 brief，实际 ${queries.length}`);
    assert.equal(queries[0], textA1, `A 第 1 轮的 query 必须只有 A 那句话，实际 ${JSON.stringify(queries[0])}`);
    assert.equal(queries[1], textB1, `B 第 1 轮的 query 必须只有 B 那句话（不许带 A 的话），实际 ${JSON.stringify(queries[1])}`);
    assert.equal(queries[2], textA2, `A 第 2 轮的 query 必须只有 A 这一句（不许带 B 的话），实际 ${JSON.stringify(queries[2])}`);
    assert.ok(!queries[1].includes(textA1), "B 轮的问句里不许出现 A 会话的话");
    assert.ok(!queries[2].includes(textB1), "A 轮的问句里不许出现 B 会话的话");

    const recs = await waitFor(
      async () => {
        const r = (await injectRecords(work)).filter((x) => x.event === "inject_ok");
        return r.length >= 3 ? r : null;
      },
      { label: "3 条 inject_ok" },
    );
    const heads = recs.slice(-3).map((r) => r.queryHead);
    assert.deepEqual(heads, [textA1, textB1, textA2], `inject_ok.queryHead 必须分别是各自那句话，实际 ${JSON.stringify(heads)}`);
    const sids = recs.slice(-3).map((r) => r.sessionId);
    assert.deepEqual(sids, [A, B, A], `inject_ok.sessionId 必须如实，实际 ${JSON.stringify(sids)}`);
    assert.deepEqual(recs.slice(-3).map((r) => r.queryMessages), [1, 1, 1], "每轮只有一句真人消息 ⇒ queryMessages=1");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-3 Q3：短句（「继续」）只回补同一会话的上一条；新会话第一句就短 ⇒ 不许从别处借", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i3-q3-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), DSH_INJECT_THROTTLE_MS: "0" },
    });
    const C = "session-cccc3333";
    const D = "session-dddd4444";
    const E = "session-eeee5555";
    const longC = "记忆库的层数收敛过程到底是怎么定的";
    const textD = "完全无关的另一个主题：排序与预算";
    const short = "继续";

    emitTurn(h, { sessionId: C, turn: 1, text: longC });
    assert.ok(await assemble(h, C), "C 第一轮该注入");
    emitTurn(h, { sessionId: D, turn: 1, text: textD });
    assert.ok(await assemble(h, D), "D 该注入");
    emitTurn(h, { sessionId: C, turn: 2, text: short }); // 短句
    assert.ok(await assemble(h, C), "短句也该注入");
    emitTurn(h, { sessionId: E, turn: 1, text: short }); // 新会话第一句就短
    assert.ok(await assemble(h, E), "新会话第一句是短句也要注入（只有它自己那句）");

    const queries = mem.state.briefs.map((b) => String(b?.query ?? ""));
    assert.equal(queries.length, 4, `应当正好 4 次 brief，实际 ${queries.length}`);
    assert.equal(queries[0], longC, `C 第 1 轮的 query 只有那句话，实际 ${JSON.stringify(queries[0])}`);
    assert.equal(queries[1], textD, `D 的 query 只有它那句话，实际 ${JSON.stringify(queries[1])}`);
    assert.equal(queries[2], `${longC}\n${short}`, `短句必须回补**同一会话**的上一条，实际 ${JSON.stringify(queries[2])}`);
    assert.ok(!queries[2].includes(textD), "回补只许同一会话，不许带 D 的话");
    assert.equal(queries[3], short, `新会话第一句就短 ⇒ 只有它自己（不许从 C 借），实际 ${JSON.stringify(queries[3])}`);

    const recs = (await injectRecords(work)).filter((x) => x.event === "inject_ok").slice(-2);
    assert.equal(recs.length, 2, "应当有 C 第二轮与 E 两条 inject_ok");
    assert.equal(recs[0].sessionId, C);
    assert.equal(recs[0].queryMessages, 2, "回补时 queryMessages=2");
    assert.equal(recs[0].queryHead, `${longC}\n${short}`, "queryHead 必须是这一轮真用的问句前缀");
    assert.equal(recs[1].sessionId, E);
    assert.equal(recs[1].queryMessages, 1, "没得回补时 queryMessages=1");
    assert.equal(recs[1].queryHead, short);
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-3 Q5：会话结束清条目 + 上限 500 + 确定性淘汰（最久没被触达的先出）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i3-q5-"));
  try {
    // 只测"问句表"的生命周期：注入关掉 ⇒ 全程不联网，但事件处理照旧记账
    const h = await bootPlugin({
      workDir: work,
      apiBase: "http://127.0.0.1:1",
      env: { DSH_REFINE_ENABLED: "off", DSH_INJECT_ENABLED: "off" },
    });

    // 单个会话只留最近 2 条（回补最多只要 2 条）
    for (let i = 1; i <= 5; i += 1) emitTurn(h, { sessionId: "session-keep", turn: i, text: `第 ${i} 句真人消息` });
    let snap = h.api.injectSnapshot();
    assert.equal(snap.querySessions.maxMessages, 2, "一次 query 最多 2 条真人消息");
    assert.equal(snap.querySessions.cap, 500, "会话数上限 500");
    assert.equal(snap.querySessions.size, 1, `一个会话就一条，实际 ${snap.querySessions.size}`);
    assert.deepEqual(
      snap.querySessions.sessions[0],
      { sessionId: "session-keep", messages: 2, lastChars: "第 5 句真人消息".length, lastHead: "第 5 句真人消息" },
      "每会话只留最近 2 条，且内容是本会话自己的话",
    );

    // 600 个会话 ⇒ 只留 500，且淘汰的是**最早被触达**的 100 个（确定性，不看时钟）
    for (let i = 1; i <= 600; i += 1) emitTurn(h, { sessionId: `session-cap-${i}`, turn: 1, text: `第 ${i} 个会话的真人消息` });
    snap = h.api.injectSnapshot();
    assert.equal(snap.querySessions.size, 500, `上限必须是 500，实际 ${snap.querySessions.size}`);
    assert.equal(snap.querySessions.sessions.length, 500, "快照列出的条数与 size 一致（有界）");
    assert.equal(snap.querySessions.sessions[0].sessionId, "session-cap-101", "最早被触达的会话先被淘汰");
    assert.equal(snap.querySessions.sessions[499].sessionId, "session-cap-600", "最后被触达的会话留着");
    assert.ok(!snap.querySessions.sessions.some((s) => s.sessionId === "session-keep"), "最先被触达的会话已被淘汰");
    assert.ok(
      snap.querySessions.sessions.every((s) => s.lastHead === `第 ${s.sessionId.slice("session-cap-".length)} 个会话的真人消息`),
      "每个会话的条目都必须是它自己的话（不串味）",
    );

    // 会话结束（session/end-seed）⇒ 这条立刻消失
    h.emit({ id: "session-cap-600" }, { type: "session/end-seed" });
    snap = h.api.injectSnapshot();
    assert.equal(snap.querySessions.size, 499, `session/end-seed 必须清掉这个会话的问句，实际 ${snap.querySessions.size}`);
    assert.ok(!snap.querySessions.sessions.some((s) => s.sessionId === "session-cap-600"), "被结束的会话不该还在表里");
    await waitFor(async () => ((await readLog(work)).includes("QUERY-DROP") ? true : null), { label: "QUERY-DROP 落日志" });

    // 宿主销毁会话（ctx 上的 session/disposed）⇒ 同样清
    h.emitDisposed({ id: "session-cap-599" });
    snap = h.api.injectSnapshot();
    assert.equal(snap.querySessions.size, 498, `session/disposed 也要清，实际 ${snap.querySessions.size}`);
    assert.ok(!snap.querySessions.sessions.some((s) => s.sessionId === "session-cap-599"), "被销毁的会话不该还在表里");
    // 清掉一个会话不许动到别的会话
    assert.equal(snap.querySessions.sessions[0].sessionId, "session-cap-101", "淘汰/清理是逐会话的，别的会话不受影响");
    h.disposeAll();
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

// ───────────────────────────────────────────────────────────────────────────
// IN-PLUGIN-4：首步不注入（IN-PLUGIN-3 的回归，orders/IN-PLUGIN-4-first-step-injection.md）
//
// 改前的病（真机，2026-10-20）：宿主在 **assemble 之后**才把本轮用户消息 append 成 user/message，
// 而旧代码只在 user/message 时写问句表 ⇒ 一轮的第 1 个 model step 永远 blockedBy=no-query
// ⇒ **只跑 1 个 step 的普通问答永不注入**（真机日志：session-5677a45c 21:19:50 no-query）。
//
// 下面这几条用**真实时序**（assembleRealFirstStep）跑：
//   改前（b503ffd 那份 index.js）必须红 —— 首步拿不到问句；
//   改后必须绿 —— 首步注入，且问句逐字等于本轮这一句。
// ───────────────────────────────────────────────────────────────────────────

test("IN-PLUGIN-4 R1/R2：一轮只有 1 个 model step 时，首步就必须注入，问句是本轮这一句", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i4-r1-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const sid = "session-5677a45c-0770-4885-9d91-92a70f317698"; // 真机上那轮 no-query 的会话
    const Q = "我们记忆库是几层？";

    const injected = await assembleRealFirstStep(h, { sessionId: sid, turn: 9, text: Q });

    // ★ 这一行就是回归本体：改前是空串（首步没有任何问句 ⇒ 不注入）
    assert.ok(injected.length > 0, `单步轮次的首步必须真注入，实际注入 ${injected.length} 字`);
    assert.ok(injected.includes(MARKER), "必须带「不可信输入」标记");
    assert.equal(mem.state.briefs.length, 1, `一轮只跑 1 个 step ⇒ 只能取 1 次 brief，实际 ${mem.state.briefs.length}`);
    assert.equal(mem.state.lastBriefBody.query, Q, `brief 的 query 必须逐字等于本轮这一句，实际 ${JSON.stringify(mem.state.lastBriefBody.query)}`);

    const snap = h.api.injectSnapshot();
    assert.equal(snap.inboxSeeds, 1, `入队事件应当记下 1 笔问句，实际 ${snap.inboxSeeds}`);
    assert.equal(snap.failed + snap.skipped, 0, "首步不该有任何 skip/fail");

    finishTurn(h, { sessionId: sid }); // 答完就结束（这就是"单步轮次"）
    const recs = await waitFor(async () => {
      const r = (await injectRecords(work)).filter((x) => x.event === "inject_ok");
      return r.length >= 1 ? r : null;
    }, { label: "首步注入落 inject_ok" });
    assert.equal(recs[0].sessionId, sid, "inject_ok 的 sessionId 必须如实");
    assert.equal(recs[0].queryHead, Q, `inject_ok.queryHead 必须就是这句话，实际 ${JSON.stringify(recs[0].queryHead)}`);
    assert.equal(recs[0].queryChars, Q.length, `queryChars 必须等于这句话的长度，实际 ${recs[0].queryChars}`);
    assert.equal(recs[0].queryMessages, 1, "本轮只有一句真人消息 ⇒ queryMessages=1");
    assert.deepEqual(recs[0].includedIds, ["mem-1", "mem-2"], "includedIds 必须照抄 brief 的顺序");

    // 整份日志里不许再出现 no-query（改前的症状）
    const log = await readLog(work);
    assert.ok(!log.includes("no-query"), "改后日志里不该再出现 blockedBy=no-query");
    assert.ok(/INBOX-QUERY/.test(log), "入队那一笔要留一行 INBOX-QUERY，方便真机核对");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-4：真实时序下同一轮第 2 个 step 不再重复注入（只注入一次）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i4-once-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const sid = "session-i4-once";
    const first = await assembleRealFirstStep(h, { sessionId: sid, turn: 1, text: QUESTION });
    assert.ok(first.length > 0, "第 1 步该注入");
    const second = await assemble(h, sid); // 同一轮的第 2 个 step
    assert.equal(second, "", "同一轮第 2 个 step 不许再注入（也不许再打 brief）");
    const briefsAfterTwoSteps = mem.state.briefs.length;
    assert.equal(briefsAfterTwoSteps, 1, `整轮只该取 1 次 brief，实际 ${briefsAfterTwoSteps}`);
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-4：入队 + 落盘同一条消息只记一次（短句回补不会变成「继续\\n继续」）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i4-dedup-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { ...baseEnv(work, mem), DSH_INJECT_THROTTLE_MS: "0" },
    });
    const C = "session-i4-dedup";
    const longC = "记忆库的层数收敛过程到底是怎么定的";
    assert.ok(await assembleRealFirstStep(h, { sessionId: C, turn: 1, text: longC }), "C 第 1 轮该注入");
    finishTurn(h, { sessionId: C });
    assert.ok(await assembleRealFirstStep(h, { sessionId: C, turn: 2, text: "继续" }), "短句也该注入");

    const queries = mem.state.briefs.map((b) => String(b?.query ?? ""));
    assert.equal(queries.length, 2, `应当正好 2 次 brief，实际 ${queries.length}`);
    assert.equal(queries[0], longC);
    assert.equal(queries[1], `${longC}\n继续`, `短句必须回补**同一会话**的上一条，实际 ${JSON.stringify(queries[1])}`);
    const recs = (await injectRecords(work)).filter((x) => x.event === "inject_ok");
    assert.equal(recs[1].queryMessages, 2, `回补时 queryMessages=2（说明"继续"没被重复记成两条），实际 ${recs[1].queryMessages}`);
    assert.equal(recs[1].queryHead, `${longC}\n继续`);
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-4：入队事件里只有 source.kind=user 才算用户的话（后到的宿主上下文不许顶掉问句）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i4-kind-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const sid = "session-i4-kind";
    const Q = "我们记忆库是几层？";
    // 真机顺序里 kind=user 先入队，随后宿主还会入队/落盘这几类（都不是用户说的话）
    h.emitInboxInserted({ sessionId: sid, text: Q, kind: "user" });
    h.emitInboxInserted({ sessionId: sid, text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", kind: "plugin" });
    h.emitInboxInserted({ sessionId: sid, text: "<system-reminder>workspace instructions</system-reminder>", kind: "agent-instructions" });
    h.emitInboxInserted({ sessionId: sid, text: "<system-reminder>skills</system-reminder>", kind: "skill-catalog" });
    h.emit({ id: sid }, { type: "turn/start", data: { turn: 1 } });
    const injected = await assemble(h, sid);
    assert.ok(injected.length > 0, "该注入");
    assert.equal(mem.state.lastBriefBody.query, Q, `问句必须还是用户那句，实际 ${JSON.stringify(mem.state.lastBriefBody.query)}`);
    const snap = h.api.injectSnapshot();
    assert.equal(snap.querySessions.size, 1, "只该有一个会话的条目");
    assert.equal(snap.querySessions.sessions[0].messages, 1, `非 user 来源一条都不许记，实际 ${snap.querySessions.sessions[0].messages}`);
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("IN-PLUGIN-4 R5(本地)：真实时序下两个会话交错，各自注入各自那一句", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "i4-cross-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}`, env: baseEnv(work, mem) });
    const A = "session-i4-cross-a";
    const B = "session-i4-cross-b";
    const qa = "我们记忆库是几层？";
    const qb = "RANK-1 的独立验收结论到底怎么说";
    // 两个会话都先入队（真实顺序：入队在 turn 之前），再各自开轮
    h.emitInboxInserted({ sessionId: A, text: qa });
    h.emitInboxInserted({ sessionId: B, text: qb });
    h.emit({ id: A }, { type: "turn/start", data: { turn: 1 } });
    assert.ok(await assemble(h, A), "A 该注入");
    h.emit({ id: B }, { type: "turn/start", data: { turn: 1 } });
    assert.ok(await assemble(h, B), "B 该注入");
    const queries = mem.state.briefs.map((b) => String(b?.query ?? ""));
    assert.deepEqual(queries, [qa, qb], `两个会话必须各用各的话，实际 ${JSON.stringify(queries)}`);
    const recs = (await injectRecords(work)).filter((x) => x.event === "inject_ok");
    assert.deepEqual(recs.map((r) => r.sessionId), [A, B], "inject_ok.sessionId 必须如实");
    assert.deepEqual(recs.map((r) => r.queryHead), [qa, qb], "queryHead 各是各的");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
