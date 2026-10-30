#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";

const gzip = promisify(zlib.gzip);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appRoot = path.join(repoRoot, "app", "memory-lib");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function value(flag, fallback) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; }
function fail(message) { console.error(`ERROR ${message}`); process.exit(1); }
function q(input) { const text = String(input); return process.platform === "win32" ? `"${text.replaceAll('"', '""')}"` : `'${text.replaceAll("'", `'"'"'`)}'`; }

if (has("--version")) {
  const pkg = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  console.log(JSON.stringify({ serviceVersion: pkg.version, manifestSpecVersion: 1, apiVersion: "v1" }));
  process.exit(0);
}
if (has("--help") || has("-h")) {
  console.log("Usage: node scripts/install.mjs [--dry-run|--write] [--data-root <dir>] [--port 8787] [--timezone Asia/Shanghai] [--secret-store wincred|file] [--with-tasks] [--force]");
  process.exit(0);
}
if (has("--dry-run") && has("--write")) fail("--dry-run 与 --write 不能同时使用");
const write = has("--write");
const dataRoot = path.resolve(value("--data-root", path.join(repoRoot, "memory-data")));
const port = Number(value("--port", "8787"));
const timezone = value("--timezone", "Asia/Shanghai");
const secretStore = value("--secret-store", process.platform === "win32" ? "wincred" : "file");
const withTasks = has("--with-tasks");
const force = has("--force");
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`端口无效: ${port}`);
if (!['file', 'wincred'].includes(secretStore)) fail(`--secret-store 只支持 wincred|file: ${secretStore}`);
try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { fail(`IANA 时区无效: ${timezone}`); }
const [major] = process.versions.node.split(".").map(Number);
if (major < 24 || typeof zlib.zstdDecompressSync !== "function") fail(`需要 Node >=24 且支持 zstd，当前 ${process.version}`);
if (secretStore === "wincred" && process.platform !== "win32") fail("wincred 仅支持 Windows；请用 --secret-store file");

