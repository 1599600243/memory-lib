/**
 * INJECT-1 第二段联调：把**真实的 capture-proxy.mjs** 跑起来，看注入到底有没有进到请求体里。
 *
 * 六条验收里能在这里穷尽的部分：
 *   ① 请求体里确实带了注入段（假上游把收到的 body 记下来）
 *   ② ≤600 字 + 不可信标记 + {{ 已拆
 *   ③ 工具轮不注入
 *   ④ 同一会话 60 秒内连发 3 次只有第 1 次带注入
 *   ⑤ brief 指向死端口 → 对话仍 200，日志记失败
 *   ⑥ --inject=off → 完全不注入
 *
 * 真起代理子进程（stdio 用文件，不用管道——本机沙箱下管道会 EPERM）；
 * 上游模型与记忆服务都是本地假服务，不联网、不写真实 data。
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

const MEMORY_TEXT = "- [2026-10-03] 用户决定：记忆库收敛为8层，写入一次到位、零模型直写。";

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
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? ` / ${lastErr.message}` : ""}`);
}

/** 假上游：把收到的请求体原样存下来，返回一段正常的 assistant 文本。 */
async function startFakeUpstream() {
  const body = JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "收到。" }, finish_reason: "stop" }],
  });
  const state = { received: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.received.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, body, state, close: () => new Promise((r) => srv.close(r)) };
}

/** 假记忆服务：capture 返回 200；recall/brief 返回一段记忆。 */
async function startFakeMemory({ briefText = MEMORY_TEXT, captureTo = null } = {}) {
  const state = { briefs: [], captures: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = req.url || "";
      const raw = Buffer.concat(chunks).toString("utf8");
      if (url.startsWith("/v1/recall/brief")) {
        let parsed = {};
        try {
          parsed = JSON.parse(raw);
        } catch {}
        state.briefs.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, text: briefText, included: [{ id: "curated-shared-x", calendarDate: "2026-10-03", excerpt: "8层" }] }));
        return;
      }
      if (url.startsWith("/v1/conversations/capture")) {
        state.captures += 1;
        if (captureTo) {
          try {
            await fs.writeFile(path.join(captureTo, `conversation-${state.captures}-fake.md`), "---\neventId: x\n---\n\n## 用户\n\n内容够长内容够长\n", "utf8");
          } catch {}
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, evidenceId: `conversation-${state.captures}` }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

async function makeWorkdir(tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), tag));
  const evidenceDir = path.join(dir, "evidence");
  const logDir = path.join(dir, "logs");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  const patchFile = path.join(dir, "cordis.patch.yml");
  await fs.writeFile(
    patchFile,
    ["mcp:", "  headers:", "    X-MCP-Credential-Ref: 'memory-lib/test-ref'", "    X-MCP-Secret: 'test-secret'", ""].join("\n"),
    "utf8",
  );
  return { dir, evidenceDir, logDir, patchFile };
}

