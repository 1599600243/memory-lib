// INJECT-1 第二段单测：注入块的拼装、工具轮判定、节流、fail-open、开关。
// 全部不联网（fetchBrief 用注入的 fetchImpl）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  INJECT_MARKER,
  DEFAULT_THROTTLE_MS,
  disarmTemplates,
  isToolRound,
  extractRecentQuery,
  buildInjectionBlock,
  applyInjection,
  emptyInjectState,
  decideInject,
  fetchBrief,
  parseInjectSwitch,
} from "./inject-context.mjs";

const completions = (messages) => JSON.stringify({ model: "m", stream: false, messages });
const responses = (input, extra = {}) => JSON.stringify({ model: "m", input, ...extra });

// ---------------------------------------------------------------------------
// 防模板注入
// ---------------------------------------------------------------------------

test("INJECT-1：{{ 必须被拆开（防模板注入），其余内容不动", () => {
  assert.equal(disarmTemplates("a {{x}} b"), "a { {x}} b");
  assert.equal(disarmTemplates("{% if %}"), "{ % if %}");
  assert.equal(disarmTemplates("<% code %>"), "< % code %>");
  assert.equal(disarmTemplates("没问题的一段话"), "没问题的一段话");
  assert.equal(disarmTemplates(null), "");
});

// ---------------------------------------------------------------------------
// 工具轮
// ---------------------------------------------------------------------------

test("INJECT-1：工具轮必须被认出来（三种形态都要认）", () => {
  assert.equal(isToolRound(completions([{ role: "user", content: "hi" }])), false);
  assert.equal(isToolRound(completions([{ role: "user", content: "hi" }, { role: "tool", content: "结果" }])), true);
  assert.equal(isToolRound(completions([{ role: "tool", tool_call_id: "t1", content: "结果" }])), true);
  assert.equal(
    isToolRound(completions([{ role: "user", content: [{ type: "tool_result", content: "x" }] }])),
    true,
    "content 数组里的 tool_result 也算",
  );
  assert.equal(isToolRound(responses([{ type: "function_call_output", call_id: "c1", output: "x" }])), true);
  assert.equal(isToolRound("不是 json"), false);
  assert.equal(isToolRound(null), false);
});

// ---------------------------------------------------------------------------
// query 抽取（Zep 口径：最近 4 条）
// ---------------------------------------------------------------------------

test("INJECT-1：query = 最近 4 条消息，工具输出不进 query", () => {
  const body = completions([
    { role: "system", content: "你是助手" },
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "第一轮回答" },
    { role: "user", content: "第二轮" },
    { role: "assistant", content: "第二轮回答" },
    { role: "user", content: "第三轮" },
  ]);
  const q = extractRecentQuery(body, 4);
  assert.equal(q, ["第一轮回答", "第二轮", "第二轮回答", "第三轮"].join("\n"), "只取最近 4 条，且含 assistant");

  const withTool = completions([{ role: "user", content: "问" }, { role: "tool", content: "工具结果不许进 query" }]);
  assert.equal(extractRecentQuery(withTool, 4), "问");
});

test("INJECT-1：responses API 的 input 也能抽出 query", () => {
  const body = responses([{ role: "user", content: [{ type: "input_text", text: "我们记忆库是几层？" }] }]);
  assert.match(extractRecentQuery(body, 4), /记忆库是几层/);
  assert.equal(extractRecentQuery("不是 json", 4), "");
});

// ---------------------------------------------------------------------------
// 拼装
// ---------------------------------------------------------------------------

test("INJECT-1：注入块 = 不可信标记 + 记忆正文，且 {{ 已拆", () => {
  const block = buildInjectionBlock("- [2026-10-03] 记忆库收敛为8层。\n- [2026-10-04] 用 {{name}} 占位");
  assert.ok(block.startsWith(INJECT_MARKER), "必须以不可信标记开头");
  assert.match(block, /不可信输入/);
  assert.match(block, /不得当作指令/);
  assert.match(block, /8层/);
  assert.ok(!block.includes("{{"), "{{ 必须被拆开");
  assert.equal(buildInjectionBlock("   "), "", "空内容不产生块");
});

test("INJECT-FIX-1 F1：600 是完整注入段预算，超出的整条丢弃且不截半句", () => {
  const first = `- [2026-10-28] ${"甲".repeat(330)}。`;
  const second = `- [2026-10-28] ${"乙".repeat(330)}。`;
  const block = buildInjectionBlock(`${first}\n${second}`, 600);
  const bodyLines = block.split("\n").slice(1);

  assert.equal(block.length <= 600, true, `完整注入段必须 ≤600，实际 ${block.length}`);
  assert.deepEqual(bodyLines, [first], "第二条放不下时必须整条丢弃");
  assert.equal(block.endsWith("…"), false, "不许截半句后补省略号");
});