const memoryRoot = path.join(dataRoot, "memory");
const runtime = path.join(dataRoot, "runtime");
const configPath = path.join(runtime, "deploy.json");
const identityPath = path.join(runtime, "identity.json");
const secretsDir = path.join(runtime, "secrets");
const auditPath = path.join(runtime, "audit", "access.jsonl");
const indexPath = path.join(memoryRoot, "indexes", "sqlite", "memory-lib-index.sqlite");
const credentialRef = "memory-lib/local";
const secretFile = path.join(secretsDir, "memory-lib_local.secret");
const taskKey = crypto.createHash("sha256").update(dataRoot).digest("hex").slice(0, 12);
const taskBackend = process.platform === "win32" ? "schtasks" : "systemd-user";
const taskName = process.platform === "win32" ? `MemoryLib-${taskKey}` : `memory-lib-${taskKey}.service`;
const taskDescriptorPath = path.join(runtime, "task.json");
const taskTarget = process.platform === "win32" ? taskName : path.join(os.homedir(), ".config", "systemd", "user", taskName);
const desiredConfig = { version: 1, workspaceRoot: dataRoot, dataRoot: memoryRoot, port, timezone, secretStore, withTasks };
const folders = ["memory/curated/shared", "memory/curated/agents", "memory/project-state", "memory/tools-memory", "memory/plans", "memory/profile", "memory/evidence/documents", "memory/evidence/conversations", "memory/indexes/sqlite", "recovery/policies", "recovery/plans", "runtime/audit", "runtime/secrets"];

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function entries(dir) { try { return await fs.readdir(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function snapshot(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ path: path.relative(root, full).split(path.sep).join("/"), content: (await fs.readFile(full)).toString("base64") });
    }
  }
  await walk(root);
  return files;
}
async function backup(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${root}.backup-${stamp}.json.gz`;
  const payload = JSON.stringify({ format: "memory-lib-backup-v1", source: root, createdAt: new Date().toISOString(), files: await snapshot(root) });
  await fs.writeFile(target, await gzip(payload));
  return target;
}
function identity() {
  return { version: 1, frameworks: [{ framework_id: "local", credential_ref: credentialRef, credential: { status: "active", revoked_at: null }, agents: [{ agent_id: "local-01", roles: [{ role_id: "reader", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get"] }] }] }] };
}
async function writeWincred(secret) {
  const helper = path.join(appRoot, "scripts", "wincred-write.ps1");
  await new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Target", "memory-lib_local"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`wincred 写入失败: ${stderr.trim() || `exit ${code}`}`)));
    child.stdin.end(secret);
  });
}
async function taskRegistered() {
  if (!withTasks) return true;
  if (process.platform === "win32") {
    return spawnSync("schtasks", ["/Query", "/TN", taskName], { stdio: "ignore", windowsHide: true }).status === 0;
  }
  return spawnSync("systemctl", ["--user", "is-enabled", taskName], { stdio: "ignore" }).status === 0;
}
function commandArgs() {
  return [path.join(appRoot, "server.mjs"), "--data-root", memoryRoot, "--workspace-root", dataRoot, "--registry", identityPath, "--secrets-dir", secretsDir, "--audit", auditPath, "--port", String(port), "--calendar-timezone", timezone, "--secret-store", secretStore, "--summary-index", "none"];
}
function commandLine() { return [process.execPath, ...commandArgs()].map(q).join(" "); }
async function registerTask() {
  if (process.platform === "win32") {
    const wrapper = path.join(runtime, "start-memory-lib.cmd");
    await fs.writeFile(wrapper, `@echo off\r\n${commandLine()}\r\n`, "utf8");
    const created = spawnSync("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", taskName, "/TR", `"${wrapper}"`], { encoding: "utf8", windowsHide: true });
    if (created.status !== 0) fail(`计划任务创建失败: ${created.stderr?.trim() || created.stdout?.trim() || `exit ${created.status}`}`);
    return { version: 1, backend: taskBackend, name: taskName, target: wrapper, command: process.execPath, args: commandArgs() };
  }
  const unitDir = path.dirname(taskTarget);
  await fs.mkdir(unitDir, { recursive: true });
  const escaped = (text) => `"${String(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const unit = `[Unit]\nDescription=MemoryLib local service\n\n[Service]\nType=simple\nExecStart=${[process.execPath, ...commandArgs()].map(escaped).join(" ")}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
  await fs.writeFile(taskTarget, unit, "utf8");
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", taskName]]) {
    const result = spawnSync("systemctl", args, { encoding: "utf8" });
    if (result.status !== 0) fail(`systemd 用户任务创建失败: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`);
  }
  return { version: 1, backend: taskBackend, name: taskName, target: taskTarget, command: process.execPath, args: commandArgs() };
}
function initIndex(file) {
  const db = new DatabaseSync(file);
  try { db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,mtime REAL NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY,file_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,heading TEXT,text TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,token_estimate INTEGER NOT NULL,content_hash TEXT NOT NULL,UNIQUE(file_id,chunk_index));
    CREATE TABLE IF NOT EXISTS embeddings (chunk_id TEXT PRIMARY KEY,backend TEXT NOT NULL,model TEXT NOT NULL,dimension INTEGER NOT NULL,vector_blob BLOB,content_hash TEXT NOT NULL,vector_status TEXT NOT NULL,indexed_at TEXT,stale_reason TEXT);
    CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(chunk_id UNINDEXED,path UNINDEXED,heading,text, tokenize="trigram");
    INSERT OR REPLACE INTO index_meta(key,value) VALUES('schema','deploy-1');`); }
  finally { db.close(); }
}

const existingEntries = await entries(dataRoot);
const existingConfig = await readJson(configPath);
const managedSame = existingConfig && JSON.stringify(existingConfig) === JSON.stringify(desiredConfig);
const requiredFiles = [identityPath, auditPath, indexPath, ...(secretStore === "file" ? [secretFile] : []), ...(withTasks ? [taskDescriptorPath] : [])];
const registeredTask = await taskRegistered();
const complete = managedSame && (await Promise.all(requiredFiles.map(exists))).every(Boolean) && registeredTask;
if (!write) {
  console.log(`DRY-RUN data-root=${dataRoot}`);
  console.log(`1 node-check action=check target=${process.execPath} exists=true version=${process.version}`);
  console.log(`2 skeleton action=${existingEntries.length ? (managedSame ? "no-op" : "refuse-unless-force") : "create"} target=${dataRoot} exists=${existingEntries.length > 0}`);
  console.log(`3 identity action=${await exists(identityPath) ? "no-op" : "create"} target=${identityPath} exists=${await exists(identityPath)}`);
  console.log(`4 credential action=${secretStore === "file" && await exists(secretFile) ? "no-op" : "create"} target=${secretStore === "file" ? secretFile : "wincred:memory-lib_local"} exists=${secretStore === "file" ? await exists(secretFile) : "unknown"}`);
  console.log(`5 config action=${managedSame ? "no-op" : "write"} target=${configPath} exists=${await exists(configPath)}`);
  console.log(`6 tasks action=${withTasks ? (registeredTask ? "no-op" : "create") : "skip"} target=${withTasks ? taskTarget : taskDescriptorPath} exists=${withTasks ? registeredTask : await exists(taskDescriptorPath)}`);
  console.log(`7 next action=print target=${path.join(here, "doctor.mjs")} exists=${await exists(path.join(here, "doctor.mjs"))}`);
  process.exit(0);
}
if (existingEntries.length && !managedSame && !force) fail(`目标数据根非空，拒绝修改：${dataRoot}（确认后用 --force，执行前会备份）`);
let backupPath = null;
if (existingEntries.length && force) {
  backupPath = await backup(dataRoot);
  console.log(`backup=${backupPath}`);
}
if (complete && !force) {
  console.log(`no-op data-root=${dataRoot}`);
  console.log(`next-index: node ${q(path.join(appRoot, "scripts", "index.mjs"))} --data-root ${q(memoryRoot)}`);
  console.log(`next-start: node ${q(path.join(appRoot, "server.mjs"))} --data-root ${q(memoryRoot)} --workspace-root ${q(dataRoot)} --registry ${q(identityPath)} --secrets-dir ${q(secretsDir)} --audit ${q(auditPath)} --port ${port} --calendar-timezone ${q(timezone)} --secret-store ${secretStore} --summary-index none`);
  console.log(`next-doctor: node ${q(path.join(here, "doctor.mjs"))} --data-root ${q(dataRoot)}`);
  process.exit(0);
}
await fs.mkdir(dataRoot, { recursive: true });
for (const folder of folders) await fs.mkdir(path.join(dataRoot, ...folder.split("/")), { recursive: true });
const bootstrapDocument = path.join(memoryRoot, "evidence", "documents", "memory-lib-installation.md");
if (!await exists(bootstrapDocument)) await fs.writeFile(bootstrapDocument, "# MemoryLib installation\n\nThe local MemoryLib data root was initialized successfully.\n", "utf8");
if (force || !await exists(identityPath)) await fs.writeFile(identityPath, `${JSON.stringify(identity(), null, 2)}\n`, "utf8");
let secret = null;
if (secretStore === "file") {
  if (force || !await exists(secretFile)) await fs.writeFile(secretFile, `${crypto.randomBytes(48).toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
} else {
  secret = crypto.randomBytes(32).toString("base64url");
  await writeWincred(secret);
}
if (!await exists(auditPath)) await fs.writeFile(auditPath, "", "utf8");
if (!await exists(indexPath)) initIndex(indexPath);
await fs.writeFile(configPath, `${JSON.stringify(desiredConfig, null, 2)}\n`, "utf8");
if (withTasks) {
  const task = await registerTask();
  await fs.writeFile(taskDescriptorPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
}
console.log(`installed data-root=${dataRoot}${backupPath ? ` backup=${backupPath}` : ""}`);
console.log(`next-index: node ${q(path.join(appRoot, "scripts", "index.mjs"))} --data-root ${q(memoryRoot)}`);
console.log(`next-start: node ${q(path.join(appRoot, "server.mjs"))} --data-root ${q(memoryRoot)} --workspace-root ${q(dataRoot)} --registry ${q(identityPath)} --secrets-dir ${q(secretsDir)} --audit ${q(auditPath)} --port ${port} --calendar-timezone ${q(timezone)} --secret-store ${secretStore} --summary-index none`);
console.log(`next-doctor: node ${q(path.join(here, "doctor.mjs"))} --data-root ${q(dataRoot)}`);
