// REFINE-TRIGGER-1 测试：插件侧的提炼触发。
//
// 四件事必须成立（范围单 §三）：
//   ① 捕获成功后**会**触发一次提炼，且用的是**代理那套落点**（同一个 lock 与 trigger 状态文件）
//   ② 触发模块挂了/不在 → 捕获照常成功（fail-open）
//   ③ 代理与插件**共用一把锁** ⇒ 两边同时想提炼时只有一个进程会跑
//   ④ 提炼失败不影响捕获、不影响对话
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFINE_MODULE = path.join(HERE, "..", "refine-trigger.mjs");
// 允许指向"改前"的另一份插件（红→绿证据用）：RT1_PLUGIN_DIR=<改前备份目录>
const PLUGIN_DIR = process.env.RT1_PLUGIN_DIR || HERE;

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

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = "condition" } = {}) {
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

async function startFakeMemory({ mode = "ok" } = {}) {
  const state = { captures: 0, mode };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if ((req.url || "").startsWith("/v1/conversations/capture")) {
        if (state.mode !== "ok") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"ok":false,"error":{"code":"BAD_REQUEST","message":"injected"}}');
          return;
        }
        state.captures += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, evidenceId: `conversation-fake-${state.captures}` }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

function makeCtx() {
  const handlers = [];
  const disposers = [];
  return {
    ctx: {
      on(ev, fn) {
        if (ev === "session/event") handlers.push(fn);
      },
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
      },
    },
    emit(s, e) {
      handlers.forEach((fn) => fn(s, e));
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

/** 记账用的 trigger 桩：证明插件"叫了"，并记录它传进来的落点。 */
async function writeStubTrigger(dir) {
  const record = path.join(dir, "trigger-calls.jsonl");
  const file = path.join(dir, "stub-trigger.mjs");
  await fs.writeFile(
    file,
    `import { appendFileSync } from "node:fs";
import path from "node:path";
export function defaultPaths({ logDir, stateFile }) {
  return {
    triggerStateFile: path.join(logDir, "refine-trigger-state.json"),
    lockFile: path.join(logDir, "refine-trigger.lock"),
    triggerLogFile: path.join(logDir, "refine-trigger.log"),
    workerLogFile: path.join(logDir, "refine-worker.out.log"),
    refineStateFile: stateFile,
  };
}
export async function maybeRefine(opts) {
  appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    conversationId: opts.conversationId, stateFile: opts.stateFile, lockFile: opts.lockFile,
    workerLogFile: opts.workerLogFile, refineStateFile: opts.refineStateFile,
    evidenceDir: opts.evidenceDir, limit: opts.limit, extraArgs: opts.extraArgs,
    minIntervalMs: opts.minIntervalMs, enabled: opts.enabled,
  }) + "\\n");
  return { triggered: true, ok: true, pending: 42, durationMs: 7 };
}
`,
    "utf8",
  );
  return { file, record, read: async () => (await fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

async function bootPlugin({ workDir, apiBase, env = {} }) {
  process.env.DSH_HOME = workDir;
  process.env.INPLUGIN1_WORK_DIR = workDir;
  process.env.MEMORY_LIB_URL = apiBase;
  process.env.MEMORY_LIB_CRED_REF = "memory-lib/test";
  process.env.MEMORY_LIB_SECRET = "test";
  // ⚠️ 本文件只测提炼触发。IN-PLUGIN-2 之后插件还会去取 brief 做注入，
  // 它的默认落点是**生产**的 logs/ 与 8787 —— 不关就会在跑测试时真去打生产（同 §十·附 的教训）。
  process.env.DSH_INJECT_ENABLED = "off";
  Object.assign(process.env, env);
  const mod = await import(pathToFileURL(`${PLUGIN_DIR}/index.js`).href + `?b=${Date.now()}-${Math.random()}`);
  const h = makeCtx();
  const api = mod.apply(h.ctx);
  return { ...h, api };
}

function emitTurn(h, { sessionId, turn, user, assistant }) {
  h.emit({ id: sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn } });
  h.emit({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: user }] } });
  h.emit({ id: sessionId }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: assistant }] } } });
  h.emit({ id: sessionId }, { type: "turn/end" });
}

