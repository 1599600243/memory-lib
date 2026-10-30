// IN-PLUGIN-1 单元测试：捕获核（事件契约 / 重试判定 / 状态汇总 / 传输不抛）
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ATTEMPTS,
  SOURCE,
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

test("IN-PLUGIN-1 契约：event_id 用 <sessionId>#turn-<n>（与服务端既有的来源+会话+事件幂等对齐）", () => {
  assert.equal(turnKeyOf("session-abc", 7), "session-abc#turn-7");
  const ev = buildCaptureEvent({
    sessionId: "session-abc",
    turn: 7,
    workspace: "D:/MemoryLib",
    messages: [{ role: "user", content: "问" }, { role: "assistant", content: "答" }],
  });
  assert.equal(ev.source, SOURCE);
  assert.equal(ev.conversation_id, "session-abc");
  assert.equal(ev.event_id, "session-abc#turn-7");
  assert.equal(ev.workspace, "D:/MemoryLib");
  assert.deepEqual(ev.messages, [{ role: "user", content: "问" }, { role: "assistant", content: "答" }]);
});

test("IN-PLUGIN-1 契约：超长正文按 8000 字截断（不把整篇对话塞进一次请求）", () => {
  const long = "很".repeat(9000);
  const ev = buildCaptureEvent({ sessionId: "s", turn: 1, messages: [{ role: "user", content: long }] });
  assert.equal(ev.messages[0].content.length, 8000);
});

test("IN-PLUGIN-1 重试判定：3 次为上限，第 3 次后进死信（不是无限重试）", () => {
  assert.equal(nextAttemptVerdict(0), "retry");
  assert.equal(nextAttemptVerdict(1), "retry");
  assert.equal(nextAttemptVerdict(2), "retry");
  assert.equal(nextAttemptVerdict(3), "dead");
  assert.equal(nextAttemptVerdict(9), "dead");
  assert.equal(MAX_ATTEMPTS, 3);
});

test("IN-PLUGIN-1 取文本：只取 text 段，丢掉 reasoning/工具块", () => {
  assert.equal(textOf("直接字符串"), "直接字符串");
  assert.equal(
    textOf([
      { type: "reasoning", text: "思考过程" },
      { type: "text", text: "正文一" },
      { type: "text", text: "正文二" },
    ]),
    "正文一\n正文二",
  );
  assert.equal(textOf(null), "");
  assert.equal(textOf([{ type: "image" }]), "");
});

test("IN-PLUGIN-1 会话/工作区取值兼容多种形状", () => {
  assert.equal(sessionIdOf({ id: "a" }), "a");
  assert.equal(sessionIdOf({ sessionId: "b" }), "b");
  assert.equal(sessionIdOf({ meta: { id: "c" } }), "c");
  assert.equal(sessionIdOf({}), null);
  assert.equal(workspaceOf({ workspace: "D:\\MemoryLib\\" }), "D:/MemoryLib/");
  assert.equal(workspaceOf({ cwd: "D:\\x" }), "D:/x");
  assert.equal(workspaceOf({}), null);
});

test("IN-PLUGIN-1 状态汇总：能一眼答出四个问题（成功时间/连续失败/死信/待发）", () => {
  const now = Date.parse("2026-10-19T12:00:00.000Z");
  const state = {
    ...emptyState(),
    turns: {
      "s#turn-1": { status: "done", attempts: 1, at: "2026-10-19T11:00:00.000Z" },
      "s#turn-2": { status: "dead", attempts: 3 },
      "s#turn-3": { status: "pending", attempts: 1 },
    },
    stats: { ...emptyState().stats, lastSuccessAt: "2026-10-19T11:00:00.000Z", consecutiveFailures: 2, lastError: "HTTP 403" },
  };
  const s = summarizeState(state, { pending: 4, dead: 2, now });
  assert.equal(s.done_turns, 1);
  assert.equal(s.dead_turns, 1);
  assert.equal(s.pending_queue, 4);
  assert.equal(s.dead_letters, 2);
  assert.equal(s.consecutive_failures, 2);
  assert.equal(s.last_error, "HTTP 403");
  assert.equal(s.last_success_ago_ms, 3_600_000);
});

test("IN-PLUGIN-1 旧水位只当档案：只数会话个数，不参与任何判定", () => {
  assert.equal(legacySessionCount({ sessions: { a: { maxTurn: 5 }, b: { maxTurn: 9 } } }), 2);
  assert.equal(legacySessionCount({}), 0);
  assert.equal(legacySessionCount(null), 0);
});

test("IN-PLUGIN-1 传输：成功回 evidenceId，失败/超时/死端口一律折算成 {ok:false}，绝不抛", async () => {
  const okFetch = async () => new Response(JSON.stringify({ ok: true, evidenceId: "conversation-x" }), { status: 200 });
  const ok = await postCapture({ auth: { credential_ref: "r", secret: "s", principal: {} }, event: { event_id: "e" }, apiBase: "http://x", fetchImpl: okFetch });
  assert.equal(ok.ok, true);
  assert.equal(ok.evidenceId, "conversation-x");

  const bad = await postCapture({
    auth: {}, event: {}, apiBase: "http://x",
    fetchImpl: async () => new Response('{"ok":false,"error":{"code":"FORBIDDEN"}}', { status: 403 }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
  assert.match(bad.error, /403/);

  const timeout = await postCapture({
    auth: {}, event: {}, apiBase: "http://x",
    fetchImpl: async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; },
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /超时/);

  const deadPort = await postCapture({ auth: {}, event: {}, apiBase: "http://127.0.0.1:1", timeoutMs: 1500 });
  assert.equal(deadPort.ok, false, "死端口也必须返回而不是抛");
  assert.equal(typeof deadPort.error, "string");
});
