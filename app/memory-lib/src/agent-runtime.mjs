// D6.2 shared agent runtime. Agents differ by configuration, not by a second loop.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createLlmClient, createLlmFailover } from "./llm.mjs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, generateObject, InvalidToolInputError, NoObjectGeneratedError, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { createPetRuntimeStore } from "./pet-runtime-store.mjs";
import { extractJson, extractJsonValues } from "./conversation-memory.mjs";
import { redactSensitiveText } from "./extraction-quality.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const STEWARD_SUBMISSION_STEP_LIMIT = 1;

const stewardDecisionItemSchema = z.object({ id: z.string().min(1), relation: z.enum(["duplicate", "contradict", "neither"]), target_id: z.string().min(1).nullable(), reason: z.string().trim().min(1) });
const stewardDecisionSchema = z.object({ decisions: z.array(stewardDecisionItemSchema) });

export function buildAgentPrompt({ prompt, input = "" } = {}) {
  return {
    instructions: String(prompt ?? "你是一个受治理的记忆助手。只使用授权工具。"),
    messages: input ? [{ role: "user", content: String(input) }] : [{ role: "user", content: "请执行当前任务并返回结果。" }],
  };
}

function parseStewardInput(input) {
  try {
    const parsed = JSON.parse(String(input ?? ""));
    return Array.isArray(parsed?.candidates) ? parsed : null;
  } catch { return null; }
}

function candidateContractFromInput(input) {
  try {
    const parsed = parseStewardInput(input);
    if (!parsed) return new Map();
    const contract = new Map(parsed.candidates.map((item) => [String(item?.id ?? ""), new Set((Array.isArray(item?.neighbors) ? item.neighbors : []).map((neighbor) => String(neighbor?.id ?? "")).filter(Boolean))]).filter(([id]) => id));
    contract.batchAdjudication = parsed.task === "adjudicate-candidates";
    return contract;
  } catch { return new Map(); }
}

function normalizeDecisionShape(raw, candidateContract) {
  if (!raw || typeof raw !== "object" || !candidateContract.size) return raw;
  if (!Array.isArray(raw) && !Array.isArray(raw.decisions)) {
    const entries = Object.entries(raw);
    if (!entries.length || !entries.every(([id, value]) => candidateContract.has(id) && value && typeof value === "object" && !Array.isArray(value))) return raw;
    return { decisions: entries.map(([id, value]) => ({ id, ...value, target_id: value?.target_id ?? null })) };
  }
  const decisions = Array.isArray(raw) ? raw : raw.decisions;
  return { ...(Array.isArray(raw) ? {} : raw), decisions: decisions.map((item) => ({ ...item, id: item?.id ?? item?.candidate_id, target_id: String(item?.relation ?? "").toLowerCase() === "neither" && String(item?.target_id ?? "").toLowerCase() === "null" ? null : item?.target_id ?? null })) };
}

function parseCompactDecisionLines(text, candidateContract) {
  const decisions = [];
  for (const line of String(text ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const match = line.match(/^([^:\s]+)\s*:\s*(duplicate|contradict|neither)\b(?:\s*\(\s*target\s+([^\s)]+)\s*\))?/iu);
    if (!match || !candidateContract.has(match[1])) return null;
    decisions.push({ id: match[1], relation: match[2].toLowerCase(), target_id: match[3] ?? null, reason: `compact steward relation: ${line}` });
  }
  return decisions.length ? { decisions } : null;
}

function validateDecisionItems(normalized, candidateContract) {
  if (!Array.isArray(normalized?.decisions)) return null;
  const decisions = [];
  const seen = new Set();
  for (const rawItem of normalized.decisions) {
    const validated = stewardDecisionItemSchema.safeParse(rawItem);
    if (!validated.success || seen.has(validated.data.id) || !decisionsMatchCandidateContract([validated.data], candidateContract)) continue;
    seen.add(validated.data.id);
    decisions.push(validated.data);
  }
  return { decisions };
}

