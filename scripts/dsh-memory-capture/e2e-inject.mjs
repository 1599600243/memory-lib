#!/usr/bin/env node
/**
 * IN-PLUGIN-2 端到端（不启动 DSH、不经代理）：
 *   假 ctx（带 systemPrompt 服务）→ 插件自己调 **真记忆服务的 /v1/recall/brief**
 *   → 把简报预热成注入块 → 按宿主的调用方式同步问 section.text()
 *   → 打印真注入文本、字数、命中 id、以及"同一轮/工具轮/代理让位"三条行为。
 *
 *   node e2e-inject.mjs [副本根] [api] [sessionId] [turn]
 *
 * 目的：把"装进 DSH 之后才会暴露"的风险压到最小 —— 剩下的未知只剩"宿主的 assemble 会不会真的调这个 section"。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COPY = process.argv[2] || "D:\\MemoryLib\\inject1-work\\copy";
const API = process.argv[3] || "http://127.0.0.1:8788";
const SESSION = process.argv[4] || "session-dccc44aa-5b2e-4e00-af85-d23dfe1d7860";
const TURN = Number(process.argv[5] || 1040);
const QUESTION = process.env.E2E_QUESTION || "我们记忆库是几层？";

const work = await fs.mkdtemp(path.join(os.tmpdir(), "i2-e2e-"));
const receiptFile = path.join(work, "inject-receipt.json");

// 凭据按生产同一来源读（只读配置文件）：副本实例的注册表是生产数据的副本 ⇒ 同一套凭据可用
const PATCH = "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml";
const yml = await fs.readFile(PATCH, "utf8");
const credRef = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const credSecret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
if (!credRef || !credSecret) throw new Error("拿不到凭据");

process.env.DSH_HOME = work;
process.env.INPLUGIN1_WORK_DIR = work;
process.env.MEMORY_LIB_URL = API;
process.env.MEMORY_LIB_CRED_REF = credRef;
process.env.MEMORY_LIB_SECRET = credSecret;
// 本自检只验注入：提炼关掉，落点全部指到临时目录（绝不碰生产）
process.env.DSH_REFINE_ENABLED = "off";
process.env.DSH_INJECT_ENABLED = "on";
process.env.DSH_INJECT_BRIEF_URL = `${API}/v1/recall/brief`;
process.env.DSH_INJECT_RECEIPT = receiptFile;
process.env.DSH_INJECT_MAX_CHARS = "600";
process.env.DSH_INJECT_TIMEOUT_MS = "3000";
process.env.DSH_INJECT_REFRESH_MS = "3600000";

const mod = await import(`${pathToFileURL("D:/MemoryLib/scripts/dsh-memory-capture/index.js").href}?e2e=${Date.now()}`);
const handlers = [];
const assemblers = [];
const disposers = [];
const sections = [];
const systemPrompt = {
  section(sec) {
    sections.push(sec);
    return () => {
      const i = sections.indexOf(sec);
      if (i >= 0) sections.splice(i, 1);
    };
  },
};
const ctx = {
  on(ev, fn) {
    if (ev === "session/event") handlers.push(fn);
    if (ev === "system-prompt/assemble") assemblers.push(fn);
  },
  effect(fn) {
    const d = fn();
    if (typeof d === "function") disposers.push(d);
  },
  get(name) {
    return name === "systemPrompt" ? systemPrompt : undefined;
  },
  systemPrompt,
};
const api = mod.apply(ctx);
const emit = (s, e) => handlers.forEach((fn) => fn(s, e));
/** 复刻宿主：先按注册的 section 组装，再跑 assemble waterfall，读回 memory-lib:recall 那一段。 */
const ask = async (sessionId) => {
  const value = { sections: [{ name: "harness:identity", text: "You are an AI agent." }, ...sections.map((s) => ({ name: s.name, text: typeof s.text === "function" ? s.text({}) : s.text }))], contexts: [], tools: [], variables: {} };
  const context = { agent: { session: { id: sessionId } }, scope: null };
  const chain = async (i) => (i >= assemblers.length ? value : await assemblers[i](value, context, () => chain(i + 1)));
  const out = await chain(0);
  const slot = (out.sections ?? []).find((s) => s.name === "memory-lib:recall");
  return slot?.text ?? "";
};