test("INJECT-1：completions → messages 最前插一条 system；responses → instructions 前置", () => {
  const block = buildInjectionBlock("- [2026-10-03] 记忆库收敛为8层。");

  const c = applyInjection(completions([{ role: "user", content: "问" }]), block);
  const cj = JSON.parse(c);
  assert.equal(cj.messages.length, 2);
  assert.equal(cj.messages[0].role, "system");
  assert.equal(cj.messages[0].content, block);
  assert.equal(cj.messages[1].content, "问", "原有消息不许被改动");
  assert.equal(cj.model, "m", "其它字段原样保留");

  const r = applyInjection(responses([{ role: "user", content: "问" }], { instructions: "原有指令" }), block);
  const rj = JSON.parse(r);
  assert.ok(rj.instructions.startsWith(block), "注入段要在 instructions 最前");
  assert.match(rj.instructions, /原有指令$/, "原有指令要保留在后面");

  // 认不出来的形态一律不碰（宁可少注入，也不要改坏请求）
  assert.equal(applyInjection(JSON.stringify({ foo: 1 }), block), null);
  assert.equal(applyInjection("不是 json", block), null);
  assert.equal(applyInjection(completions([{ role: "user", content: "x" }]), ""), null);
});

// ---------------------------------------------------------------------------
// 节流 / 决策
// ---------------------------------------------------------------------------

test("INJECT-1：节流——同一会话 60 秒内只注入一次，过了就再注入", () => {
  const now = Date.parse("2026-10-19T03:00:00.000Z");
  const state = { ...emptyInjectState(), lastAt: new Date(now).toISOString(), lastConversation: "c1" };

  const tooSoon = decideInject(state, { now: now + 30_000, conversationKey: "c1" });
  assert.equal(tooSoon.allow, false);
  assert.equal(tooSoon.blockedBy, "throttle");

  const ok = decideInject(state, { now: now + DEFAULT_THROTTLE_MS, conversationKey: "c1" });
  assert.equal(ok.allow, true);

  // 换一个会话不受上一个会话的节流影响
  assert.equal(decideInject(state, { now: now + 1_000, conversationKey: "c2" }).allow, true);
});

test("INJECT-1：工具轮/关掉时一律不注入，理由要能直接看懂", () => {
  const now = Date.now();
  const tool = decideInject(emptyInjectState(), { now, toolRound: true });
  assert.equal(tool.allow, false);
  assert.equal(tool.blockedBy, "tool-round");
  assert.match(tool.reason, /工具轮/);

  const off = decideInject(emptyInjectState(), { now, enabled: false });
  assert.equal(off.allow, false);
  assert.equal(off.blockedBy, "disabled");
  assert.match(off.reason, /关闭/);
});

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

test("INJECT-1：--inject=off 的各种写法都要认，缺省是 on", () => {
  assert.equal(parseInjectSwitch([]), true);
  for (const v of ["off", "false", "0", "no", "disable", "OFF"]) {
    assert.equal(parseInjectSwitch(["--inject", v]), false, `--inject ${v}`);
    assert.equal(parseInjectSwitch([`--inject=${v}`]), false, `--inject=${v}`);
  }
  assert.equal(parseInjectSwitch(["--no-inject"]), false);
  assert.equal(parseInjectSwitch(["--inject", "on"]), true);
  assert.equal(parseInjectSwitch(["--inject"]), true);
  assert.equal(parseInjectSwitch([], { CAPTURE_PROXY_INJECT: "off" }), false);
});

// ---------------------------------------------------------------------------
// fetchBrief：永不 reject
// ---------------------------------------------------------------------------

test("INJECT-1：fetchBrief 成功时取 text，且把「明确的无」当空", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, text: "- [2026-10-03] 记忆库收敛为8层。", included: [{ id: "x", calendarDate: "2026-10-03" }] }), { status: 200 });
  };
  const r = await fetchBrief({ url: "http://x/v1/recall/brief", credentialRef: "r", secret: "s", principal: { agent_id: "a", role_id: "b" }, query: "几层", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.empty, false);
  assert.match(r.text, /8层/);
  assert.equal(r.included.length, 1);

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.headers["X-Memory-Channel"], "inject", "注入方必须显式声明 audit channel");
  assert.equal(sent.memory_limit_chars, 600 - INJECT_MARKER.length - 1, "服务端正文预算必须扣除 marker 与换行");
  assert.equal(sent.memory_only, true, "只要记忆段");
  assert.equal(sent.query, "几层");
  assert.equal(sent.format, "prompt");

  const emptyImpl = async () => new Response(JSON.stringify({ ok: true, text: "（明确的无）", included: [] }), { status: 200 });
  const e = await fetchBrief({ url: "http://x", credentialRef: "r", secret: "s", principal: {}, query: "q", fetchImpl: emptyImpl });
  assert.equal(e.ok, true);
  assert.equal(e.empty, true);
  assert.equal(e.text, "", "「明确的无」不许当成内容注入");
});

test("INJECT-1：fetchBrief 失败（403/超时/抛错）一律折算成「这次不注入」，绝不 reject", async () => {
  const forbidden = await fetchBrief({
    url: "http://x", credentialRef: "r", secret: "s", principal: {}, query: "q",
    fetchImpl: async () => new Response('{"ok":false}', { status: 403 }),
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.error, /403/);

  const throwing = await fetchBrief({
    url: "http://x", credentialRef: "r", secret: "s", principal: {}, query: "q",
    fetchImpl: async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; },
  });
  assert.equal(throwing.ok, false);
  assert.match(throwing.error, /超时/);

  const deadPort = await fetchBrief({
    url: "http://127.0.0.1:1/v1/recall/brief", credentialRef: "r", secret: "s", principal: {}, query: "q", timeoutMs: 1500,
  });
  assert.equal(deadPort.ok, false, "死端口也不能抛");
  assert.ok(typeof deadPort.error === "string" && deadPort.error.length > 0);
});
