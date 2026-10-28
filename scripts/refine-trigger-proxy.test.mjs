/**
 * MAINPATH-2 联调测试：把**真实的 capture-proxy.mjs** 跑起来，看它会不会在自己落库之后
 * 顺手触发提炼，以及这三条纪律有没有被守住：
 *   ① 提炼再慢也不影响对话转发（客户端拿到的是逐字节一致的上游响应）
 *   ② 并发多个请求只起一个提炼进程
 *   ③ --refine=off 时一次都不触发
 *
 * 真的起代理子进程（stdio 用输出去向文件，不用管道——本机沙箱下管道会 EPERM），
 * 但上游模型与记忆服务都是本地假服务；worker 是记账用的桩，不碰真模型、不写真 data。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, "capture-proxy.mjs");

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 100, label = "condition" } = {}) {
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
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? ` / 最后错误：${lastErr.message}` : ""}`);
}

/** 假上游：固定返回一段 assistant 正文，非流式 JSON。 */
async function startFakeUpstream() {
  const body = JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    model: "deepseek-chat",
    choices: [{ index: 0, message: { role: "assistant", content: "好的，我记住了：今天在改代理里的提炼触发。" }, finish_reason: "stop" }],
  });
  const state = { hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits += 1;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, body, state, close: () => new Promise((r) => srv.close(r)) };
}

