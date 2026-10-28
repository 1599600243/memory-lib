#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sourcePlugin = path.join(repoRoot, "scripts", "dsh-memory-capture", "index.js");
const activeLog = "C:\\Users\\admin\\.dsh\\memory-capture\\realtime.log";
const activeReceipt = "D:\\MemoryLib\\logs\\inject-receipt.json";
const activeAudit = "D:\\MemoryLib\\data\\runtime\\audit\\access.jsonl";
const usage = "Usage: node scripts/verify-inject.mjs --agent dsh | --dry [--json]";
const args = process.argv.slice(2);
const json = args.includes("--json");
const dry = args.includes("--dry");
const agentIndex = args.indexOf("--agent");
const agent = agentIndex >= 0 ? args[agentIndex + 1] : null;
const valid = (dry && !agent) || (!dry && agent === "dsh");
if (!valid || args.some((arg, index) => !["--dry", "--json", "--agent", "dsh"].includes(arg) && index !== agentIndex + 1)) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

function check(id, title, pass, observed, evidence = []) {
  return { id, title, pass: Boolean(pass), observed, evidence };
}

function parseJsonAfter(line, token) {
  const at = line.indexOf(`${token} {`);
  if (at < 0) return null;
  try { return JSON.parse(line.slice(at + token.length + 1)); } catch { return null; }
}

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); } catch { return ""; }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

function auditRows(text) {
  return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function isCompleteSentenceBlock(block) {
  const body = String(block ?? "").split(/\r?\n/u).slice(1).join("\n").trim();
  if (!body || /…\s*$/u.test(body)) return false;
  const contentLines = body.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !/^#+\s/u.test(line));
  return contentLines.length > 0 && contentLines.every((line) => /[。！？.!?）)】]$/u.test(line));
}

function humanOutput(result) {
  const lines = [`mode=${result.mode} overall=${result.overall} writes=${result.writes}`];
  for (const item of result.checks) {
    lines.push(`${item.pass ? "PASS" : "FAIL"} ${item.id} ${item.title}`);
    lines.push(`  observed=${JSON.stringify(item.observed)}`);
    for (const evidence of item.evidence ?? []) lines.push(`  evidence: ${evidence}`);
  }
  return `${lines.join("\n")}\n`;
}

