#!/usr/bin/env node
/**
 * IN-PLUGIN-1 端到端（不启动 DSH）：把**暂存的插件本体**对着**真记忆服务**跑一轮。
 *
 * 做法：假 ctx 喂一组真实的 session/event（用已存在的旧会话 id + 下一轮次），
 *      插件按自己的逻辑落队列→POST→/v1/conversations/capture→服务端写 evidence。
 * 目的：把"装进 DSH 之后才会暴露"的风险压到最小 —— 剩下唯一未知只剩"DSH 会不会加载它"。
 *
 *   node e2e-against-real.mjs --base http://127.0.0.1:8788 --session session-dccc44aa-... --turn 967
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PATCH = "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const base = arg("base", "http://127.0.0.1:8788");
const sessionId = arg("session", "session-dccc44aa-5b2e-4e00-af85-d23dfe1d7860");
const turn = Number(arg("turn", "997"));
const user = arg("user", "IN-PLUGIN-1 端到端自检：这句话是经由插件本体提交的，用来验证捕获与模型无关。");

// 凭据按生产同一来源读（只读配置文件），证明身份链路也是真的
const yml = await fs.readFile(PATCH, "utf8");
const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
if (!ref || !secret) throw new Error("拿不到凭据");

const work = await fs.mkdtemp(path.join(os.tmpdir(), "inplugin1-e2e-"));
process.env.DSH_HOME = work;
process.env.INPLUGIN1_WORK_DIR = work;
process.env.MEMORY_LIB_URL = base;
process.env.MEMORY_LIB_CRED_REF = ref;
process.env.MEMORY_LIB_SECRET = secret;

const mod = await import(`./index.js?e2e=${Date.now()}`);
const handlers = [];
const disposers = [];
const ctx = {
  on(ev, fn) {
    if (ev === "session/event") handlers.push(fn);
  },
  effect(fn) {
    const d = fn();
    if (typeof d === "function") disposers.push(d);
  },
};
const api = mod.apply(ctx);
const emit = (session, event) => handlers.forEach((fn) => fn(session, event));

console.log(`base=${base}`);
console.log(`session=${sessionId} turn=${turn}`);

emit({ id: sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn } });
emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: user }] } });
emit(
  { id: sessionId },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "已记录：这条走的是插件侧捕获，与用哪个模型无关。" }] } } },
);
emit({ id: sessionId }, { type: "turn/end" });

// 等它自己发完（60 秒内即可，这里最多等 30 秒）
let snap = null;
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  snap = await api.snapshot();
  if (snap.done_turns > 0 || snap.dead_letters > 0) break;
}
console.log("");
console.log("=== 快照 ===");
console.log(JSON.stringify(snap, null, 2));

// 队列/死信文件也看一眼
const q = await fs.readdir(path.join(work, "queue")).catch(() => []);
const d = await fs.readdir(path.join(work, "dead")).catch(() => []);
console.log(`queue 文件: ${q.length}   dead 文件: ${d.length}`);
const logPath = path.join(work, "realtime.log");
const logText = await fs.readFile(logPath, "utf8").catch(() => "");
console.log("=== 插件日志 ===");
console.log(logText.trim());

for (const x of disposers) {
  try {
    x();
  } catch {}
}
await fs.rm(work, { recursive: true, force: true });
process.exit(snap && snap.done_turns > 0 && snap.dead_letters === 0 ? 0 : 1);
