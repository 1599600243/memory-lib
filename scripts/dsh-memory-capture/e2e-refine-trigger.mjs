#!/usr/bin/env node
/**
 * REFINE-TRIGGER-1 端到端（不启动 DSH、不经代理）：
 *   假 ctx 喂一轮 → 插件捕获到副本服务 → 捕获成功 ⇒ 插件触发提炼 →
 *   真 refine-worker 子进程跑一轮 → 副本的 refine-state 里 done 增加。
 * 目的：证明"捕获与提炼都跟代理无关"，把装进 DSH 之后才会暴露的风险压到最小。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COPY = process.argv[2] || "D:\\MemoryLib\\inject1-work\\copy";
const API = process.argv[3] || "http://127.0.0.1:8788";
const SESSION = process.argv[4] || "session-e2e-refine-1";
const TURN = Number(process.argv[5] || 1);
const LIMIT = Number(process.argv[6] || 1);
// ok（默认）= 提炼成功那一趟；refine-fail = 故意让 worker 失败，验 fail-open
const EXPECT = process.env.E2E_EXPECT ?? "ok";

const work = await fs.mkdtemp(path.join(os.tmpdir(), "rt1-e2e-"));
const logDir = path.join(work, "logs");
await fs.mkdir(logDir, { recursive: true });

const evidenceDir = path.join(COPY, "memory", "evidence", "conversations");
const refineState = path.join(COPY, "state", "refine-state.json");
await fs.mkdir(path.dirname(refineState), { recursive: true });

// 用副本自己的 refine 状态（没有就新建一个空的）
try {
  await fs.access(refineState);
} catch {
  await fs.writeFile(refineState, JSON.stringify({ evidence: {} }), "utf8");
}

const readState = async () => {
  try {
    const s = JSON.parse(await fs.readFile(refineState, "utf8"));
    const ev = Object.values(s.evidence ?? {});
    return {
      total: ev.length,
      done: ev.filter((e) => e.status === "done").length,
      skipped: ev.filter((e) => e.status === "skipped").length,
      failed: ev.filter((e) => e.status === "failed").length,
      dead: ev.filter((e) => e.status === "dead").length,
      last_success_at: s.last_success_at ?? null,
    };
  } catch {
    return null;
  }
};

// 凭据按生产同一来源读（只读配置文件），证明身份链路也是真的
// 副本实例的注册表/密钥目录是生产数据的副本 ⇒ 同一套凭据可用。
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
// 用 ??= ：调用方可以用同名环境变量覆盖（例如拿一个必坏的 worker 验 fail-open）
process.env.DSH_REFINE_LOG_DIR ??= logDir;
process.env.DSH_REFINE_STATE ??= refineState;
process.env.DSH_REFINE_EVIDENCE ??= evidenceDir;
process.env.DSH_REFINE_API ??= API;
process.env.DSH_REFINE_DATA_ROOT ??= path.join(COPY, "memory");
process.env.DSH_REFINE_LIMIT ??= String(LIMIT);
process.env.DSH_REFINE_MIN_INTERVAL_MS ??= "0";
process.env.DSH_REFINE_MODULE ??= "D:\\MemoryLib\\scripts\\refine-trigger.mjs";
process.env.DSH_REFINE_WORKER ??= "D:\\MemoryLib\\scripts\\refine-worker.mjs";
// 读状态/日志一律按**插件真正用的**目录（调用方可能覆盖了 DSH_REFINE_LOG_DIR）
const pluginLogDir = process.env.DSH_REFINE_LOG_DIR;

const mod = await import(`${pathToFileURL("D:/MemoryLib/scripts/dsh-memory-capture/index.js").href}?e2e=${Date.now()}`);
const handlers = [];
const disposers = [];
const api = mod.apply({
  on(ev, fn) { if (ev === "session/event") handlers.push(fn); },
  effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); },
});
const emit = (s, e) => handlers.forEach((fn) => fn(s, e));

const before = await readState();
console.log("API      :", API);
console.log("evidence :", evidenceDir);
console.log("state    :", refineState);
console.log("提炼前   :", JSON.stringify(before));
console.log("");

const t0 = Date.now();
// 事件循环卡顿探针：插件与探针同进程 ⇒ 若"发 trigger"这条路同步阻塞，这里会看到尖峰。
// 这是「对对话延迟的影响」的实测口径（宿主进程被卡住多久）。
let maxLagMs = 0;
const lagSamples = [];
let last = Date.now();
const lagTimer = setInterval(() => {
  const now = Date.now();
  const lag = now - last - 10;
  if (lag > maxLagMs) maxLagMs = lag;
  lagSamples.push([now, lag]);
  last = now;
}, 10);
emit({ id: SESSION, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn: TURN } });
emit({ id: SESSION }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: `REFINE-TRIGGER-1 自检：这一轮用来验证"捕获成功后会自动触发提炼"。这句话由插件本体的假 ctx 灌进来，不经过任何模型或代理。它有一定的长度，以便提炼器不会把它当成过短文本直接跳过，从而真正走到模型那一步。` }] } });
emit({ id: SESSION }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "收到，这一轮用于验证捕获触发提炼的链路；结论会写进状态文件里。" }] } } });
emit({ id: SESSION }, { type: "turn/end" });

// 等捕获成功（turn 状态 done）并且**这一轮**的提炼跑完。
// 注意：状态文件可能被上一轮用过（共用同一个 lock/status 是本单的关键），
// 所以判据必须是"计数比开局时变大"，不能是绝对值。
let snap = null;
let trig = null;
const readTrig = async () => {
  try {
    return JSON.parse(await fs.readFile(path.join(pluginLogDir, "refine-trigger-state.json"), "utf8"));
  } catch {
    return null;
  }
};
const trig0 = await readTrig();
const base = { triggered: trig0?.triggered ?? 0, succeeded: trig0?.succeeded ?? 0, failed: trig0?.failed ?? 0 };
const settled = (t) => t && t.triggered > base.triggered && t.succeeded + t.failed > base.succeeded + base.failed;
// 异步性证据：抓「已经发起提炼、但提炼还没结束」的那一瞬，看此时 turn 是否已经 done。
// 若插件同步等提炼，这一瞬永远不会出现（done 会被压到提炼结束之后）。
let asyncProof = null;
for (let i = 0; i < 240; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  snap = await api.snapshot();
  trig = await readTrig();
  if (!asyncProof && trig && trig.triggered > base.triggered && !settled(trig)) {
    asyncProof = { done_turns: snap.done_turns, at: trig.lastTriggerAt };
  }
  if (snap.done_turns > 0 && settled(trig)) {
    if (EXPECT === "refine-fail" ? trig.failed > base.failed : trig.succeeded > base.succeeded) break;
  }
}

const after = await readState();
clearInterval(lagTimer);
// 把窗口切成两段：提炼**发起之后**那一段才说明"提炼进行中宿主卡不卡"
const trigAt = trig?.lastTriggerAt ? Date.parse(trig.lastTriggerAt) : null;
const refineLag = trigAt ? lagSamples.filter(([t]) => t >= trigAt).map(([, l]) => l) : [];
console.log(`宿主事件循环最大卡顿: 全窗口 ${maxLagMs}ms（${lagSamples.length} 个 10ms 采样）`);
console.log(
  `  提炼发起后那一段: 最大 ${refineLag.length ? Math.max(...refineLag) : "-"}ms（${refineLag.length} 个采样，` +
    `覆盖 ${trig?.lastDurationMs ?? "-"}ms 的提炼全过程）`,
);
console.log("等到的捕获状态:", JSON.stringify(snap));
console.log("等到的触发状态:", JSON.stringify(trig));
console.log("不阻塞证据（提炼进行中那一瞬）:", JSON.stringify(asyncProof));
console.log("");
console.log("提炼后   :", JSON.stringify(after));
console.log(`总耗时   : ${Date.now() - t0}ms`);
console.log("");
const log = await fs.readFile(path.join(work, "realtime.log"), "utf8").catch(() => "");
console.log("=== 插件日志 ===");
console.log(log.trim().slice(-2500));
const workerLog = await fs.readFile(path.join(pluginLogDir, "refine-worker.out.log"), "utf8").catch(() => "");
console.log("=== worker 日志尾巴 ===");
console.log(workerLog.trim().split("\n").slice(-6).join("\n"));

for (const d of disposers) { try { d(); } catch {} }
const captureOk = snap?.done_turns > 0;
const notBlocking = asyncProof?.done_turns > 0;
const failedThisRun = (trig?.failed ?? 0) > base.failed;
const succeededThisRun = (trig?.succeeded ?? 0) > base.succeeded;
const okChain =
  EXPECT === "refine-fail"
    ? // fail-open：提炼明确失败并被记下来，而捕获与 turn 都不受影响
      captureOk && failedThisRun && Boolean(trig?.lastError) && snap?.dead_letters === 0 && notBlocking
    : captureOk && succeededThisRun && after && before && after.done > before.done && notBlocking;
console.log(
  EXPECT === "refine-fail"
    ? `\n结论：捕获=${captureOk} 触发失败已记账=${failedThisRun} 失败原因可见=${Boolean(trig?.lastError)} 捕获无死信=${snap?.dead_letters === 0} 不阻塞=${notBlocking}  ⇒ ${okChain ? "PASS" : "FAIL"}`
    : `\n结论：捕获=${captureOk} 触发成功=${succeededThisRun} 提炼 done 增加=${after && before ? after.done > before.done : false} 不阻塞=${notBlocking}  ⇒ ${okChain ? "PASS" : "FAIL"}`,
);
await fs.rm(work, { recursive: true, force: true });
process.exit(okChain ? 0 : 1);