function parseStewardDecisionText(raw, candidateContract = new Map()) {
  if (raw && typeof raw === "object") {
    const normalized = normalizeDecisionShape(Array.isArray(raw) ? { decisions: raw } : raw, candidateContract);
    return validateDecisionItems(normalized, candidateContract);
  }
  let text = String(raw ?? "").trim();
  if (!text) return null;
  const thinkEnd = text.lastIndexOf("</think>");
  if (thinkEnd >= 0) text = text.slice(thinkEnd + "</think>".length).trim();
  const compact = parseCompactDecisionLines(text, candidateContract);
  if (compact) return validateDecisionItems(compact, candidateContract);
  for (const attempt of [...new Set([text, extractJson(text), ...extractJsonValues(text)].filter(Boolean))]) {
    try {
      const parsed = JSON.parse(attempt);
      const normalized = normalizeDecisionShape(Array.isArray(parsed) ? { decisions: parsed } : parsed, candidateContract);
      const validated = validateDecisionItems(normalized, candidateContract);
      if (validated) return validated;
    } catch { /* try the next extracted JSON value */ }
  }
  return null;
}

function decisionsMatchCandidateContract(decisions, candidateContract) {
  if (!candidateContract.size) return true;
  const actual = decisions.map((item) => item.id);
  if (new Set(actual).size !== actual.length || !actual.every((id) => candidateContract.has(id))) return false;
  return decisions.every((item) => item.relation === "neither"
    ? item.target_id == null
    : typeof item.target_id === "string" && candidateContract.get(item.id).has(item.target_id));
}

