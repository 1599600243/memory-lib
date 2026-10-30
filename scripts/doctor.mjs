#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appRoot = path.join(repoRoot, "app", "memory-lib");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node scripts/doctor.mjs [--json] [--data-root <dir>] [--port <port>]");
  process.exit(0);
}
const json = argv.includes("--json");
function value(flag, fallback) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; }
const requestedRoot = value("--data-root", path.join(repoRoot, "memory-data"));
const dataRoot = path.resolve(requestedRoot);
const configPath = path.join(dataRoot, "runtime", "deploy.json");
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function quote(input) { const text = String(input); return process.platform === "win32" ? `"${text.replaceAll('"', '""')}"` : `'${text.replaceAll("'", `'"'"'`)}'`; }
function installCommand(extra = "") { return `node ${quote(path.join(here, "install.mjs"))} --write --data-root ${quote(dataRoot)}${extra}`; }
function result(id, name, outcome, detail, fix) {
  const status = typeof outcome === "string" ? outcome : (outcome ? "ok" : "fail");
  return { id, name, status, detail, fix };
}
function writableByMode(stat) { return (stat.mode & 0o222) !== 0; }
async function canBind(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => resolve({ ok: false, error: error.code ?? error.message }));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve({ ok: true })));
  });
}
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_RETRY_DELAY_MS = 500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function health(port) {
  let last = { ok: false, warning: false, service: false, detail: "not attempted" };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const body = await response.json().catch(() => ({}));
      const service = response.ok && body.ok === true && body.service === "memory-lib";
      const ok = service && body.health === "healthy";
      const optionalVectorSetup = body.vector?.status === "stale"
        || (body.vector?.status === "down" && /^vector-lane down: embedding model missing \(bge-m3(?::[^)]*)?\)$/u.test(body.vector?.reason ?? ""));
      const warning = service && body.health === "degraded" && optionalVectorSetup && Number(body.index?.failed ?? 0) === 0;
      const vectorDetail = warning ? ` vector=${body.vector.status} reason=${body.vector.reason ?? "missing"}` : "";
      last = { ok, warning, service, detail: `HTTP ${response.status} service=${body.service ?? "missing"} health=${body.health ?? "missing"}${vectorDetail} attempt=${attempt}` };
      if (last.ok) return last;
    } catch (error) {
      last = { ok: false, warning: false, service: false, detail: `${error.cause?.code ?? error.name ?? error.message} attempt=${attempt}` };
    }
    if (attempt === 1) await wait(HEALTH_RETRY_DELAY_MS);
  }
  return last;
}
function credentialTarget(credentialRef) {
  return String(credentialRef).replace(/[^a-zA-Z0-9._-]+/g, "_");
}
function wincredReadable(credentialRef) {
  const target = credentialTarget(credentialRef);
  if (process.platform !== "win32") return { ok: false, detail: `store=wincred target=${target} unavailable-on-platform` };
  const helper = path.join(appRoot, "scripts", "wincred-read.ps1");
  const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Target", target], { encoding: "utf8", windowsHide: true });
  const secret = run.stdout.trim();
  return {
    ok: run.status === 0 && Boolean(secret),
    detail: run.status === 0 && secret
      ? `store=wincred target=${target} size=${Buffer.byteLength(secret, "utf8")}`
      : `store=wincred target=${target} ${run.stderr.trim() || run.stdout.trim() || `exit=${run.status}`}`,
  };
}

const checks = [];
const [major] = process.versions.node.split(".").map(Number);
const nodeOk = major >= 24 && typeof zlib.zstdDecompressSync === "function";
const nodeFix = process.platform === "win32" ? "winget install OpenJS.NodeJS.LTS" : "npx --yes n 24";
checks.push(result(1, "Node 与 zstd", nodeOk, `${process.version}; zstd=${typeof zlib.zstdDecompressSync === "function"}`, nodeFix));

const config = await readJson(configPath);
const memoryRoot = path.resolve(config?.dataRoot ?? path.join(dataRoot, "memory"));
let rootStat = null;
try { rootStat = await fs.stat(dataRoot); } catch {}
let rootAccess = false;
try { await fs.access(dataRoot, fsSync.constants.R_OK | fsSync.constants.W_OK); rootAccess = true; } catch {}
const rootOk = Boolean(rootStat?.isDirectory() && rootAccess && writableByMode(rootStat));
checks.push(result(2, "数据根存在且可写", rootOk, rootStat ? `path=${dataRoot}; writable=${rootOk}` : `missing=${dataRoot}`, installCommand(" --secret-store file")));