function pathToFileURL(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`);
}

// ---------------------------------------------------------------------------

test("REFINE-TRIGGER-1：捕获成功后触发提炼，且传的是代理那套落点（同一个 lock/status）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rt1-wire-"));
  const logDir = path.join(work, "refine-logs");
  await fs.mkdir(logDir, { recursive: true });
  const mem = await startFakeMemory();
  const stub = await writeStubTrigger(work);
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { DSH_REFINE_MODULE: stub.file, DSH_REFINE_LOG_DIR: logDir, DSH_REFINE_STATE: path.join(work, "refine-state.json"), DSH_REFINE_LIMIT: "7" },
    });
    emitTurn(h, { sessionId: "session-old-1", turn: 3, user: "问一句", assistant: "答一句" });

    await waitFor(() => (mem.state.captures === 1 ? true : null), { label: "捕获成功" });
    const calls = await waitFor(async () => {
      const c = await stub.read();
      return c.length ? c : null;
    }, { label: "触发被调用" });

    assert.equal(calls.length, 1, "一次捕获成功应触发一次");
    const c = calls[0];
    assert.equal(c.conversationId, "session-old-1", "节流键用会话 id");
    assert.equal(c.lockFile, path.join(logDir, "refine-trigger.lock"), "锁必须是代理那一个");
    assert.equal(c.stateFile, path.join(logDir, "refine-trigger-state.json"), "trigger 状态也必须是代理那一个");
    assert.equal(c.workerLogFile, path.join(logDir, "refine-worker.out.log"));
    assert.equal(c.refineStateFile, path.join(work, "refine-state.json"));
    assert.equal(c.limit, 7, "limit 从环境变量透传");
    assert.equal(c.enabled, true);
    assert.deepEqual(c.extraArgs.slice(0, 2), ["--api", `http://127.0.0.1:${mem.port}`], "worker 的 --api 跟捕获服务一致");
    assert.equal(c.extraArgs[2], "--data-root");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("REFINE-TRIGGER-1：捕获失败就不触发（没新证据，别白起进程）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rt1-nofire-"));
  const logDir = path.join(work, "refine-logs");
  await fs.mkdir(logDir, { recursive: true });
  const mem = await startFakeMemory({ mode: "fail" });
  const stub = await writeStubTrigger(work);
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: { DSH_REFINE_MODULE: stub.file, DSH_REFINE_LOG_DIR: logDir, DSH_REFINE_STATE: path.join(work, "refine-state.json") },
    });
    emitTurn(h, { sessionId: "s", turn: 1, user: "问", assistant: "答" });
    await waitFor(async () => {
      const snap = await h.api.snapshot();
      return snap.failed_total >= 1 ? snap : null;
    }, { label: "捕获失败被记账" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await stub.read()).length, 0, "捕获没成功就不该触发提炼");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("REFINE-TRIGGER-1：fail-open —— 触发模块不存在时捕获照常成功", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rt1-open-"));
  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: {
        DSH_REFINE_MODULE: path.join(work, "no-such-module.mjs"),
        // 即使模块真在，也不许落到生产的 logs/ 与 state/（这条测试只为证明 fail-open）
        DSH_REFINE_LOG_DIR: path.join(work, "logs"),
        DSH_REFINE_STATE: path.join(work, "refine-state.json"),
        DSH_REFINE_WORKER: path.join(work, "no-such-worker.mjs"),
      },
    });
    emitTurn(h, { sessionId: "s", turn: 1, user: "问", assistant: "答" });
    await waitFor(() => (mem.state.captures === 1 ? true : null), { label: "触发模块缺失也照样捕获成功" });
    const log = await fs.readFile(path.join(work, "realtime.log"), "utf8");
    assert.match(log, /提炼触发模块加载失败/, "要在日志里说清楚，但不许影响捕获");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("REFINE-TRIGGER-1：代理与插件共用一把锁 —— 两个**独立进程**同时想提炼，只跑一个", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rt1-lock-"));
  const logDir = path.join(work, "logs");
  const evidenceDir = path.join(work, "evidence");
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: true });
  // 造 3 条待提炼的证据，让 pending 不为 0
  for (let i = 0; i < 3; i += 1) await fs.writeFile(path.join(evidenceDir, `e${i}.md`), "x", "utf8");
  const stateFile = path.join(work, "refine-state.json");
  await fs.writeFile(stateFile, JSON.stringify({ evidence: {} }), "utf8");

  // 记账用的 worker 桩：每被调用一次就记一行，并睡一会儿（拉开竞争窗口）
  const workerFile = path.join(work, "stub-worker.mjs");
  const counter = path.join(work, "worker-calls.log");
  await fs.writeFile(
    workerFile,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\\n");
setTimeout(() => process.exit(0), 600);
`,
    "utf8",
  );

  // 两个独立进程，各自调一次 maybeRefine（一个扮演代理、一个扮演插件），共用同一套落点
  const runner = path.join(work, "runner.mjs");
  await fs.writeFile(
    runner,
    `import { maybeRefine, defaultPaths } from ${JSON.stringify(pathToFileURL(REFINE_MODULE).href)};
const p = defaultPaths({ logDir: ${JSON.stringify(logDir)}, stateFile: ${JSON.stringify(stateFile)} });
const r = await maybeRefine({
  stateFile: p.triggerStateFile, lockFile: p.lockFile, logFile: p.triggerLogFile,
  workerPath: ${JSON.stringify(workerFile)}, workerLogFile: p.workerLogFile, refineStateFile: p.refineStateFile,
  evidenceDir: ${JSON.stringify(evidenceDir)}, conversationId: process.argv[2], limit: 5,
  minIntervalMs: 0, globalMinIntervalMs: 0,
});
process.stdout.write(JSON.stringify({ who: process.argv[2], triggered: r.triggered, blockedBy: r.blockedBy ?? null }) + "\\n");
`,
    "utf8",
  );

  // 本机沙箱不许用管道 stdio（spawn EPERM），所以子进程的 stdout 直接指向文件
  const run = async (who) => {
    const outFile = path.join(work, `out-${who}.txt`);
    const fd = await fs.open(outFile, "w");
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner, who], { stdio: ["ignore", fd.fd, fd.fd], windowsHide: true });
        child.on("error", reject);
        child.on("exit", resolve);
      });
      const out = await fs.readFile(outFile, "utf8");
      if (code !== 0) throw new Error(`runner ${who} 退出 ${code}: ${out}`);
      return JSON.parse(out.trim().split("\n").filter(Boolean).pop());
    } finally {
      await fd.close().catch(() => {});
    }
  };

  try {
    const [a, b] = await Promise.all([run("proxy-like"), run("plugin-like")]);
    const calls = (await fs.readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean);
    assert.equal(calls.length, 1, `两个进程同时触发也只许起 1 个提炼进程，实际 ${calls.length}（${JSON.stringify([a, b])}）`);
    const triggered = [a, b].filter((x) => x.triggered).length;
    assert.equal(triggered, 1, `只该有一个进程抢到锁，实际 ${triggered}（${JSON.stringify([a, b])}）`);
    const loser = [a, b].find((x) => !x.triggered);
    assert.ok(["lock", "throttle-global", "throttle-conversation"].includes(loser.blockedBy), `没抢到的那个应当被锁/节流挡下，实际 ${loser.blockedBy}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("REFINE-TRIGGER-1：提炼失败不影响捕获（worker 退出码非 0）", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rt1-fail-"));
  const logDir = path.join(work, "logs");
  const evidenceDir = path.join(work, "evidence");
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "e0.md"), "x", "utf8");
  const stateFile = path.join(work, "refine-state.json");
  await fs.writeFile(stateFile, JSON.stringify({ evidence: {} }), "utf8");
  const badWorker = path.join(work, "bad-worker.mjs");
  await fs.writeFile(badWorker, 'process.stderr.write("boom\\n"); process.exit(1);\n', "utf8");

  const mem = await startFakeMemory();
  try {
    const h = await bootPlugin({
      workDir: work,
      apiBase: `http://127.0.0.1:${mem.port}`,
      env: {
        DSH_REFINE_MODULE: REFINE_MODULE,
        DSH_REFINE_LOG_DIR: logDir,
        DSH_REFINE_STATE: stateFile,
        DSH_REFINE_EVIDENCE: evidenceDir,
        DSH_REFINE_WORKER: badWorker,
        DSH_REFINE_MIN_INTERVAL_MS: "0",
      },
    });
    emitTurn(h, { sessionId: "s", turn: 1, user: "问", assistant: "答" });
    await waitFor(() => (mem.state.captures === 1 ? true : null), { label: "捕获成功" });
    // 提炼失败必须被记下来，但捕获已经成功、状态里 captured 仍在
    const log = await waitFor(async () => {
      const t = await fs.readFile(path.join(work, "realtime.log"), "utf8").catch(() => "");
      return /REFINE-DONE ok=false/.test(t) ? t : null;
    }, { label: "提炼失败被记录" });
    assert.match(log, /REFINE-DONE ok=false/);
    const snap = await h.api.snapshot();
    assert.equal(snap.done_turns, 1, "捕获不受提炼失败影响");
    assert.equal(snap.dead_letters, 0, "捕获侧没有死信");
    h.disposeAll();
  } finally {
    await mem.close();
    await fs.rm(work, { recursive: true, force: true });
  }
});