function createOllamaNativeFetch({ baseURL, numCtx }) {
  const nativeURL = `${String(baseURL).replace(/\/?v1\/?$/, "")}/api/chat`;
  return async (_url, init = {}) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    const response = await fetch(nativeURL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: Array.isArray(request.messages) ? request.messages.map((message) => {
          const content = Array.isArray(message.content) ? message.content.map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "").join("\n") : message.content;
          return { ...message, content };
        }) : request.messages,
        stream: false,
        ...(Array.isArray(request.tools) && request.tools.length ? { tools: request.tools } : {}),
        options: {
          temperature: request.temperature,
          ...(Number.isInteger(numCtx) && numCtx > 0 ? { num_ctx: numCtx } : {}),
          ...(Number.isInteger(request.max_tokens) && request.max_tokens > 0 ? { num_predict: request.max_tokens } : {}),
        },
      }),
    });
    if (!response.ok) return response;
    const data = await response.json();
    const promptTokens = Number(data.prompt_eval_count ?? 0);
    const completionTokens = Number(data.eval_count ?? 0);
    const toolCalls = Array.isArray(data.message?.tool_calls) ? data.message.tool_calls.map((call, index) => ({ id: call.id ?? `call_${index + 1}`, type: "function", function: { name: call.function?.name, arguments: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}) } })) : [];
    return new Response(JSON.stringify({
      id: `ollama-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: data.model ?? request.model,
      choices: [{ index: 0, message: { role: "assistant", content: data.message?.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: data.done_reason === "length" ? "length" : toolCalls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function sanitizeRunOutput(output) {
  if (typeof output === "string") return redactSensitiveText(output).slice(0, 20000);
  if (!output || typeof output !== "object") return output;
  if (Array.isArray(output)) return output.map(sanitizeRunOutput);
  return Object.fromEntries(Object.entries(output).map(([key, value]) => [key, typeof value === "string" ? redactSensitiveText(value).slice(0, 2000) : sanitizeRunOutput(value)]));
}

export function createAgentRuntime({ dataRoot, workspaceRoot, memoryFactory, agents = {}, llmFactory = null, now = () => new Date() } = {}) {
  if (!dataRoot || typeof memoryFactory !== "function") throw new Error("agent runtime requires dataRoot and memoryFactory");
  const runtimeRoot = path.join(dataRoot, "runtime", "agents");
  const store = createPetRuntimeStore({ dataRoot, workspaceRoot });

  function configFor(agentId) {
    const config = agents?.[agentId];
    if (!config || typeof config !== "object") throw new Error(`unknown agent: ${agentId}`);
    if (!config.agent_id || !config.role_id) throw new Error(`agent ${agentId} requires agent_id and role_id`);
    return config;
  }

  function modelFor(config) {
    if (typeof llmFactory === "function") return llmFactory(config.model ?? {}, config);
    const modelConfig = config.model ?? {};
    if (modelConfig.providers) return createLlmFailover(modelConfig.providers);
    if (modelConfig.sdk !== false) {
      const endpoint = modelConfig.baseURL ?? modelConfig.apiBase ?? (modelConfig.provider === "ollama" ? "http://127.0.0.1:11434/v1" : "");
      if (endpoint) {
        const provider = createOpenAICompatible({ name: modelConfig.provider ?? "openai-compatible", baseURL: endpoint, apiKey: modelConfig.apiKey ?? "ollama", ...(modelConfig.provider === "ollama" ? { fetch: createOllamaNativeFetch({ baseURL: endpoint, numCtx: Number(modelConfig.numCtx) }) } : {}) });
        return { provider: modelConfig.provider ?? "openai-compatible", model: modelConfig.model ?? "qwen3:4b", sdkModel: provider(modelConfig.model ?? "qwen3:4b") };
      }
    }
    return createLlmClient(modelConfig);
  }

  function toolsFor(config, memory) {
    const declared = Array.isArray(config.tools) ? config.tools : [];
    const schemas = {
      review: z.object({ id: z.string().min(1), decision: z.enum(["approve", "reject", "quarantine"]), notes: z.string().optional() }),
      promote: z.object({ id: z.string().min(1) }),
      deprecate: z.object({ id: z.string().min(1), replacementId: z.string().optional(), reason: z.string().min(1) }),
      search: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100).optional() }),
      get: z.object({ id: z.string().min(1) }),
    };
    return Object.fromEntries(declared.map((name) => [name, tool({ description: `Authorized memory operation: ${name}`, inputSchema: schemas[name] ?? z.object({}).passthrough(), execute: async (args = {}) => {
      const method = memory?.[name];
      if (typeof method !== "function") throw new Error(`tool is unavailable: ${name}`);
      return method(args);
    } })]));
  }

  async function runStewardChunks({ agent, trigger, sessionId, parsedInput, chunkSize, runId, started, config, capabilities }) {
    const chunks = [];
    for (let index = 0; index < parsedInput.candidates.length; index += chunkSize) chunks.push(parsedInput.candidates.slice(index, index + chunkSize));
    const results = [];
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const childInput = JSON.stringify({ ...parsedInput, candidates: chunks[index] });
        results.push(await run({ agent, trigger: `${trigger}:chunk-${index + 1}-of-${chunks.length}`, input: childInput, sessionId, _skipDecisionChunking: true }));
      }
      const output = { decisions: results.flatMap((result) => result.output?.decisions ?? []) };
      const record = { run_id: runId, agent, agent_id: config.agent_id, role_id: config.role_id, trigger, session_id: sessionId, input_chars: JSON.stringify(parsedInput).length, input_count: parsedInput.candidates.length, prompt_chars: results.reduce((sum, result) => sum + Number(result.prompt_chars ?? 0), 0), prompt_token_estimate: results.reduce((sum, result) => sum + Number(result.prompt_token_estimate ?? 0), 0), num_ctx: results[0]?.num_ctx ?? null, max_output_tokens: results[0]?.max_output_tokens ?? null, actual_input_tokens: results.reduce((sum, result) => sum + Number(result.actual_input_tokens ?? 0), 0), actual_output_tokens: results.reduce((sum, result) => sum + Number(result.actual_output_tokens ?? 0), 0), finish_reason: results.every((result) => ["stop", "tool-calls"].includes(result.finish_reason)) ? "stop" : results.at(-1)?.finish_reason ?? null, model_output_preview: null, tools: ["submit_decisions"], model: config.model?.model ?? null, provider: config.model?.provider ?? null, model_capabilities: capabilities, started_at: started.toISOString(), completed_at: now().toISOString(), duration_ms: now().getTime() - started.getTime(), status: "completed", tool_calls: results.flatMap((result) => result.tool_calls ?? []), model_calls: results.reduce((sum, result) => sum + Number(result.model_calls ?? 0), 0), output_count: output.decisions.length, output: sanitizeRunOutput(output), chunks: results.map((result) => ({ run_id: result.run_id, input_count: result.input_count, model_calls: result.model_calls, actual_output_tokens: result.actual_output_tokens, finish_reason: result.finish_reason })) };
      await writeRun(record);
      return { run_id: runId, agent, status: "completed", output, input_count: record.input_count, model_calls: record.model_calls, tool_calls: record.tool_calls, prompt_chars: record.prompt_chars, prompt_token_estimate: record.prompt_token_estimate, actual_input_tokens: record.actual_input_tokens, actual_output_tokens: record.actual_output_tokens, finish_reason: record.finish_reason, num_ctx: record.num_ctx, max_output_tokens: record.max_output_tokens, log_path: path.join(runtimeRoot, agent, `${runId}.json`) };
    } catch (error) {
      const record = { run_id: runId, agent, agent_id: config.agent_id, role_id: config.role_id, trigger, session_id: sessionId, input_chars: JSON.stringify(parsedInput).length, input_count: parsedInput.candidates.length, prompt_chars: results.reduce((sum, result) => sum + Number(result.prompt_chars ?? 0), 0) + Number(error.prompt_chars ?? 0), prompt_token_estimate: results.reduce((sum, result) => sum + Number(result.prompt_token_estimate ?? 0), 0) + Number(error.prompt_token_estimate ?? 0), num_ctx: error.num_ctx ?? results[0]?.num_ctx ?? null, max_output_tokens: error.max_output_tokens ?? results[0]?.max_output_tokens ?? null, actual_input_tokens: results.reduce((sum, result) => sum + Number(result.actual_input_tokens ?? 0), 0) + Number(error.actual_input_tokens ?? 0), actual_output_tokens: results.reduce((sum, result) => sum + Number(result.actual_output_tokens ?? 0), 0) + Number(error.actual_output_tokens ?? 0), finish_reason: error.finish_reason ?? results.at(-1)?.finish_reason ?? null, model_capabilities: capabilities, started_at: started.toISOString(), completed_at: now().toISOString(), duration_ms: now().getTime() - started.getTime(), status: "failed", tool_calls: results.flatMap((result) => result.tool_calls ?? []), model_calls: results.reduce((sum, result) => sum + Number(result.model_calls ?? 0), 0) + Number(error.model_calls ?? 0), output_count: 0, error: String(error?.message ?? error).slice(0, 500), chunks: [...results.map((result) => ({ run_id: result.run_id, status: result.status })), { run_id: error.run_id ?? null, status: "failed" }] };
      await writeRun(record);
      throw Object.assign(new Error(record.error), { run_id: runId, log_path: path.join(runtimeRoot, agent, `${runId}.json`), model_calls: record.model_calls, prompt_chars: record.prompt_chars, prompt_token_estimate: record.prompt_token_estimate, actual_input_tokens: record.actual_input_tokens, actual_output_tokens: record.actual_output_tokens, finish_reason: record.finish_reason, num_ctx: record.num_ctx, max_output_tokens: record.max_output_tokens });
    }
  }

  async function run({ agent, trigger = "manual", input = "", sessionId = null, _skipDecisionChunking = false } = {}) {
    const config = configFor(agent);
    const runId = `run-${crypto.randomUUID()}`;
    const started = now();
    const memory = memoryFactory({ scopes: config.scopes ?? null, principal: { agent_id: config.agent_id, role_id: config.role_id }, agent_id: config.agent_id, role_id: config.role_id });
    const tools = toolsFor(config, memory);
    const model = modelFor(config);
    const capabilities = { structuredOutput: config.model?.capabilities?.structuredOutput === true, toolCalling: config.model?.capabilities?.toolCalling === true, jsonMode: config.model?.capabilities?.jsonMode === true };
    const parsedStewardInput = config.outputSchema === "steward-decisions" ? parseStewardInput(input) : null;
    const decisionChunkSize = Math.max(1, Number(config.decisionChunkSize ?? 3) || 3);
    if (!_skipDecisionChunking && parsedStewardInput?.candidates.length > decisionChunkSize) {
      return runStewardChunks({ agent, trigger, sessionId, parsedInput: parsedStewardInput, chunkSize: decisionChunkSize, runId, started, config, capabilities });
    }
    const prompt = buildAgentPrompt({ prompt: config.prompt, input });
    const candidateContract = config.outputSchema === "steward-decisions" ? candidateContractFromInput(input) : new Map();
    const expectedDecisionIds = [...candidateContract.keys()];
    const targetContract = [...candidateContract].map(([id, targets]) => `${id}=>[${[...targets].join(", ")}]`).join("; ");
    const submissionInstruction = capabilities.toolCalling ? "调用 submit_decisions 一次" : "只返回一个 decisions JSON 对象";
    const instructions = expectedDecisionIds.length ? `${prompt.instructions}\n逐条输出 id, relation, target_id, reason 四个字段，reason 非空。duplicate/contradict 的 target_id 只能取该候选近邻；neither 必须为 null。${submissionInstruction}，不要输出其他文字。候选: [${expectedDecisionIds.join(", ")}]; 可选近邻: ${targetContract}。` : prompt.instructions;
    const messages = prompt.messages;
    const promptChars = instructions.length + JSON.stringify(messages).length;
    const maxOutputTokens = Number(config.model?.maxOutputTokens);
    const numCtx = Number(config.model?.numCtx);
    const providerOptions = config.model?.provider === "ollama" && Number.isInteger(numCtx) && numCtx > 0 ? { ollama: { num_ctx: numCtx } } : undefined;
    const stewardCallSettings = {
      ...(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
    const record = { run_id: runId, agent: agent, agent_id: config.agent_id, role_id: config.role_id, trigger, session_id: sessionId, input_chars: String(input).length, input_count: expectedDecisionIds.length || (input ? 1 : 0), prompt_chars: promptChars, prompt_token_estimate: Math.ceil(promptChars / 3), num_ctx: providerOptions ? numCtx : null, max_output_tokens: Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null, actual_input_tokens: null, actual_output_tokens: null, finish_reason: null, model_output_preview: null, tools: Object.keys(tools), model: model?.model ?? config.model?.model ?? null, provider: model?.provider ?? config.model?.provider ?? null, model_capabilities: capabilities, started_at: started.toISOString(), status: "started", tool_calls: [], model_calls: 0, output_count: 0 };
    try {
      let output;
      if (model?.sdkModel && config.outputSchema === "steward-decisions") {
        if (capabilities.toolCalling) {
          let submitted = null;
          const submitDecisions = tool({ description: "Classify each candidate as duplicate, contradict, or neither. Submit once without prose.", inputSchema: stewardDecisionSchema, execute: async (args) => { submitted = args; return { accepted: args.decisions.length }; } });
          record.model_calls += 1;
          const generated = await generateText({ model: model.sdkModel, instructions, messages, tools: { submit_decisions: submitDecisions }, toolChoice: "auto", stopWhen: stepCountIs(STEWARD_SUBMISSION_STEP_LIMIT), temperature: config.temperature ?? 0.2, ...stewardCallSettings });
          record.actual_input_tokens = generated.usage?.inputTokens ?? generated.totalUsage?.inputTokens ?? null;
          record.actual_output_tokens = generated.usage?.outputTokens ?? generated.totalUsage?.outputTokens ?? null;
          record.finish_reason = generated.finishReason ?? generated.steps?.at(-1)?.finishReason ?? null;
          const calls = (generated.steps ?? []).flatMap((step) => step.toolCalls ?? []);
          record.tool_calls.push(...calls.map((call) => ({ tool: call.toolName ?? call.tool, input: call.input ?? null })));
          const submission = calls.find((call) => (call.toolName ?? call.tool) === "submit_decisions");
          output = submission?.input ?? submitted;
        } else if (capabilities.structuredOutput) {
          record.model_calls += 1;
          try {
            const generated = await generateObject({ model: model.sdkModel, instructions, messages, schema: stewardDecisionSchema, temperature: config.temperature ?? 0.2, ...stewardCallSettings });
            record.actual_input_tokens = generated.usage?.inputTokens ?? null;
            output = generated.object;
          } catch (error) { if (!NoObjectGeneratedError.isInstance(error)) throw error; output = { decisions: [] }; }
        } else {
          record.model_calls += 1;
          try {
            const generated = await generateText({ model: model.sdkModel, instructions, messages, ...(capabilities.jsonMode ? { output: Output.json() } : {}), temperature: config.temperature ?? 0.2, ...stewardCallSettings });
            record.actual_input_tokens = generated.usage?.inputTokens ?? generated.totalUsage?.inputTokens ?? null;
            record.actual_output_tokens = generated.usage?.outputTokens ?? generated.totalUsage?.outputTokens ?? null;
            record.finish_reason = generated.finishReason ?? generated.steps?.at(-1)?.finishReason ?? null;
            output = capabilities.jsonMode ? generated.output : generated.text || generated.steps?.at(-1)?.text || "";
            record.model_output_preview = sanitizeRunOutput(typeof output === "string" ? output.slice(-2000) : output);
          } catch (error) {
            if (typeof error?.text !== "string") throw error;
            output = error.text;
          }
        }
        output = parseStewardDecisionText(output, candidateContract) ?? { decisions: [] };
        if (expectedDecisionIds.length > 0 && output.decisions.length === 0) {
          const correctionMessages = [...messages, { role: "user", content: "你上次没有给出任何决策。请对每条候选输出 relation，并包含 id、target_id、reason；只返回 decisions JSON。" }];
          let corrected;
          record.model_calls += 1;
          if (capabilities.toolCalling) {
            let submitted = null;
            const submitDecisions = tool({ description: "Classify each candidate as duplicate, contradict, or neither. Submit once without prose.", inputSchema: stewardDecisionSchema, execute: async (args) => { submitted = args; return { accepted: args.decisions.length }; } });
            const generated = await generateText({ model: model.sdkModel, instructions, messages: correctionMessages, tools: { submit_decisions: submitDecisions }, toolChoice: "auto", stopWhen: stepCountIs(STEWARD_SUBMISSION_STEP_LIMIT), temperature: config.temperature ?? 0.2, ...stewardCallSettings });
            record.actual_input_tokens = generated.usage?.inputTokens ?? generated.totalUsage?.inputTokens ?? record.actual_input_tokens;
            record.actual_output_tokens = generated.usage?.outputTokens ?? generated.totalUsage?.outputTokens ?? null;
            record.finish_reason = generated.finishReason ?? generated.steps?.at(-1)?.finishReason ?? null;
            const calls = (generated.steps ?? []).flatMap((step) => step.toolCalls ?? []);
            record.tool_calls.push(...calls.map((call) => ({ tool: call.toolName ?? call.tool, input: call.input ?? null })));
            corrected = calls.find((call) => (call.toolName ?? call.tool) === "submit_decisions")?.input ?? submitted;
          } else if (capabilities.structuredOutput) {
            try { corrected = (await generateObject({ model: model.sdkModel, instructions, messages: correctionMessages, schema: stewardDecisionSchema, temperature: config.temperature ?? 0.2, ...stewardCallSettings })).object; }
            catch (error) { if (!NoObjectGeneratedError.isInstance(error)) throw error; corrected = { decisions: [] }; }
          } else {
            try {
              const generated = await generateText({ model: model.sdkModel, instructions, messages: correctionMessages, ...(capabilities.jsonMode ? { output: Output.json() } : {}), temperature: config.temperature ?? 0.2, ...stewardCallSettings });
              corrected = capabilities.jsonMode ? generated.output : generated.text || generated.steps?.at(-1)?.text || "";
              record.actual_input_tokens = generated.usage?.inputTokens ?? generated.totalUsage?.inputTokens ?? record.actual_input_tokens;
              record.actual_output_tokens = generated.usage?.outputTokens ?? generated.totalUsage?.outputTokens ?? null;
              record.finish_reason = generated.finishReason ?? generated.steps?.at(-1)?.finishReason ?? null;
              record.model_output_preview = sanitizeRunOutput(typeof corrected === "string" ? corrected.slice(-2000) : corrected);
            } catch (error) {
              if (typeof error?.text !== "string") throw error;
              corrected = error.text;
            }
          }
          output = parseStewardDecisionText(corrected, candidateContract) ?? { decisions: [] };
          if (output.decisions.length === 0) throw new Error(`model returned empty decisions (batch of ${expectedDecisionIds.length}; finish_reason=${record.finish_reason ?? "unknown"})`);
        }
      } else if (model?.sdkModel) {
        const generated = await generateText({ model: model.sdkModel, instructions, messages, tools, stopWhen: stepCountIs(Number(config.stopWhen ?? 4)), temperature: config.temperature ?? 0.2 });
        output = generated.text || generated.steps?.at(-1)?.text || "";
        record.model_calls = Math.max(1, (generated.steps ?? []).length);
        record.tool_calls = (generated.steps ?? []).flatMap((step) => (step.toolCalls ?? []).map((call) => ({ tool: call.toolName ?? call.tool, input: call.input ?? null })));
      } else if (typeof model?.run === "function") {
        output = await model.run({ messages, tools, stopWhen: config.stopWhen ?? 4 });
        record.model_calls = 1;
      } else {
        output = await model.chat(messages, { temperature: config.temperature ?? 0.2 });
        record.model_calls = 1;
      }
      record.status = "completed";
      record.output_count = typeof output === "string" ? 1 : Array.isArray(output) ? output.length : output ? 1 : 0;
      record.completed_at = now().toISOString();
      record.duration_ms = now().getTime() - started.getTime();
      record.output = sanitizeRunOutput(output);
      await writeRun(record);
      return { run_id: runId, agent, status: record.status, output, input_count: record.input_count, model_calls: record.model_calls, tool_calls: record.tool_calls, prompt_chars: record.prompt_chars, prompt_token_estimate: record.prompt_token_estimate, actual_input_tokens: record.actual_input_tokens, actual_output_tokens: record.actual_output_tokens, finish_reason: record.finish_reason, num_ctx: record.num_ctx, max_output_tokens: record.max_output_tokens, log_path: path.join(runtimeRoot, agent, `${runId}.json`) };
    } catch (error) {
      record.status = "failed";
      record.error = String(error?.message ?? error).slice(0, 500);
      record.completed_at = now().toISOString();
      record.duration_ms = now().getTime() - started.getTime();
      await writeRun(record);
      throw Object.assign(new Error(record.error), { run_id: runId, log_path: path.join(runtimeRoot, agent, `${runId}.json`), model_calls: record.model_calls, prompt_chars: record.prompt_chars, prompt_token_estimate: record.prompt_token_estimate, actual_input_tokens: record.actual_input_tokens, actual_output_tokens: record.actual_output_tokens, finish_reason: record.finish_reason, num_ctx: record.num_ctx, max_output_tokens: record.max_output_tokens });
    }
  }

  async function writeRun(record) {
    const dir = path.join(runtimeRoot, record.agent);
    const file = path.join(dir, `${record.run_id}.json`);
    // ATOMICWRITE-1：收敛到统一助手（含建目录 + rename 重试）。
    await atomicWriteFile(file, JSON.stringify(record, null, 2) + "\n");
  }

  async function listRuns({ agent = null, limit = 50 } = {}) {
    const dirs = agent ? [agent] : Object.keys(agents);
    const files = [];
    for (const id of dirs) {
      const entries = await fs.readdir(path.join(runtimeRoot, id), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".json")) files.push(path.join(runtimeRoot, id, entry.name));
    }
    const values = [];
    for (const file of files.sort().reverse().slice(0, Math.max(1, Math.min(500, Number(limit) || 50)))) {
      try { values.push(JSON.parse(await fs.readFile(file, "utf8"))); } catch { /* ignore incomplete log */ }
    }
    return values;
  }

  return { run, listRuns, configFor, runtimeRoot, store };
}
