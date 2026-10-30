import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentRuntime, buildAgentPrompt } from "../src/agent-runtime.mjs";
import { MockLanguageModelV3 } from "ai/test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d6-runtime-"));
const dataRoot = path.join(root, "memory");
const workspaceRoot = root;
after(async () => fs.rm(root, { recursive: true, force: true }));

test("AI SDK v7 prompt keeps system instructions out of messages", () => {
  const prompt = buildAgentPrompt({ prompt: "steward instructions", input: "decide" });
  assert.equal(prompt.instructions, "steward instructions");
  assert.deepEqual(prompt.messages, [{ role: "user", content: "decide" }]);
  assert.equal(prompt.messages.some((message) => message.role === "system"), false);
  const longInput = "x".repeat(13000);
  assert.equal(buildAgentPrompt({ prompt: "steward", input: longInput }).messages[0].content.length, longInput.length);
});

test("agent runtime switches provider by configuration and records governed run metadata", async () => {
  const seen = [];
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    agents: {
      steward: { agent_id: "pilot-01", role_id: "steward", scopes: [], tools: ["search"], prompt: "管家" },
      learner: { agent_id: "pilot-01", role_id: "learner", scopes: [], tools: ["search"], prompt: "学习助手", model: { provider: "cloud", model: "cloud-model" } },
    },
    memoryFactory: () => ({ search: async (args) => { seen.push(args); return [{ path: "authorized.md" }]; } }),
    llmFactory: (model) => ({ provider: model.provider ?? "ollama", model: model.model ?? "qwen3:4b", async chat(messages) { return messages.at(-1)?.content ?? "ok"; } }),
  });
  const result = await runtime.run({ agent: "learner", trigger: "manual", input: "复习授权记忆" });
  assert.equal(result.status, "completed");
  assert.equal(result.input_count, 1);
  assert.equal(result.model_calls, 1);
  assert.match(result.log_path, /runtime[\\/]agents[\\/]learner/);
  const log = JSON.parse(await fs.readFile(result.log_path, "utf8"));
  assert.equal(log.agent_id, "pilot-01");
  assert.equal(log.role_id, "learner");
  assert.equal(log.provider, "cloud");
  assert.equal(log.model, "cloud-model");
  assert.deepEqual(seen, []);
});

test("steward uses one relation-only submit_decisions tool call when supported", async () => {
  const decisions = { decisions: [{ id: "candidate-1", relation: "neither", target_id: null, reason: "no matching neighbor" }] };
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls += 1;
      if (calls > 1) throw new Error("steward requested a duplicate submit_decisions step");
      assert.equal(options.toolChoice?.type, "auto");
      assert.equal(options.tools?.[0]?.name, "submit_decisions");
      return {
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "submit_decisions", input: JSON.stringify(decisions) }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: true } } } },
    memoryFactory: () => ({}),
    llmFactory: () => ({ provider: "ollama", model: "tool-model", sdkModel: model }),
  });
  const result = await runtime.run({ agent: "steward", input: '{"task":"classify-candidate-relations","candidates":[{"id":"candidate-1","neighbors":[]}]}' });
  assert.deepEqual(result.output, decisions);
  assert.deepEqual(result.tool_calls[0].input, decisions);
  assert.equal(calls, 1);
  assert.equal(result.model_calls, 1);
  assert.equal(result.tool_calls.length, 1);
  const log = JSON.parse(await fs.readFile(result.log_path, "utf8"));
  assert.deepEqual(log.model_capabilities, { structuredOutput: false, toolCalling: true, jsonMode: false });
});

test("default Ollama runtime bridges OpenAI calls to native context options", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (url, init) => {
    observed = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: "qwen3:4b", message: { role: "assistant", content: '{"decisions":[{"id":"candidate-1","relation":"neither","target_id":null,"reason":"unrelated"}]}' }, done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 40 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { provider: "ollama", model: "qwen3:4b", baseURL: "http://127.0.0.1:11434/v1", numCtx: 8192, maxOutputTokens: 2048, capabilities: { structuredOutput: false, toolCalling: false } } } }, memoryFactory: () => ({}) });
    const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
    assert.equal(observed.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(observed.body.options.num_ctx, 8192);
    assert.equal(observed.body.options.num_predict, 2048);
    const lastContent = observed.body.messages.at(-1).content;
    assert.equal(typeof lastContent, "string");
    assert.doesNotMatch(lastContent, /\/no_think/);
    assert.doesNotMatch(JSON.stringify(observed.body.messages), /\/no_think/);
    assert.equal(result.actual_input_tokens, 120);
    assert.equal(result.output.decisions.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("default Ollama runtime preserves native submit_decisions tool calls", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (url, init) => {
    observed = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: "qwen3:4b", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "submit_decisions", arguments: { decisions: [{ id: "candidate-1", relation: "neither", target_id: null, reason: "unrelated" }] } } }] }, done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 40 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { provider: "ollama", model: "qwen3:4b", baseURL: "http://127.0.0.1:11434/v1", numCtx: 8192, maxOutputTokens: 4096, capabilities: { structuredOutput: false, toolCalling: true } } } }, memoryFactory: () => ({}) });
    const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
    assert.equal(observed.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(observed.body.options.num_predict, 4096);
    assert.equal(observed.body.tools[0].function.name, "submit_decisions");
    assert.equal(result.model_calls, 1);
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.output.decisions.length, 1);
    assert.equal(result.actual_output_tokens, 40);
    assert.equal(result.finish_reason, "tool-calls");
  } finally { globalThis.fetch = originalFetch; }
});

