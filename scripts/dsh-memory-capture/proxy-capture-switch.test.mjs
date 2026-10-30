// IN-PLUGIN-1：代理侧捕获开关（`--capture=off`）的联调测试。
//
// 为什么需要它：捕获搬回智能体侧之后，如果代理还在落库，同一个 turn 会变成两条证据。
// 这里用真代理 + 假上游 + 假记忆服务验证：off 时一个 capture 请求都不许发，on 时照旧。
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, "..", "capture-proxy.mjs");

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

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e; // 端口还没起来时 fetch 会抛，必须继续等
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时：${label}${lastErr ? ` / 最后错误：${lastErr.message}` : ""}`);
}

async function startFakeUpstream() {
  const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "好的，我记住了：这条回复足够长，够落库用。" } }] });
  const state = { hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits += 1;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

async function startFakeMemory() {
  const state = { captures: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if ((req.url || "").startsWith("/v1/conversations/capture")) {
        state.captures += 1;
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

async function bootProxy({ extraArgs, logDir, evidenceDir, patchFile, memoryPort, upstreamPort }) {
  const port = await freePort();
  const fd = await fs.open(path.join(logDir, "out.log"), "a");
  const child = spawn(
    process.execPath,
    [
      PROXY,
      "--port", String(port),
      "--upstream", `http://127.0.0.1:${upstreamPort}/v1`,
      "--memory", `http://127.0.0.1:${memoryPort}`,
      "--patch", patchFile,
      "--evidence-dir", evidenceDir,
      "--settle-ms", "0",
      "--refine=off",
      "--inject=off",
      ...extraArgs,
    ],
    { stdio: ["ignore", fd.fd, fd.fd], windowsHide: true, env: { ...process.env, CAPTURE_PROXY_LOGDIR: logDir } },
  );
  child.proxyPort = port;
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/__proxy/health`)).ok, { label: "proxy 启动" });
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

async function makeWorkdir(tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), tag));
  const evidenceDir = path.join(dir, "evidence");
  const logDir = path.join(dir, "logs");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  const patchFile = path.join(dir, "cordis.patch.yml");
  await fs.writeFile(patchFile, "mcp:\n  headers:\n    X-MCP-Credential-Ref: 'memory-lib/test'\n    X-MCP-Secret: 'test'\n", "utf8");
  return { dir, evidenceDir, logDir, patchFile };
}

async function chat(port, text) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: text }] }),
  });
}

test("IN-PLUGIN-1：--capture=off 时代理一个 capture 请求都不发（不双写的前提）", async () => {
  const w = await makeWorkdir("inplugin1-proxy-off-");
  const up = await startFakeUpstream();
  const mem = await startFakeMemory();
  let proxy = null;
  try {
    proxy = await bootProxy({ extraArgs: ["--capture=off"], logDir: w.logDir, evidenceDir: w.evidenceDir, patchFile: w.patchFile, memoryPort: mem.port, upstreamPort: up.port });
    const r = await chat(proxy.proxyPort, "关掉代理捕获之后，这句话不该被代理落库。");
    assert.equal(r.status, 200, "对话照常");
    await waitFor(() => (up.state.hits === 1 ? true : null), { label: "转发到达上游" });
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(mem.state.captures, 0, `--capture=off 时不许发 capture，实际 ${mem.state.captures} 次`);

    const log = await fs.readFile(path.join(w.logDir, "capture-proxy.log"), "utf8");
    assert.ok(log.includes("capture_disabled"), "日志要能看出是被关掉、而不是没触发");
  } finally {
    if (proxy) await proxy.stop();
    await up.close();
    await mem.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-1：默认（不传开关）仍是 on —— 不能因为这次改动把捕获悄悄关掉", async () => {
  const w = await makeWorkdir("inplugin1-proxy-default-");
  const up = await startFakeUpstream();
  const mem = await startFakeMemory();
  let proxy = null;
  try {
    proxy = await bootProxy({ extraArgs: [], logDir: w.logDir, evidenceDir: w.evidenceDir, patchFile: w.patchFile, memoryPort: mem.port, upstreamPort: up.port });
    const r = await chat(proxy.proxyPort, "不传开关时，代理仍应按旧行为落库（行为不变）。");
    assert.equal(r.status, 200);
    await waitFor(() => (mem.state.captures === 1 ? true : null), { label: "默认仍会捕获" });
    const log = await fs.readFile(path.join(w.logDir, "capture-proxy.log"), "utf8");
    assert.ok(!log.includes("capture_disabled"));
  } finally {
    if (proxy) await proxy.stop();
    await up.close();
    await mem.close();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});