const port = Number(value("--port", config?.port ?? 8787));
const healthResult = await health(port);
const bind = await canBind(port);
const portOk = bind.ok || healthResult.service === true;
checks.push(result(3, "端口可用", portOk, bind.ok ? `127.0.0.1:${port} 可监听` : (healthResult.service ? `127.0.0.1:${port} 服务已在运行 (MemoryLib)` : `127.0.0.1:${port} 被非 MemoryLib 进程占用 (${bind.error})`), healthResult.service ? `node ${quote(path.join(here, "doctor.mjs"))} --data-root ${quote(dataRoot)}` : (process.platform === "win32" ? `netstat -ano | findstr :${port}` : `ss -ltnp 'sport = :${port}'`)));
const healthStatus = healthResult.ok ? "ok" : (healthResult.warning ? "warn" : "fail");
const healthFix = healthResult.warning
  ? "ollama pull bge-m3"
  : `node ${quote(path.join(appRoot, "server.mjs"))} --data-root ${quote(memoryRoot)} --workspace-root ${quote(dataRoot)} --registry ${quote(path.join(dataRoot, "runtime", "identity.json"))} --secrets-dir ${quote(path.join(dataRoot, "runtime", "secrets"))} --audit ${quote(path.join(dataRoot, "runtime", "audit", "access.jsonl"))} --port ${port} --calendar-timezone ${quote(config?.timezone ?? "Asia/Shanghai")} --secret-store ${config?.secretStore ?? "file"} --summary-index none`;
checks.push(result(4, "服务健康", healthStatus, `http://127.0.0.1:${port}/v1/health ${healthResult.detail}`, healthFix));

const identity = await readJson(path.join(dataRoot, "runtime", "identity.json"));
const credentialRef = identity?.frameworks?.[0]?.credential_ref;
const credentialStore = config?.secretStore;
let credential = { ok: false, detail: `store=${credentialStore ?? "missing"} identity-or-credential-ref-missing` };
if (credentialRef && credentialStore === "file") {
  const secretFile = path.join(dataRoot, "runtime", "secrets", `${credentialTarget(credentialRef)}.secret`);
  try {
    const secret = (await fs.readFile(secretFile, "utf8")).trim();
    credential = { ok: Boolean(secret), detail: secret ? `store=file path=${secretFile} size=${Buffer.byteLength(secret, "utf8")}` : `store=file path=${secretFile} empty` };
  } catch (error) {
    credential = { ok: false, detail: error.code === "ENOENT" ? `store=file path=${secretFile} missing` : `store=file path=${secretFile} ${error.code ?? error.message}` };
  }
} else if (credentialRef && credentialStore === "wincred") {
  credential = wincredReadable(credentialRef);
} else if (credentialRef) {
  credential = { ok: false, detail: `store=${credentialStore ?? "missing"} unsupported` };
}
checks.push(result(5, "凭据可读", credential.ok, credential.detail, installCommand(` --force --secret-store ${credentialStore ?? "file"}`)));

let timezoneOk = false;
try { new Intl.DateTimeFormat("en", { timeZone: config?.timezone }).format(); timezoneOk = typeof config?.timezone === "string"; } catch {}
checks.push(result(6, "IANA 时区", timezoneOk, `timezone=${config?.timezone ?? "missing"}`, installCommand(` --force --timezone Asia/Shanghai --secret-store ${config?.secretStore ?? "file"}`)));