test("steward shards five candidates and merges one complete stopped decision set", async () => {
  const chunks = [];
  const model = new MockLanguageModelV3({ doGenerate: async (options) => {
    const rendered = JSON.stringify(options.prompt);
    const ids = chunks.length === 0 ? ["c1", "c2", "c3"] : ["c4", "c5"];
    for (const id of ids) assert.match(rendered, new RegExp(`\\b${id}\\b`, "u"));
    chunks.push(ids);
    const decisions = { decisions: ids.map((id) => ({ id, relation: "neither", target_id: null, reason: "unrelated" })) };
    return { content: [{ type: "tool-call", toolCallId: `call-${chunks.length}`, toolName: "submit_decisions", input: JSON.stringify(decisions) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 200, text: 20, reasoning: 180 } }, warnings: [] };
  } });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", decisionChunkSize: 3, model: { maxOutputTokens: 6144, capabilities: { structuredOutput: false, toolCalling: true } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "chunk-model", sdkModel: model }) });
  const candidates = Array.from({ length: 5 }, (_, index) => ({ id: `c${index + 1}`, neighbors: [] }));
  const result = await runtime.run({ agent: "steward", trigger: "five-test", input: JSON.stringify({ task: "classify-candidate-relations", candidates }) });
  assert.deepEqual(chunks.map((chunk) => chunk.length), [3, 2]);
  assert.equal(result.input_count, 5);
  assert.equal(result.model_calls, 2);
  assert.equal(result.output.decisions.length, 5);
  assert.equal(result.actual_output_tokens, 400);
  assert.equal(result.finish_reason, "stop");
});

test("steward sends configured Ollama context and output budgets and reports prompt size", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async (options) => {
    assert.equal(options.maxOutputTokens, 2048);
    assert.equal(options.providerOptions?.ollama?.num_ctx, 8192);
    assert.equal(options.providerOptions?.ollama?.options, undefined);
    return { content: [{ type: "text", text: '{"decisions":[{"id":"candidate-1","relation":"neither","target_id":null,"reason":"unrelated"}]}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 123, noCache: 123, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 45, text: 20, reasoning: 25 } }, warnings: [] };
  } });
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    agents: { steward: { agent_id: "pilot-01", role_id: "steward", prompt: "短提示", outputSchema: "steward-decisions", model: { provider: "ollama", numCtx: 8192, maxOutputTokens: 2048, capabilities: { structuredOutput: false, toolCalling: false } } } },
    memoryFactory: () => ({}),
    llmFactory: () => ({ provider: "ollama", model: "budget-model", sdkModel: model }),
  });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","content":"新事实","neighbors":[]}]}' });
  assert.equal(result.num_ctx, 8192);
  assert.equal(result.max_output_tokens, 2048);
  assert.ok(result.prompt_chars > 0);
  assert.equal(result.prompt_token_estimate, Math.ceil(result.prompt_chars / 3));
  const log = JSON.parse(await fs.readFile(result.log_path, "utf8"));
  assert.equal(log.prompt_chars, result.prompt_chars);
  assert.equal(log.prompt_token_estimate, result.prompt_token_estimate);
});

test("steward normalizes qwen string null for neither targets", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text", text: '[{"id":"candidate-1","relation":"neither","target_id":"null","reason":"unrelated"}]' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "null-model", sdkModel: model }) });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
  assert.equal(result.output.decisions[0].target_id, null);
  assert.equal(result.model_calls, 1);
});

test("steward parses JSON after qwen thinking text", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text", text: '分析中出现错误示例 {"decisions":[]}。\n</think>\n{"decisions":[{"id":"candidate-1","relation":"neither","target_id":null,"reason":"unrelated"}]}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "thinking-model", sdkModel: model }) });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
  assert.equal(result.model_calls, 1);
  assert.equal(result.output.decisions[0].relation, "neither");
});

test("steward accepts a bounded candidate-keyed decision map from text fallback", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text", text: '{"candidate-1":{"relation":"neither","reason":"new fact","target_id":null}}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false, jsonMode: false } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "map-model", sdkModel: model }) });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { decisions: [{ id: "candidate-1", relation: "neither", reason: "new fact", target_id: null }] });
});