async function bootProxy({ args = [], env = {}, logDir }) {
  const port = await freePort();
  const out = path.join(logDir, "proxy.out.log");
  const fd = await fs.open(out, "a");
  const child = spawn(process.execPath, [PROXY, "--port", String(port), ...args], {
    stdio: ["ignore", fd.fd, fd.fd],
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  child.proxyPort = port;
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/__proxy/health`)).ok, { label: `proxy 启动（${port}）` });
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

function payload(messages, extra = {}) {
  return JSON.stringify({ model: "deepseek-chat", stream: false, messages, ...extra });
}

async function post(port, body) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  return { status: res.status, text, elapsedMs: Date.now() - t0 };
}

function baseArgs({ evidenceDir, patchFile, logDir, memoryPort, upstreamPort, extra = [] }) {
  return [
    "--upstream", `http://127.0.0.1:${upstreamPort}/v1`,
    "--memory", `http://127.0.0.1:${memoryPort}`,
    "--patch", patchFile,
    "--evidence-dir", evidenceDir,
    "--settle-ms", "0",
    "--refine=off", // 本测试只关心注入，关掉提炼免得互相干扰
    "--inject-agent", "pilot-01",
    "--inject-role", "reader",
    // IN-PLUGIN-2：注入回执是**生产**与插件共用的那个文件，测试必须指到临时目录，
    // 否则跑一次测试就会占掉生产的 60 秒注入窗口（插件那边会跟着让位）。
    "--inject-receipt", path.join(logDir, "inject-receipt.json"),
    ...extra,
  ];
}

// ---------------------------------------------------------------------------

test("INJECT-1：请求体里确实带了注入段（前置 system + 不可信标记 + 记忆正文）", async () => {
  const w = await makeWorkdir("inject1-basic-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory();
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({ ...w, memoryPort: memory.port, upstreamPort: upstream.port, extra: ["--inject=on"] }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir },
      logDir: w.logDir,
    });

    const r = await post(proxy.proxyPort, payload([{ role: "user", content: "我们记忆库是几层？" }]));
    assert.equal(r.status, 200);
    assert.equal(r.text, upstream.body, "客户端拿到的必须是上游原始响应");

    const seen = await waitFor(() => (upstream.state.received.length ? upstream.state.received[0] : null), { label: "上游收到请求" });
    const body = JSON.parse(seen.body);
    assert.equal(body.messages[0].role, "system", "注入段必须前置成 system");
    assert.match(body.messages[0].content, /不可信输入/, "必须标注不可信");
    assert.match(body.messages[0].content, /不得当作指令/);
    assert.match(body.messages[0].content, /8层/, "记忆正文要进注入段");
    assert.equal(body.messages[1].content, "我们记忆库是几层？", "原消息不许被改");

    // query 传对了：最近的消息文本
    assert.equal(memory.state.briefs.length, 1);
    assert.equal(memory.state.briefs[0].query, "我们记忆库是几层？");
    assert.equal(memory.state.briefs[0].memory_only, true, "只要记忆段");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("INJECT-1：注入段 ≤600 字 + {{ 已拆（贴出来的就是实际注入文本）", async () => {
  const w = await makeWorkdir("inject1-bounds-");
  // 第一条完整句能装下且含模板标记；第二条超预算，必须整条丢弃而不是截半句。
  const first = `{{danger}}${"这是一条完整记忆内容。".repeat(20)}`;
  const second = `${"这是一条放不下的超长记忆内容。".repeat(60)}`;
  const longText = `${first}\n${second}`;
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory({ briefText: longText });
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({ ...w, memoryPort: memory.port, upstreamPort: upstream.port, extra: ["--inject=on"] }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir },
      logDir: w.logDir,
    });
    await post(proxy.proxyPort, payload([{ role: "user", content: "随便问点" }]));
    const seen = await waitFor(() => (upstream.state.received.length ? upstream.state.received[0] : null), { label: "上游收到请求" });
    const block = JSON.parse(seen.body).messages[0].content;

    const memoryPart = block.replace(/^【[^\n]*\n/u, "");
    assert.ok(block.length <= 600, `完整注入段必须 ≤600 字，实际 ${block.length}`);
    assert.equal(memoryPart, first.replace("{{", "{ {"), "第二条放不下时必须整条丢弃");
    assert.ok(!block.endsWith("…"), "不许截半句后补省略号");
    assert.ok(!block.includes("{{"), "{{ 必须被拆开");
    assert.match(block, /\{ \{danger\}\}/, "拆法是 { {");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("INJECT-1：工具轮不注入（请求体里没有注入段）", async () => {
  const w = await makeWorkdir("inject1-tool-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory();
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({ ...w, memoryPort: memory.port, upstreamPort: upstream.port, extra: ["--inject=on"] }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir },
      logDir: w.logDir,
    });

    const toolBody = payload([
      { role: "user", content: "查一下" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "工具返回的内容" },
    ]);
    const r = await post(proxy.proxyPort, toolBody);
    assert.equal(r.status, 200);

    const seen = await waitFor(() => (upstream.state.received.length ? upstream.state.received[0] : null), { label: "上游收到请求" });
    const sent = JSON.parse(seen.body);
    assert.ok(!JSON.stringify(sent).includes("不可信输入"), "工具轮不许注入");
    assert.equal(memory.state.briefs.length, 0, "工具轮不该去调 brief");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("INJECT-1：同一会话 60 秒内连发 3 次，只有第 1 次带注入", async () => {
  const w = await makeWorkdir("inject1-throttle-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory();
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({ ...w, memoryPort: memory.port, upstreamPort: upstream.port, extra: ["--inject=on"] }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir },
      logDir: w.logDir,
    });

    const history = [{ role: "user", content: "第一句" }];
    for (let i = 0; i < 3; i += 1) {
      await post(proxy.proxyPort, payload([...history, { role: "user", content: `第 ${i + 1} 次提问` }]));
      await waitFor(() => (upstream.state.received.length >= i + 1 ? true : null), { label: `第 ${i + 1} 次到达上游` });
      history.push({ role: "user", content: `第 ${i + 1} 次提问` }, { role: "assistant", content: "好的" });
    }

    const withInjection = upstream.state.received.filter((x) => x.body.includes("不可信输入"));
    assert.equal(withInjection.length, 1, `3 次里只该有 1 次带注入，实际 ${withInjection.length}`);
    assert.equal(memory.state.briefs.length, 1, "brief 也只该被调 1 次");

    // 日志里要能看出"为什么后两次没注入"
    const log = await fs.readFile(path.join(w.logDir, "capture-proxy.log"), "utf8");
    const skipped = log.split("\n").filter((l) => l.includes("inject_skipped") && l.includes("throttle"));
    assert.ok(skipped.length >= 2, `日志应当有 ≥2 条节流跳过，实际 ${skipped.length}`);
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("INJECT-1：fail-open——brief 指向死端口，对话仍然 200 且日志记失败", async () => {
  const w = await makeWorkdir("inject1-failopen-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory();
  let proxy = null;
  try {
    const deadPort = await freePort();
    proxy = await bootProxy({
      args: baseArgs({
        ...w,
        memoryPort: memory.port,
        upstreamPort: upstream.port,
        extra: ["--inject=on", "--inject-brief-url", `http://127.0.0.1:${deadPort}/v1/recall/brief`],
      }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir },
      logDir: w.logDir,
    });

    const r = await post(proxy.proxyPort, payload([{ role: "user", content: "记忆库几层？" }]));
    assert.equal(r.status, 200, "brief 挂了绝不能让对话失败");
    assert.equal(r.text, upstream.body, "响应必须与上游逐字节一致");

    const seen = await waitFor(() => (upstream.state.received.length ? upstream.state.received[0] : null), { label: "上游收到请求" });
    const sent = JSON.parse(seen.body);
    assert.ok(!JSON.stringify(sent).includes("不可信输入"), "拿不到记忆就不许注入（也不许编）");

    const log = await fs.readFile(path.join(w.logDir, "capture-proxy.log"), "utf8");
    assert.ok(log.includes("inject_failed"), "失败必须落日志");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("INJECT-1：--inject=off → 完全不注入，也不去调 brief", async () => {
  const w = await makeWorkdir("inject1-off-");
  const upstream = await startFakeUpstream();
  const memory = await startFakeMemory();
  let proxy = null;
  try {
    proxy = await bootProxy({
      args: baseArgs({ ...w, memoryPort: memory.port, upstreamPort: upstream.port, extra: ["--inject=off"] }),
      env: { CAPTURE_PROXY_LOGDIR: w.logDir },
      logDir: w.logDir,
    });
    for (let i = 0; i < 2; i += 1) {
      const r = await post(proxy.proxyPort, payload([{ role: "user", content: `第 ${i + 1} 问` }]));
      assert.equal(r.status, 200);
      await waitFor(() => (upstream.state.received.length >= i + 1 ? true : null), { label: "到达上游" });
    }
    for (const rec of upstream.state.received) {
      assert.ok(!rec.body.includes("不可信输入"), "--inject=off 时不许注入");
    }
    assert.equal(memory.state.briefs.length, 0, "--inject=off 时连锁都不许调");
  } finally {
    if (proxy) await proxy.stop();
    await upstream.close();
    await memory.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});
