// IN-PLUGIN-1 集成测试：用**假 ctx + 假记忆服务**把插件本体跑起来。
//
// 为什么要能在没有 DSH 的情况下测：插件跑在宿主进程里，改错了会连累对话；
// 能在工作区内把它跑通，就等于在装进 DSH 之前先证明一遍。
//
// 这里验证的正是范围单 §三 的四件事 + 核心判据的机制部分：
//   ① 失败不推进游标、3 次上限、死信落文件
//   ② 文件队列（进程重启后还能补发），不是无界内存队列
//   ③ 状态可查（readSnapshot 与真实落盘一致）
//   ④ 异常不抛回宿主
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSnapshot } from "./capture-core.mjs";

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时：${label}`);
}

/** 假记忆服务：记录收到的捕获请求；mode 可切换成一直失败。 */
async function startFakeMemory() {
  const state = { posts: [], mode: "ok" };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if ((req.url || "").startsWith("/v1/conversations/capture")) {
        if (state.mode === "fail") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"ok":false,"error":{"code":"BAD_REQUEST","message":"injected failure"}}');
          return;
        }
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        state.posts.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, evidenceId: `conversation-fake-${state.posts.length}` }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

/** 假 Cordis ctx：只实现插件用到的那两个能力。 */
function makeCtx() {
  const handlers = [];
  const disposers = [];
  return {
    ctx: {
      on(event, fn) {
        if (event === "session/event") handlers.push(fn);
      },
      effect(fn, _label) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
      },
    },
    emit(session, event) {
      for (const fn of handlers) fn(session, event);
    },
    disposeAll() {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** 每一轮要用的 env 必须在 import index.js 之前设好（它在模块顶层读 env）。
 *
 *  DSH_HOME 一并指到临时目录：这样插件读的 cordis.patch.yml 是**不存在的**，
 *  凭据走 env 回退 —— 测试不会去碰真实配置里的密钥，也才能断言 env 那条路径。
 */
async function bootPlugin({ workDir, apiBase }) {
  process.env.DSH_HOME = workDir;
  process.env.INPLUGIN1_WORK_DIR = workDir;
  process.env.MEMORY_LIB_URL = apiBase;
  process.env.MEMORY_LIB_CRED_REF = "memory-lib/test";
  process.env.MEMORY_LIB_SECRET = "test-secret";
  // ⚠️ 本文件只测「捕获」，必须把 REFINE-TRIGGER-1 的提炼触发关掉：
  // 它的默认落点是**生产**的 logs/ 与 state/，不关就会在跑测试时真去提炼生产证据
  // （2026-10-19 实测过一次：10 次真模型调用、7 条生产证据被标 failed —— 见
  //  reports/REFINE-TRIGGER-1-dev-report.md §十-9）。这里显式 off，别改成"记得设环境变量"。
  process.env.DSH_REFINE_ENABLED = "off";
  // 同理（IN-PLUGIN-2）：注入也要关。不关就会真去调生产的 /v1/recall/brief，
  // 还会占掉生产那份注入回执的 60 秒窗口（插件/代理都会因此让位）。
  process.env.DSH_INJECT_ENABLED = "off";
  const mod = await import(`./index.js?boot=${encodeURIComponent(`${Date.now()}-${Math.random()}`)}`);
  const h = makeCtx();
  const api = mod.apply(h.ctx);
  return { ...h, api, mod };
}

function turnEvents(h, { sessionId, turn, user, assistant }) {
  h.emit({ id: sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn } });
  h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: user }] } });
  h.emit({ id: sessionId }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: assistant }] } } });
  h.emit({ id: sessionId }, { type: "turn/end" });
}

/** 清理临时目录：插件里有 fire-and-forget 的异步写（日志/状态），直接 rm 会撞 ENOTEMPTY。
 *  先等一小拍让在途写入落地，再带退避重试删。 */
async function cleanup(dir) {
  await new Promise((r) => setTimeout(r, 150));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
}

async function tmpWork(tag) {
  return await fs.mkdtemp(path.join(os.tmpdir(), tag));
}

// ---------------------------------------------------------------------------

test("IN-PLUGIN-1 捕获成功：turn/start→user→assistant→turn/end 发出一条符合契约的捕获", async () => {
  const work = await tmpWork("inplugin1-ok-");
  const mem = await startFakeMemory();
  const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  try {
    turnEvents(h, { sessionId: "session-old-1", turn: 967, user: "你好", assistant: "在的" });
    const post = await waitFor(() => (mem.state.posts.length ? mem.state.posts[0] : null), { label: "捕获到达假服务端" });
    assert.equal(post.source, "dsh-session");
    assert.equal(post.conversation_id, "session-old-1");
    assert.equal(post.event_id, "session-old-1#turn-967", "event_id 必须与旧口径一致，服务端幂等才继续有效");
    assert.deepEqual(post.messages, [{ role: "user", content: "你好" }, { role: "assistant", content: "在的" }]);
    assert.equal(post.workspace, "D:/MemoryLib");
    assert.equal(post.credential_ref, "memory-lib/test");
    assert.equal(post.principal.agent_id, "pilot-01");
    assert.equal(post.principal.role_id, "capture-ingest");

    // 队列清空 + 状态可见
    const snap = await h.api.snapshot();
    assert.equal(snap.pending_queue, 0);
    assert.equal(snap.done_turns, 1);
    assert.ok(snap.last_success_at, "必须有最近成功时间");
    assert.equal(snap.consecutive_failures, 0);
    assert.equal(snap.dead_letters, 0);
  } finally {
    h.disposeAll();
    await mem.close();
    await cleanup(work);
  }
});

test("IN-PLUGIN-1 非真人消息不捕获（系统注入/运行时上下文都跳过）", async () => {
  const work = await tmpWork("inplugin1-skip-");
  const mem = await startFakeMemory();
  const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  try {
    h.emit({ id: "s" }, { type: "turn/start", data: { turn: 1 } });
    h.emit({ id: "s" }, { type: "user/message", data: { source: { kind: "system" }, content: "系统注入" } });
    h.emit({ id: "s" }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "好" }] } } });
    h.emit({ id: "s" }, { type: "turn/end" });
    await new Promise((r) => setTimeout(r, 300));
    // 只剩 assistant 一条：仍然会发（既有行为），但 user 段里绝不能出现系统注入
    const post = mem.state.posts[0];
    if (post) {
      assert.ok(!JSON.stringify(post.messages).includes("系统注入"), "系统注入的消息不许被当成用户的话提交");
    }
  } finally {
    h.disposeAll();
    await mem.close();
    await cleanup(work);
  }
});

test("IN-PLUGIN-1 失败不推进 + 3 次上限 + 死信落文件（旧实现的病根）", async () => {
  const work = await tmpWork("inplugin1-dead-");
  const mem = await startFakeMemory();
  mem.state.mode = "fail";
  const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  try {
    // 同一 turn 反复 end：每次都会再试一次（这正是"失败不推进游标"的直接体现）
    for (let i = 0; i < 3; i += 1) {
      turnEvents(h, { sessionId: "session-old-2", turn: 5, user: `第${i}次`, assistant: "答" });
      await waitFor(async () => {
        const snap = await h.api.snapshot();
        return snap.failed_total >= i + 1 ? snap : null;
      }, { label: `第 ${i + 1} 次失败被记账` });
    }
    const snap = await h.api.snapshot();
    assert.equal(snap.dead_turns, 1, "3 次后必须进死信");
    assert.equal(snap.dead_letters, 1, "死信必须落文件");
    assert.equal(snap.pending_queue, 0, "进了死信就不该还留在队列里");
    assert.ok(snap.last_error, "必须留下失败原因");
    assert.equal(snap.last_success_at, null, "一次都没成功，不许伪造成功时间");

    const deadFiles = await fs.readdir(path.join(work, "dead"));
    assert.equal(deadFiles.length, 1);
    const dead = JSON.parse(await fs.readFile(path.join(work, "dead", deadFiles[0]), "utf8"));
    assert.equal(dead.event_id, "session-old-2#turn-5");
    assert.match(String(dead.reason), /连续失败 3 次/);
    assert.match(String(dead.reason), /injected failure|400/);
  } finally {
    h.disposeAll();
    await mem.close();
    await cleanup(work);
  }
});

test("IN-PLUGIN-1 重启后仍会补发：待发的东西在磁盘上，不在内存里", async () => {
  const work = await tmpWork("inplugin1-restart-");
  const mem = await startFakeMemory();
  mem.state.mode = "fail";
  const first = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  let queued = 0;
  try {
    turnEvents(first, { sessionId: "session-old-3", turn: 9, user: "第一次", assistant: "答" });
    queued = await waitFor(async () => {
      const snap = await first.api.snapshot();
      return snap.pending_queue >= 1 ? snap.pending_queue : null;
    }, { label: "失败后留在队列里" });
    assert.equal(queued, 1);
  } finally {
    first.disposeAll(); // 模拟进程退出：内存里的东西全没了
  }
  try {
    // 服务端恢复 + 新一次"启动"：只靠磁盘上的队列也能补发
    mem.state.mode = "ok";
    const second = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
    try {
      const post = await waitFor(() => (mem.state.posts.length ? mem.state.posts[0] : null), { label: "重启后补发成功" });
      assert.equal(post.event_id, "session-old-3#turn-9");
      const snap = await second.api.snapshot();
      assert.equal(snap.pending_queue, 0);
      assert.equal(snap.done_turns, 1);
    } finally {
      second.disposeAll();
    }
  } finally {
    await mem.close();
    await cleanup(work);
  }
});

test("IN-PLUGIN-1 幂等：同一 turn 反复 end 只发一次（不会写两条证据）", async () => {
  const work = await tmpWork("inplugin1-idem-");
  const mem = await startFakeMemory();
  const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  try {
    turnEvents(h, { sessionId: "session-old-4", turn: 3, user: "问", assistant: "答" });
    await waitFor(() => (mem.state.posts.length === 1 ? true : null), { label: "第一次提交" });
    // 再来两遍同一个 turn
    turnEvents(h, { sessionId: "session-old-4", turn: 3, user: "问", assistant: "答" });
    turnEvents(h, { sessionId: "session-old-4", turn: 3, user: "问", assistant: "答" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mem.state.posts.length, 1, `同一个 turn 只许提交一次，实际 ${mem.state.posts.length}`);
    const snap = await h.api.snapshot();
    assert.equal(snap.done_turns, 1);
  } finally {
    h.disposeAll();
    await mem.close();
    await cleanup(work);
  }
});

test("IN-PLUGIN-1 异常不抛回宿主：垃圾事件/空会话/未知类型都必须安静", async () => {
  const work = await tmpWork("inplugin1-garbage-");
  const mem = await startFakeMemory();
  const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  try {
    assert.doesNotThrow(() => {
      h.emit(null, null);
      h.emit({}, {});
      h.emit({ id: "s" }, { type: "unknown/thing", data: null });
      h.emit({ id: "s" }, { type: "turn/start", data: null });
      h.emit({ id: "s" }, { type: "user/message", data: null });
      h.emit({ id: "s" }, { type: "assistant/message", data: null });
      h.emit({ id: "s" }, { type: "turn/end" });
    });
    await new Promise((r) => setTimeout(r, 200));
    // 不该因为垃圾事件就卡住后续正常捕获
    turnEvents(h, { sessionId: "session-old-5", turn: 1, user: "还活着吗", assistant: "活着" });
    await waitFor(() => (mem.state.posts.length >= 1 ? true : null), { label: "垃圾事件之后仍能正常捕获" });
  } finally {
    h.disposeAll();
    await mem.close();
    await cleanup(work);
  }
});

test("IN-PLUGIN-1 状态口径一致：readSnapshot（status 命令用的）与插件内快照同一个数", async () => {
  const work = await tmpWork("inplugin1-snap-");
  const mem = await startFakeMemory();
  const h = await bootPlugin({ workDir: work, apiBase: `http://127.0.0.1:${mem.port}` });
  try {
    turnEvents(h, { sessionId: "session-old-6", turn: 1, user: "问", assistant: "答" });
    await waitFor(() => (mem.state.posts.length === 1 ? true : null), { label: "提交成功" });
    const inner = await h.api.snapshot();
    const external = await readSnapshot({ workDir: work });
    assert.equal(inner.done_turns, external.done_turns);
    assert.equal(inner.pending_queue, external.pending_queue);
    assert.equal(inner.dead_letters, external.dead_letters);
    assert.equal(inner.last_success_at, external.last_success_at);
    assert.equal(inner.submitted_total, external.submitted_total);
  } finally {
    h.disposeAll();
    await mem.close();
    await cleanup(work);
  }
});