test("steward JSON mode requests unstructured JSON without schema output", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      assert.equal(options.responseFormat?.type, "json");
      assert.equal(options.responseFormat?.schema, undefined);
      const renderedPrompt = JSON.stringify(options.prompt);
      assert.match(renderedPrompt, /逐条输出 id, relation, target_id, reason/iu);
      assert.match(renderedPrompt, /只返回一个 decisions JSON 对象/iu);
      assert.doesNotMatch(renderedPrompt, /Use submit_decisions exactly once/i);
      return { content: [{ type: "text", text: '{"decisions":[{"id":"candidate-1","relation":"neither","reason":"new fact","target_id":null}]}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    },
  });
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false, jsonMode: true } } } },
    memoryFactory: () => ({}),
    llmFactory: () => ({ provider: "ollama", model: "json-model", sdkModel: model }),
  });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
  assert.deepEqual(result.output, { decisions: [{ id: "candidate-1", relation: "neither", reason: "new fact", target_id: null }] });
  assert.equal(result.model_calls, 1);
});

test("steward invalid-only output retries once and fails explicitly", async () => {
  let loads = 0;
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1;
      return { content: [{ type: "text", text: '{"decisions":[{"id":"candidate-1","relation":"duplicate","reason":"duplicate","target_id":"unknown"}]}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    },
  });
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false } } } },
    memoryFactory: () => ({}),
    llmFactory: () => { loads += 1; return { provider: "ollama", model: "text-model", sdkModel: model }; },
  });
  await assert.rejects(runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[{"id":"mem-1"}]}]}' }), (error) => {
    assert.match(error.message, /model returned empty decisions \(batch of 1; finish_reason=stop\)/);
    assert.equal(error.finish_reason, "stop");
    assert.equal(error.model_calls, 2);
    return true;
  });
  assert.equal(loads, 1);
  assert.equal(calls, 2);
});

test("steward preserves valid decisions when another batch row is malformed", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text", text: '{"decisions":[{"id":"valid","relation":"neither","target_id":null,"reason":"unrelated"},{"id":"invalid","relation":"neither","target_id":null}]}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "partial-model", sdkModel: model }) });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"valid","neighbors":[]},{"id":"invalid","neighbors":[]}]}' });
  assert.deepEqual(result.output, { decisions: [{ id: "valid", relation: "neither", target_id: null, reason: "unrelated" }] });
  assert.equal(result.model_calls, 1);
});


test("steward retries one empty decision response with a correction", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async (options) => {
    calls += 1;
    if (calls === 2) assert.match(JSON.stringify(options.prompt), /上次没有给出任何决策/iu);
    const text = calls === 1 ? '{"decisions":[]}' : '{"decisions":[{"id":"candidate-1","relation":"neither","target_id":null,"reason":"unrelated"}]}';
    return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
  } });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "text-model", sdkModel: model }) });
  const result = await runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' });
  assert.equal(result.model_calls, 2);
  assert.equal(calls, 2);
  assert.equal(result.output.decisions.length, 1);
});

test("steward fails explicitly after two empty decision responses", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => { calls += 1; return { content: [{ type: "text", text: '{"decisions":[]}' }], finishReason: { unified: "length", raw: "length" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4096, text: 0, reasoning: 4096 } }, warnings: [] }; } });
  const runtime = createAgentRuntime({ dataRoot, workspaceRoot, agents: { steward: { agent_id: "pilot-01", role_id: "steward", outputSchema: "steward-decisions", model: { capabilities: { structuredOutput: false, toolCalling: false } } } }, memoryFactory: () => ({}), llmFactory: () => ({ provider: "ollama", model: "empty-model", sdkModel: model }) });
  let failedLogPath;
  await assert.rejects(runtime.run({ agent: "steward", input: '{"candidates":[{"id":"candidate-1","neighbors":[]}]}' }), (error) => {
    failedLogPath = error.log_path;
    assert.match(error.message, /model returned empty decisions \(batch of 1; finish_reason=length\)/);
    assert.equal(error.finish_reason, "length");
    assert.equal(error.actual_output_tokens, 4096);
    assert.equal(error.model_calls, 2);
    assert.ok(error.run_id);
    assert.ok(error.prompt_chars > 0);
    assert.equal(error.prompt_token_estimate, Math.ceil(error.prompt_chars / 3));
    return true;
  });
  assert.equal(calls, 2);
  const run = JSON.parse(await fs.readFile(failedLogPath, "utf8"));
  assert.equal(run.finish_reason, "length");
  assert.equal(run.actual_output_tokens, 4096);
});

test("agent tools call only the injected memory facade", async () => {
  let calls = 0;
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    agents: { steward: { agent_id: "pilot-01", role_id: "steward", tools: ["search"] } },
    memoryFactory: () => ({ search: async (args) => { calls += 1; return args; } }),
    llmFactory: () => ({ provider: "ollama", model: "qwen3:4b", async run({ tools }) { return tools.search.execute({ query: "x" }); } }),
  });
  await runtime.run({ agent: "steward", input: "x" });
  assert.equal(calls, 1);
});
