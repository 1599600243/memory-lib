#!/usr/bin/env node
// smoke.mjs —— 端到端冒烟：装 → 起 → 写 → 搜 → 自检 → 停。
// 全部在临时目录完成（file secret store），不依赖外部服务。
// 用法: node scripts/smoke.mjs [--keep] [--port 18080]

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const portIdx = argv.indexOf("--port");
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 18080;

let child = null;
const log = (msg) => console.log(`  ${msg}`);
async function fail(msg) {
  try { child?.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 500));
  console.error(`\n❌ SMOKE FAIL: ${msg}`);
  process.exit(1);
}

async function waitHealth(base, deadlineMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-lib-smoke-"));
log(`工作区: ${ws}`);

log("① install --write（file secret store）");
try {
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "install.mjs"), "--write",
    "--data-root", ws, "--port", String(port), "--timezone", "UTC", "--secret-store", "file"],
  { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  await fail(`install 失败: ${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? e.message}`);
}

const deploy = JSON.parse(await fsp.readFile(path.join(ws, "runtime", "deploy.json"), "utf8"));
const identityPath = path.join(ws, "runtime", "identity.json");
const identity = JSON.parse(await fsp.readFile(identityPath, "utf8"));
const credentialRef = identity.frameworks[0].credential_ref;
const secretName = credentialRef.replace(/[^a-zA-Z0-9._-]+/g, "_");
const secret = (await fsp.readFile(path.join(ws, "runtime", "secrets", `${secretName}.secret`), "utf8")).trim();
if (!secret) await fail("读不到 secret");
log(`   port=${deploy.port} tz=${deploy.timezone} store=${deploy.secretStore}`);

// 默认身份只能读；真实部署者也要显式加写角色，smoke 照做
const agent = identity.frameworks[0].agents[0];
for (const r of agent.roles) r.group_id = "smoke";
if (!agent.roles.some((r) => r.role_id === "writer")) {
  agent.roles.push({
    role_id: "writer",
    group_id: "smoke",
    scopes: [{ layer: "memory", visibility: "shared", group_id: "smoke" }],
    actions: ["search", "get", "write", "propose"],
  });
  await fsp.writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}
log(`② 身份: ${agent.agent_id} / reader + writer`);

log("③ 启动服务");
child = spawn(process.execPath, [
  path.join(repoRoot, "app", "memory-lib", "server.mjs"),
  "--host", "127.0.0.1", "--port", String(deploy.port),
  "--data-root", deploy.dataRoot,
  "--workspace-root", deploy.workspaceRoot,
  "--registry", identityPath,
  "--secrets-dir", path.join(ws, "runtime", "secrets"),
  "--audit", path.join(ws, "runtime", "audit", "access.jsonl"),
  "--secret-store", "file", "--calendar-timezone", deploy.timezone, "--summary-index", "none",
], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

const base = `http://127.0.0.1:${deploy.port}`;
const health = await waitHealth(base);
if (!health) await fail(`服务未起来（30s）\n${serverLog.slice(-800)}`);
log(`   /v1/health → ${health.health}（service=${health.service}）`);

const call = async (route, body) => {
  const r = await fetch(`${base}${route}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: credentialRef, secret, ...body }),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const writer = { agent_id: agent.agent_id, role_id: "writer", group_id: "smoke" };
const reader = { agent_id: agent.agent_id, role_id: "reader", group_id: "smoke" };
const marker = `SMOKE-${Date.now()}`;
// ④ 自检（在写入之前跑，此时索引是干净的，期望 10/10 ok）
log("④ doctor（写入前）");
let doctorOut = "";
try {
  doctorOut = execFileSync(process.execPath, [path.join(repoRoot, "scripts", "doctor.mjs"), "--data-root", ws, "--port", String(deploy.port)], { cwd: repoRoot, encoding: "utf8" });
} catch (e) {
  doctorOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
const doctorTail = doctorOut.trim().split("\n").pop();
const doctorLines = doctorOut.split("\n");
const failLines = doctorLines.filter((l) => /FAIL\s+\d+\/10/.test(l));
// CI 机器通常没有 Ollama：第 4 项（服务健康/向量车道）会 FAIL，属已知环境差异，允许它单独存在。
const onlyVectorMissing = failLines.length === 1
  && /FAIL\s+4\/10/.test(failLines[0])
  && /vector|ollama|embedding/i.test(failLines[0]);
const doctorOk = /doctor: 10\/10 ok/.test(doctorOut) || (/doctor: 9\/10 ok/.test(doctorOut) && onlyVectorMissing);
if (onlyVectorMissing) log("   注：本机无向量模型（Ollama），第 4 项为已知环境性失败，其余全过");
for (const line of doctorOut.split("\n")) {
  if (/(FAIL|WARN)\s+\d+\/10/.test(line)) log(`   ${line.trim()}`);
}
log(`   ${doctorTail}`);
if (!doctorOk) await fail(`doctor 不是 10/10 ok（${doctorTail}）`);

// ⑤ 写
log(`⑤ 写入 marker=${marker}`);
const w = await call("/v1/write", { principal: writer, visibility: "shared", id: `smoke-${Date.now()}`, evidence_refs: ["smoke:manual-check"], body: `冒烟记忆：${marker} 这条必须能被自己搜到。` });
if (w.status !== 200) await fail(`写入 HTTP ${w.status}: ${JSON.stringify(w.data).slice(0, 300)}\n${serverLog.slice(-500)}`);
log(`   写入 OK（${w.data.created ? "created" : w.data.updated ? "updated" : "ok"}）`);

// ⑥ 搜
log("⑥ 检索");
await new Promise((r) => setTimeout(r, 800));
const s = await call("/v1/search", { principal: reader, query: marker, limit: 20 });
if (s.status !== 200) await fail(`检索 HTTP ${s.status}: ${JSON.stringify(s.data).slice(0, 300)}`);
const hits = s.data.results ?? s.data.items ?? [];
if (!hits.some((h) => JSON.stringify(h).includes(marker))) await fail(`写入的记忆搜不到（hits=${hits.length}）`);
log(`   命中 ${hits.length} 条，包含 marker ✅`);

child.kill();
child = null;
await new Promise((r) => setTimeout(r, 600));
if (keep) log(`   保留工作区: ${ws}`);
else await fsp.rm(ws, { recursive: true, force: true });

console.log("\n✅ SMOKE PASS：装 → 起 → 自检 → 写 → 搜 全通");