/** 假记忆服务：收到 capture 就写一份真证据文件（好让"有没有新证据"这条判断成立）。 */
async function startFakeMemory(evidenceDir) {
  const state = { captures: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (req.method === "POST" && (req.url || "").startsWith("/v1/conversations/capture")) {
        let parsed = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        state.captures.push(parsed);
        const id = `conversation-${state.captures.length}-fake`;
        try {
          const md = [
            "---",
            `eventId: ${parsed.event_id ?? id}`,
            `conversationId: ${parsed.conversation_id ?? "-"}`,
            `source: ${parsed.source ?? "capture-proxy"}`,
            `capturedAt: ${new Date().toISOString()}`,
            "---",
            "",
            `## user`,
            "",
            String(parsed.messages?.[0]?.content ?? ""),
            "",
            `## assistant`,
            "",
            String(parsed.messages?.[1]?.content ?? ""),
            "",
          ].join("\n");
          await fs.writeFile(path.join(evidenceDir, `${id}.md`), md, "utf8");
        } catch {}
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, evidenceId: id }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

/** 记账桩 worker：把每次调用记到 counterFile，然后按配置睡一会 / 按配置退出码退出。 */
async function writeStubWorker(dir, { sleepMs = 0, exitCode = 0 } = {}) {
  const file = path.join(dir, "stub-worker.mjs");
  const counter = path.join(dir, "worker-calls.log");
  const src = `
import { appendFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
appendFileSync(counter, JSON.stringify({ ts: Date.now(), argv: process.argv.slice(2), pid: process.pid }) + "\\n", "utf8");
${sleepMs > 0 ? `setTimeout(() => { process.exit(${exitCode}); }, ${sleepMs});` : `process.exit(${exitCode});`}
`;
  await fs.writeFile(file, src, "utf8");
  return { file, counter };
}

async function readCalls(counter) {
  try {
    const raw = await fs.readFile(counter, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function bootProxy({ args = [], env = {} } = {}) {
  const port = await freePort();
  const logFile = path.join(env.BOOT_LOG_DIR, "proxy.out.log");
  const fd = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [PROXY, "--port", String(port), ...args], {
    stdio: ["ignore", fd.fd, fd.fd],
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  child.proxyPort = port;
  child.logFile = logFile;
  await waitFor(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/__proxy/health`);
      return r.ok;
    },
    { label: `proxy 启动（port=${port}）` },
  );
  child.stop = async () => {
    try {
      child.kill();
    } catch {}
    await new Promise((r) => child.once("exit", r));
    try {
      await fd.close();
    } catch {}
  };
  return child;
}

function makePayload(userText) {
  return JSON.stringify({
    model: "deepseek-chat",
    stream: false,
    messages: [
      { role: "user", content: userText },
    ],
  });
}

async function postChat(port, userText) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makePayload(userText),
  });
  const text = await res.text();
  return { status: res.status, text, elapsedMs: Date.now() - t0 };
}

async function makeWorkdir(tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), tag));
  const evidenceDir = path.join(dir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const logDir = path.join(dir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const patchFile = path.join(dir, "cordis.patch.yml");
  await fs.writeFile(
    patchFile,
    ["mcp:", "  headers:", "    X-MCP-Credential-Ref: 'memory-lib/test-ref'", "    X-MCP-Secret: 'test-secret'", ""].join("\n"),
    "utf8",
  );
  return { dir, evidenceDir, logDir, patchFile };
}

/** 一组通用的代理参数：临时目录、settle=0（默认 20s 会拖慢测试）、refine 指到桩。 */
function baseArgs({ evidenceDir, patchFile, logDir, memoryPort, upstreamPort, workerFile, extra = [] }) {
  return [
    "--upstream", `http://127.0.0.1:${upstreamPort}/v1`,
    "--memory", `http://127.0.0.1:${memoryPort}`,
    "--patch", patchFile,
    "--evidence-dir", evidenceDir,
    "--settle-ms", "0",
    "--refine-worker", workerFile,
    "--refine-limit", "3",
    "--refine-trigger-file", path.join(logDir, "refine-trigger-state.json"),
    "--refine-lock", path.join(logDir, "refine-trigger.lock"),
    "--refine-worker-log", path.join(logDir, "refine-worker.out.log"),
    "--refine-state", path.join(logDir, "refine-state.json"),
    ...extra,
  ];
}

/** 预置一份 refine-state，让"有活要干"成立。 */
async function seedPendingState(logDir, n = 2) {
  const evidence = {};
  for (let i = 0; i < n; i += 1) evidence[`seed-${i}`] = { status: "pending" };
  await fs.writeFile(path.join(logDir, "refine-state.json"), JSON.stringify({ evidence }), "utf8");
}

// ---------------------------------------------------------------------------
// ① 核心：落库之后会自动触发提炼
// ---------------------------------------------------------------------------

test("代理落库一个 turn 之后会自动触发提炼（无需任何人手动跑脚本）", async () => {
  const w = await makeWorkdir("mainpath2-hook-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory(w.evidenceDir);
  const worker = await writeStubWorker(w.dir);
  await seedPendingState(w.logDir, 2);
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({
        evidenceDir: w.evidenceDir,
        patchFile: w.patchFile,
        logDir: w.logDir,
        memoryPort: memory.port,
        upstreamPort: upstream.port,
        workerFile: worker.file,
        extra: ["--refine=on"],
      }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir, BOOT_LOG_DIR: w.logDir },
    });

    const r = await postChat(proxy.proxyPort, "第一轮：请记住我在改代理里的提炼触发。");
    assert.equal(r.status, 200);

    const calls = await waitFor(async () => {
      const c = await readCalls(worker.counter);
      return c.length ? c : null;
    }, { label: "桩 worker 被调用" });

    assert.equal(calls.length, 1, "一次对话应当触发一次提炼");
    assert.ok(calls[0].argv.includes("--limit"), `worker 参数里必须带 --limit，实际 ${JSON.stringify(calls[0].argv)}`);
    assert.equal(calls[0].argv[calls[0].argv.indexOf("--limit") + 1], "3", "应当用代理配置的 limit");

    // 提炼必须写回**代理自己指向的那个**记忆服务，否则副本环境下会写进生产库
    assert.ok(calls[0].argv.includes("--api"), "worker 必须收到 --api");
    assert.equal(
      calls[0].argv[calls[0].argv.indexOf("--api") + 1],
      `http://127.0.0.1:${memory.port}`,
      "worker 的 --api 必须等于代理的 memoryBase",
    );
    assert.ok(calls[0].argv.includes("--data-root"), "worker 必须收到 --data-root");
    assert.ok(
      String(calls[0].argv[calls[0].argv.indexOf("--data-root") + 1]).replace(/[\\/]+$/, "").endsWith("memory"),
      `--data-root 应当指向证据目录所属的 memory 根，实际 ${calls[0].argv[calls[0].argv.indexOf("--data-root") + 1]}`,
    );

    // 状态文件要能回答"最近一次触发/成功"
    const triggerState = JSON.parse(await fs.readFile(path.join(w.logDir, "refine-trigger-state.json"), "utf8"));
    assert.equal(triggerState.triggered, 1);
    assert.ok(triggerState.lastTriggerAt, "状态里必须有 lastTriggerAt");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ② fail-open：提炼在跑 / 提炼很慢，对话都必须照样通
// ---------------------------------------------------------------------------

test("提炼进程还在跑的时候，连续两轮对话都照常返回，且响应与上游逐字节一致", async () => {
  const w = await makeWorkdir("mainpath2-failopen-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory(w.evidenceDir);
  // 桩 worker 睡 4 秒：这段时间里它一直占着锁，对话必须完全不受影响
  const worker = await writeStubWorker(w.dir, { sleepMs: 4000 });
  await seedPendingState(w.logDir, 2);
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({
        evidenceDir: w.evidenceDir,
        patchFile: w.patchFile,
        logDir: w.logDir,
        memoryPort: memory.port,
        upstreamPort: upstream.port,
        workerFile: worker.file,
        extra: ["--refine=on"],
      }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir, BOOT_LOG_DIR: w.logDir },
    });

    const first = await postChat(proxy.proxyPort, "第二轮：提炼在后台跑，这轮对话不能被拖慢。");
    assert.equal(first.status, 200);
    assert.equal(first.text, upstream.body, "客户端拿到的必须是上游原始响应");

    // 第一轮的落库与触发都在"响应已返回"之后异步发生，所以要等它真的起来
    const callsNow = await waitFor(async () => {
      const c = await readCalls(worker.counter);
      return c.length >= 1 ? c : null;
    }, { label: "第一个提炼进程启动" });
    assert.equal(callsNow.length, 1, "此时应已有 1 个提炼进程在跑");

    const second = await postChat(proxy.proxyPort, "第三轮：上一轮提炼还没结束，我这轮照样要通。");
    assert.equal(second.status, 200);
    assert.equal(second.text, upstream.body);
    assert.ok(second.elapsedMs < 3000, `第二轮对话不该被提炼拖住，实测 ${second.elapsedMs}ms`);

    // 锁在跑的时候不许再起第二个
    const callsAfter = await readCalls(worker.counter);
    assert.equal(callsAfter.length, 1, "提炼进程在跑时，后续请求不许再起一个，实测 " + callsAfter.length);
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("提炼失败（worker 退出码非 0）时对话仍然正常，且失败被记下来", async () => {
  const w = await makeWorkdir("mainpath2-reffail-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory(w.evidenceDir);
  const worker = await writeStubWorker(w.dir, { exitCode: 1 });
  await seedPendingState(w.logDir, 2);
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({
        evidenceDir: w.evidenceDir,
        patchFile: w.patchFile,
        logDir: w.logDir,
        memoryPort: memory.port,
        upstreamPort: upstream.port,
        workerFile: worker.file,
        extra: ["--refine=on", "--refine-min-interval-ms", "0"],
      }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir, BOOT_LOG_DIR: w.logDir },
    });

    const first = await postChat(proxy.proxyPort, "第四轮：提炼会失败，但对话必须照常。");
    assert.equal(first.status, 200, "提炼失败绝不能让对话失败");
    assert.equal(first.text, upstream.body);

    // 先把"落库成功"钉住：触发是挂在落库之后的，落库没成功就不可能有提炼失败。
    // 少了这一条，偶发的落库问题会表现成"等失败记录 15 秒超时"，看不出真因。
    await waitFor(
      async () => {
        const r = await fetch(`http://127.0.0.1:${proxy.proxyPort}/__proxy/status`);
        const j = await r.json();
        return j.captureOk >= 1 ? j : null;
      },
      { label: "代理确认 captureOk>=1（没有落库就不会有提炼）" },
    );

    await waitFor(async () => {
      const s = JSON.parse(await fs.readFile(path.join(w.logDir, "refine-trigger-state.json"), "utf8").catch(() => "{}"));
      return s.failed >= 1 ? s : null;
    }, { label: "状态文件记下失败" });

    const st = JSON.parse(await fs.readFile(path.join(w.logDir, "refine-trigger-state.json"), "utf8"));
    assert.ok(st.failed >= 1, "失败必须被计数");
    assert.match(String(st.lastError), /退出码 1/);
    assert.equal(st.succeeded ?? 0, 0, "没成功过就不许记成功");

    // 失败之后不许卡死：下一轮还能再触发
    const second = await postChat(proxy.proxyPort, "第五轮：上一轮提炼失败了，这轮还得能触发。");
    assert.equal(second.status, 200);
    const calls = await waitFor(async () => {
      const c = await readCalls(worker.counter);
      return c.length >= 2 ? c : null;
    }, { label: "失败之后还能再触发（不堵后续）" });
    assert.ok(calls.length >= 2, "一次失败不许把后面的触发全堵死");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③ 并发：只起一个
// ---------------------------------------------------------------------------

test("并发 5 个对话请求，只起一个提炼进程", async () => {
  const w = await makeWorkdir("mainpath2-conc-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory(w.evidenceDir);
  const worker = await writeStubWorker(w.dir, { sleepMs: 1500 });
  await seedPendingState(w.logDir, 5);
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({
        evidenceDir: w.evidenceDir,
        patchFile: w.patchFile,
        logDir: w.logDir,
        memoryPort: memory.port,
        upstreamPort: upstream.port,
        workerFile: worker.file,
        extra: ["--refine=on"],
      }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir, BOOT_LOG_DIR: w.logDir },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postChat(proxy.proxyPort, `并发第 ${i + 1} 轮：五个请求同时到。`)),
    );
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.text, upstream.body);
    }

    // 让后台提炼全部落地，再数
    await waitFor(async () => (await readCalls(worker.counter)).length >= 1, { label: "至少有 1 个提炼进程" });
    await new Promise((r) => setTimeout(r, 3000));
    const calls = await readCalls(worker.counter);
    assert.equal(calls.length, 1, `5 个并发请求只许起 1 个提炼进程，实测 ${calls.length}`);
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ④ 开关：--refine=off 退回纯手动
// ---------------------------------------------------------------------------

test("--refine=off：对话照常，但一次都不触发提炼", async () => {
  const w = await makeWorkdir("mainpath2-off-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory(w.evidenceDir);
  const worker = await writeStubWorker(w.dir);
  await seedPendingState(w.logDir, 3);
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({
        evidenceDir: w.evidenceDir,
        patchFile: w.patchFile,
        logDir: w.logDir,
        memoryPort: memory.port,
        upstreamPort: upstream.port,
        workerFile: worker.file,
        extra: ["--refine=off"],
      }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir, BOOT_LOG_DIR: w.logDir },
    });

    for (let i = 0; i < 2; i += 1) {
      const r = await postChat(proxy.proxyPort, `关闭提炼第 ${i + 1} 轮：对话照常，但不许触发。`);
      assert.equal(r.status, 200);
      assert.equal(r.text, upstream.body);
    }
    // 给后台足够时间犯错
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await readCalls(worker.counter)).length, 0, "--refine=off 时一次都不许触发");

    // 状态文件在代理启动时就写下了（关掉也要能看见"手动模式"）
    const st = await waitFor(async () => {
      try {
        return JSON.parse(await fs.readFile(path.join(w.logDir, "refine-trigger-state.json"), "utf8"));
      } catch {
        return null;
      }
    }, { label: "状态文件落盘" });
    assert.equal(st.enabled, false, "状态文件必须反映当前是手动模式");
    assert.equal(st.triggered, 0);
    assert.match(String(st.lastReason), /手动模式/);
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});