async function dryRun() {
  // 不重启生产进程时，活动 receipt/audit 必然仍是旧代码的历史证据。
  // dry 因而做零写入的“待部署代码”公共接口探针，同时把活动读数原样附上，绝不伪装成已部署。
  const [logText, receipt, auditText, serviceSource, pluginSource] = await Promise.all([
    readText(activeLog), readJson(activeReceipt), readText(activeAudit),
    readText(path.join(repoRoot, "app", "memory-lib", "src", "localhost-server.mjs")),
    readText(sourcePlugin),
  ]);
  const logs = logText.split(/\r?\n/u).filter(Boolean);
  const liveOk = parseJsonAfter([...logs].reverse().find((line) => line.includes("inject_ok ")) ?? "", "inject_ok");
  const liveRecall = [...auditRows(auditText)].reverse().find((row) => row.action === "recall_brief" && row.agent === "pilot-01" && row.role === "reader") ?? null;

  const ctx = await import(`${pathToFileURL(path.join(repoRoot, "scripts", "inject-context.mjs")).href}?dry=${Date.now()}`);
  const fixture = Array.from({ length: 8 }, (_, index) => `- [2026-10-28] 第${index + 1}条完整事实：${"蓝鲸".repeat(35)}。`).join("\n");
  const blocks = Array.from({ length: 20 }, () => ctx.buildInjectionBlock(fixture, 600));
  let sent = null;
  await ctx.fetchBrief({
    url: "http://dry.invalid/v1/recall/brief", credentialRef: "dry", secret: "dry", principal: { agent_id: "pilot-01", role_id: "reader" }, query: "蓝鲸", maxChars: 600,
    fetchImpl: async (_url, init) => { sent = init; return new Response(JSON.stringify({ ok: true, text: fixture, included: [] }), { status: 200 }); },
  });
  const lengths = blocks.map((block) => block.length);
  const lineCounts = blocks.map((block) => block.split(/\r?\n/u).slice(1).filter(Boolean).length);
  const i3Observed = {
    runs: 20, minChars: Math.min(...lengths), maxChars: Math.max(...lengths),
    items: lineCounts[0], itemCountsMatch: lineCounts.every((count) => count === lineCounts[0]),
    completeSentences: blocks.every(isCompleteSentenceBlock),
    liveBeforeRestart: { chars: Number(liveOk?.injectChars ?? receipt?.last?.chars ?? 0), items: Array.isArray(liveOk?.includedIds) ? liveOk.includedIds.length : 0 },
  };
  const declaredInject = sent?.headers?.["X-Memory-Channel"] === "inject";
  const serviceKeepsCompatibility = /requestedChannel === "inject" \? "inject" : "localhost"/u.test(serviceSource);
  const renderedAssertion = /block\.length > INJECT\.maxChars/u.test(pluginSource);
  const checks = [
    check("I3", "pending implementation: 20 complete rendered blocks stay within 600", renderedAssertion && i3Observed.maxChars <= 600 && i3Observed.itemCountsMatch && i3Observed.completeSentences, i3Observed, [sourcePlugin]),
    check("I6", "pending implementation declares inject while service defaults to localhost", declaredInject && serviceKeepsCompatibility, { requestHeader: sent?.headers?.["X-Memory-Channel"] ?? null, fallback: serviceKeepsCompatibility ? "localhost" : null, liveBeforeRestart: liveRecall ? { channel: liveRecall.channel, action: liveRecall.action } : null, deploymentPending: true }, [path.join(repoRoot, "scripts", "inject-context.mjs"), path.join(repoRoot, "app", "memory-lib", "src", "localhost-server.mjs")]),
  ];
  return { mode: "dry", writes: 0, deploymentPending: true, overall: checks.every((item) => item.pass) ? "PASS" : "NONCONFORMING", checks };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function bootPlugin({ pluginPath, workDir, briefUrl, credentialRef, secret, timeoutMs = 3000 }) {
  const previous = {};
  const env = {
    DSH_HOME: workDir,
    INPLUGIN1_WORK_DIR: workDir,
    MEMORY_LIB_URL: briefUrl.replace(/\/v1\/recall\/brief$/u, ""),
    MEMORY_LIB_CRED_REF: credentialRef,
    MEMORY_LIB_SECRET: secret,
    DSH_REFINE_ENABLED: "off",
    DSH_INJECT_ENABLED: "on",
    DSH_INJECT_BRIEF_URL: briefUrl,
    DSH_INJECT_RECEIPT: path.join(workDir, "inject-receipt.json"),
    DSH_INJECT_TIMEOUT_MS: String(timeoutMs),
    DSH_INJECT_THROTTLE_MS: "60000",
    DSH_INJECT_MAX_CHARS: "600",
  };
  for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
  const handlers = new Map();
  const sections = [];
  const disposers = [];
  const systemPrompt = { section(section) { sections.push(section); return () => sections.splice(sections.indexOf(section), 1); } };
  const ctx = {
    get(name) { return name === "systemPrompt" ? systemPrompt : undefined; },
    systemPrompt,
    on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
    effect(effect) { const disposer = effect(); if (typeof disposer === "function") disposers.push(disposer); },
  };
  const mod = await import(`${pathToFileURL(pluginPath).href}?verify=${Date.now()}-${Math.random()}`);
  mod.apply(ctx);
  const emit = (event, ...payload) => { for (const handler of handlers.get(event) ?? []) handler(...payload); };
  const assemble = async (sessionId) => {
    const initial = { sections: sections.map((section) => ({ name: section.name, text: section.text })), contexts: [], tools: [], variables: {} };
    const context = { agent: { session: { id: sessionId } } };
    const chain = async (index) => {
      const list = handlers.get("system-prompt/assemble") ?? [];
      return index >= list.length ? initial : list[index](initial, context, () => chain(index + 1));
    };
    const result = await chain(0);
    return result.sections.find((section) => section.name === "memory-lib:recall")?.text ?? "";
  };
  const ask = async (sessionId, text) => {
    emit("agent/inbox/inserted", { agent: { id: sessionId }, message: { source: { kind: "user" }, content: [{ type: "text", text }] } });
    emit("session/event", { id: sessionId, workspace: repoRoot }, { type: "turn/start", data: { turn: 1 } });
    return assemble(sessionId);
  };
  const close = () => {
    for (const disposer of disposers) { try { disposer(); } catch {} }
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
  return { ask, close, logFile: path.join(workDir, "realtime.log") };
}

async function agentRun() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verify-inject-"));
  const appRoot = path.join(repoRoot, "app", "memory-lib");
  const dataRoot = path.join(root, "memory");
  const registryPath = path.join(root, "identity.json");
  const secretsDir = path.join(root, "secrets");
  const auditPath = path.join(root, "audit.jsonl");
  const credentialRef = "memory-lib/verify-inject";
  const marker = `PRIVATE-INJECT-MARKER-${Date.now()}`;
  let adapter = null;
  let plugin = null;
  let deadPlugin = null;
  try {
    const identity = JSON.parse(await fs.readFile(path.join(appRoot, "runtime", "identity.json"), "utf8"));
    const framework = identity.frameworks[0];
    framework.credential_ref = credentialRef;
    framework.agents.push({ agent_id: "other-01", roles: [{ role_id: "writer", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get", "propose"] }] });
    await fs.writeFile(registryPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    const { rotateCredential } = await import(pathToFileURL(path.join(appRoot, "src", "identity-admin.mjs")).href);
    const { readSecret } = await import(pathToFileURL(path.join(appRoot, "src", "credential-resolver.mjs")).href);
    await rotateCredential({ secretsDir, credentialRef });
    const secretStore = { type: "file", dir: secretsDir };
    const secret = await readSecret(secretStore, credentialRef);
    const { createMemoryLib } = await import(pathToFileURL(path.join(appRoot, "src", "memory-lib.mjs")).href);
    const { createLocalhostServer } = await import(pathToFileURL(path.join(appRoot, "src", "localhost-server.mjs")).href);
    adapter = createLocalhostServer({
      libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: root, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
      registryPath, secretStore, auditPath, host: "127.0.0.1", port: 0,
    });
    const address = await adapter.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (route, principal, body) => {
      const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: credentialRef, secret, principal, ...body }) });
      return { status: response.status, body: await response.json() };
    };
    const admin = { agent_id: "admin-01", role_id: "librarian-admin" };
    const other = { agent_id: "other-01", role_id: "writer" };
    for (let index = 1; index <= 8; index += 1) {
      const fact = `蓝鲸校验事实第${index}条：这是用于把真实注入段推近六百字符预算的完整句子，内容保持相关并以句号结束，宁可少给也不应截出半句。`;
      const written = await call("/v1/write", admin, { layer: "curated-shared", visibility: "platform", id: `inject-visible-${index}`, body: fact, evidence_refs: [`verify:visible:${index}`] });
      if (written.status !== 200) throw new Error(`visible fixture write failed: ${written.status} ${JSON.stringify(written.body)}`);
    }
    const privateWrite = await call("/v1/write", other, { layer: "curated-shared", visibility: "private", id: "inject-private", body: `${marker} 蓝鲸校验私有事实。`, evidence_refs: ["verify:private"] });
    if (privateWrite.status !== 200) throw new Error(`private fixture write failed: ${privateWrite.status} ${JSON.stringify(privateWrite.body)}`);

    const pluginWork = path.join(root, "plugin");
    plugin = await bootPlugin({ pluginPath: sourcePlugin, workDir: pluginWork, briefUrl: `${base}/v1/recall/brief`, credentialRef, secret });
    const samples = [];
    for (let index = 1; index <= 20; index += 1) {
      const block = await plugin.ask(`verify-session-${index}`, "请回忆蓝鲸校验以前的事实。");
      samples.push({
        block,
        chars: block.length,
        bodyLines: block.split(/\r?\n/u).slice(1).filter((line) => line.trim()),
        complete: isCompleteSentenceBlock(block),
      });
    }
    const pluginLog = await readText(plugin.logFile);
    const okRecords = pluginLog.split(/\r?\n/u).filter((line) => line.includes("inject_ok ")).map((line) => parseJsonAfter(line, "inject_ok")).filter(Boolean);
    const firstBlock = samples[0].block;
    const charValues = samples.map((sample) => sample.chars);
    const itemCountsMatch = samples.every((sample, index) => sample.bodyLines.length === (okRecords[index]?.includedIds?.length ?? -1));
    const i3 = check("I3", "20 real DSH injections stay within whole-section budget", samples.length === 20 && Math.max(...charValues) <= 600 && Math.min(...charValues) > 0 && samples.every((sample) => sample.complete) && itemCountsMatch, {
      runs: samples.length,
      minChars: Math.min(...charValues),
      maxChars: Math.max(...charValues),
      minItems: Math.min(...samples.map((sample) => sample.bodyLines.length)),
      maxItems: Math.max(...samples.map((sample) => sample.bodyLines.length)),
      itemCountsMatch,
      completeSentences: samples.every((sample) => sample.complete),
      endsWithEllipsis: samples.some((sample) => /…\s*$/u.test(sample.block)),
    }, [plugin.logFile]);
    const occurrences = firstBlock.split(marker).length - 1;
    const i4 = check("I4", "other identity private marker is absent", occurrences === 0, { marker, grep: `${marker}: ${occurrences} occurrence(s)`, writer: "other-01/writer", reader: "pilot-01/reader" }, [privateWrite.body.path ?? "temporary private fixture"]);

    const deadPort = await freePort();
    const deadWork = path.join(root, "dead-plugin");
    deadPlugin = await bootPlugin({ pluginPath: sourcePlugin, workDir: deadWork, briefUrl: `http://127.0.0.1:${deadPort}/v1/recall/brief`, credentialRef, secret, timeoutMs: 800 });
    const deadBlock = await deadPlugin.ask("verify-dead-session", "请回忆蓝鲸校验以前的事实。");
    const deadLog = await readText(deadPlugin.logFile);
    const skipLine = deadLog.split(/\r?\n/u).find((line) => line.includes("inject_failed ") || line.includes("inject_skipped ")) ?? "";
    const i5 = check("I5", "dead port skips injection without fabricated content", deadBlock === "" && !deadBlock.includes(marker) && Boolean(skipLine), { deadPort, injectedChars: deadBlock.length, markerOccurrences: deadBlock.split(marker).length - 1, log: skipLine.replace(/^\S+\s/u, "") }, [deadPlugin.logFile]);

    const localhostControlResponse = await call("/v1/recall/brief", { agent_id: "pilot-01", role_id: "reader" }, { query: "蓝鲸校验", format: "prompt", memory_only: true });
    if (localhostControlResponse.status !== 200) throw new Error(`localhost control failed: ${localhostControlResponse.status}`);
    const rows = auditRows(await readText(auditPath));
    const related = rows.filter((row) => row.action === "recall_brief" && row.agent === "pilot-01" && row.role === "reader");
    const injectAudits = related.filter((row) => row.channel === "inject");
    const injectAudit = injectAudits[0] ?? null;
    const localhostControl = [...related].reverse().find((row) => row.channel === "localhost") ?? null;
    const { aggregateAgents } = await import(pathToFileURL(path.join(appRoot, "web", "console-agents.mjs")).href);
    const agents = aggregateAgents(rows);
    const readerRow = agents.rows.find((row) => row.agent === "pilot-01" && row.role === "reader") ?? null;
    const consoleHasInject = readerRow?.channels?.some((entry) => entry.channel === "inject") === true;
    const i6 = check("I6", "inject audit, localhost compatibility control, and Agents aggregation", injectAudits.length === 20 && Boolean(injectAudit && localhostControl && consoleHasInject), {
      injectAudit,
      localhostControl,
      injectAuditCount: injectAudits.length,
      rawInjectJson: injectAudit ? JSON.stringify(injectAudit) : null,
      agents: readerRow,
    }, [auditPath]);
    const checks = [i3, i4, i5, i6];
    return { mode: "agent:dsh", writes: 9, temporaryRoot: root, cleaned: true, overall: checks.every((item) => item.pass) ? "PASS" : "NONCONFORMING", checks };
  } finally {
    deadPlugin?.close();
    plugin?.close();
    if (adapter) await adapter.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const result = dry ? await dryRun() : await agentRun();
process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : humanOutput(result));