const indexPath = path.join(memoryRoot, "indexes", "sqlite", "memory-lib-index.sqlite");
let indexOk = false, indexDetail = `missing=${indexPath}`;
try {
  const bytes = await fs.readFile(indexPath);
  // deserialize() cannot open a WAL-mode image without sidecars. Normalize only the
  // in-memory copy's SQLite header; the source index remains byte-for-byte untouched.
  if (bytes.length > 19) { bytes[18] = 1; bytes[19] = 1; }
  const db = new DatabaseSync(":memory:");
  db.deserialize(bytes);
  try {
    const required = ["files", "chunks", "embeddings", "index_meta", "fts_chunks"];
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name);
    const integrity = db.prepare("PRAGMA quick_check").get()?.quick_check;
    indexOk = required.every((name) => found.includes(name)) && integrity === "ok";
    indexDetail = `tables=${required.filter((name) => found.includes(name)).length}/5; quick_check=${integrity ?? "missing"}`;
  }
  finally { db.close(); }
} catch (error) { indexDetail = error.message; }
checks.push(result(7, "索引表可查", indexOk, indexDetail, `node ${quote(path.join(appRoot, "scripts", "index.mjs"))} --data-root ${quote(memoryRoot)}`));

const auditPath = path.join(dataRoot, "runtime", "audit", "access.jsonl");
let auditOk = false, auditDetail = `missing=${auditPath}`;
try { const stat = await fs.stat(auditPath); await fs.access(auditPath, fsSync.constants.R_OK | fsSync.constants.W_OK); auditOk = stat.isFile() && writableByMode(stat); auditDetail = `path=${auditPath}; writable=${auditOk}`; } catch {}
const auditFix = process.platform === "win32" ? `powershell -NoProfile -Command "(Get-Item -LiteralPath '${auditPath.replaceAll("'", "''")}').IsReadOnly = $false"` : `chmod u+rw ${quote(auditPath)}`;
checks.push(result(8, "审计文件可写", auditOk, auditDetail, auditFix));

const taskRequired = config?.withTasks === true;
const taskPath = path.join(dataRoot, "runtime", "task.json");
const task = await readJson(taskPath);
let taskRegistered = false;
if (taskRequired && task?.backend === "schtasks" && process.platform === "win32" && task.name) {
  taskRegistered = spawnSync("schtasks", ["/Query", "/TN", task.name], { stdio: "ignore", windowsHide: true }).status === 0;
} else if (taskRequired && task?.backend === "systemd-user" && process.platform !== "win32" && task.name) {
  taskRegistered = spawnSync("systemctl", ["--user", "is-enabled", task.name], { stdio: "ignore" }).status === 0;
}
const taskOk = !taskRequired || taskRegistered;
checks.push(result(9, "计划任务", taskOk, taskRequired ? `declared=true; backend=${task?.backend ?? "missing"}; name=${task?.name ?? "missing"}; registered=${taskRegistered}` : "未声明需要计划任务", installCommand(` --with-tasks --secret-store ${config?.secretStore ?? "file"}`)));

const relativeToRepo = path.relative(repoRoot, dataRoot);
const insideRepo = relativeToRepo !== "" && !relativeToRepo.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToRepo);
const gitWorktree = spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", windowsHide: true });
const isGitWorktree = gitWorktree.status === 0 && gitWorktree.stdout.trim() === "true";
const git = insideRepo && isGitWorktree ? spawnSync("git", ["-C", repoRoot, "ls-files", "--", relativeToRepo], { encoding: "utf8", windowsHide: true }) : null;
const untracked = !insideRepo || !isGitWorktree || (git?.status === 0 && !git.stdout.trim());
checks.push(result(10, "data 未被 Git 跟踪", untracked, untracked ? `not tracked: ${dataRoot}` : `tracked: ${dataRoot}`, `git -C ${quote(repoRoot)} rm -r --cached ${quote(dataRoot)} && echo ${quote(`${path.basename(dataRoot)}/`)} >> ${quote(path.join(repoRoot, ".gitignore"))}`));

const ok = checks.every((item) => item.status !== "fail");
const warningCount = checks.filter((item) => item.status === "warn").length;
const payload = { ok, dataRoot, port, checks };
if (json) console.log(JSON.stringify(payload, null, 2));
else {
  for (const check of checks) {
    const label = check.status === "ok" ? "ok" : (check.status === "warn" ? "WARN" : "FAIL");
    console.log(`${label} ${check.id}/10 ${check.name}: ${check.detail}`);
    console.log(`  fix: ${check.fix}`);
  }
  console.log(ok ? `doctor: 10/10 ok${warningCount ? ` (${warningCount} warning)` : ""}` : `doctor: ${checks.filter((item) => item.status === "ok").length}/10 ok`);
}
process.exitCode = ok ? 0 : 1;