const log = async () => await fs.readFile(path.join(work, "realtime.log"), "utf8").catch(() => "");
const waitFor = async (fn, { timeoutMs = 20000, intervalMs = 50, label = "条件" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时：${label}`);
};

console.log("API      :", API);
console.log("session  :", SESSION);
console.log("receipt  :", receiptFile);
console.log("inject   :", JSON.stringify(mod.inject));
console.log("sections :", sections.map((s) => `${s.name}@${s.order}`).join(",") || "(none)");
console.log("");

// 1) 启动预热：插件自己在加载后就去取 brief


// 2) 旧会话发一轮 → 问 section（宿主就是这么同步问的）
emit({ id: SESSION, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn: TURN } });
emit({ id: SESSION }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: QUESTION }] } });

const t0 = Date.now();
const block1 = await ask(SESSION);
const askMs = Date.now() - t0;
console.log("");
console.log(`组装这一轮注入耗时 : ${askMs}ms（含 brief 往返；上限 ${process.env.DSH_INJECT_TIMEOUT_MS ?? 3000}ms）`);
console.log(`注入文本长度           : ${block1 ? block1.length : 0} 字符`);
console.log("=== 真注入文本（这就是模型会看到的那一段）===");
console.log(block1 || "(空)");

// 3) 同一轮再问一次 ⇒ 必须为空（每轮只注入一次）
const block2 = await ask(SESSION);
// 4) 工具轮 ⇒ 必须为空
emit({ id: SESSION }, { type: "tool/call", data: { name: "pwsh" } });
const block3 = await ask(SESSION);
// 5) 另一个会话 ⇒ 由回执节流决定（同一会话窗口外才放行；换会话应放行）
emit({ id: "session-other", workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn: 1 } });
emit({ id: "session-other" }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: QUESTION }] } });
const block4 = await ask("session-other");

const receiptMod = await import(pathToFileURL("D:/MemoryLib/scripts/inject-receipt.mjs").href);
const receiptAfter = receiptMod.readReceipt(receiptFile);
// 6) 模拟"代理随后对同一轮注入" ⇒ 必须让位
const proxyClaim = receiptMod.claimReceipt(receiptFile, { source: receiptMod.SOURCE_PROXY, conversationId: "proxy-key", chars: 200 });

const pluginLog = await log();
const okLine = pluginLog.split("\n").find((l) => l.includes("inject_ok"));
let rec = null;
try {
  rec = JSON.parse(okLine.slice(okLine.indexOf("{")));
} catch {
  rec = null;
}

console.log("");
console.log("同轮第二次             :", JSON.stringify(block2));
console.log("工具轮                 :", JSON.stringify(block3));
console.log("换会话                 :", `${block4 ? block4.length + " 字符（放行）" : "空（被回执挡住）"}`);
console.log("回执（插件认领后）     :", JSON.stringify(receiptAfter.last));
console.log("代理随后认领同一轮     :", JSON.stringify({ allowed: proxyClaim.allowed, blockedBy: proxyClaim.blockedBy, reason: proxyClaim.reason }));
console.log("inject_ok 记录         :", JSON.stringify(rec));
console.log("");
console.log("=== 插件日志 ===");
console.log(pluginLog.trim().split("\n").slice(-8).join("\n"));

const sectionCount = sections.length;
const declaredInject = JSON.stringify(mod.inject);
for (const d of disposers) {
  try {
    d();
  } catch {}
}
const hasMemory = Boolean(block1 && block1.includes("记忆注入"));
const withinCap = Boolean(block1) && block1.replace(/^【[^】]*】/, "").trim().length <= 600;
const okChain =
  mod.inject.length === 1 &&
  sectionCount === 1 &&
  hasMemory &&
  withinCap &&
  !block1.includes("{{") &&
  block2 === "" &&
  block3 === "" &&
  rec?.includedIds?.length >= 1 &&
  receiptAfter.last?.source === "plugin" &&
  proxyClaim.allowed === false;
console.log("");
console.log(
  `\n结论：声明=${declaredInject} section=${sectionCount} 有注入=${hasMemory} ≤600=${withinCap} 同轮一次=${block2 === ""} 工具轮不注=${block3 === ""} includedIds=${rec?.includedIds?.length ?? 0} 代理让位=${proxyClaim.allowed === false}  ⇒ ${okChain ? "PASS" : "FAIL"}`,
);
await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
process.exitCode = okChain ? 0 : 1;
