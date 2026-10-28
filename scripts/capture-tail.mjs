#!/usr/bin/env node
// Manifest-driven transcript capture with backwards-compatible directory flags.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1))), "..");
const DEFAULT_MANIFEST_DIR = path.join(ROOT, "data", "runtime", "agents");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback; };
const AGENT = arg("agent");
const MANIFEST_DIR = path.resolve(arg("manifest-dir", DEFAULT_MANIFEST_DIR));
const API = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const ONCE = flag("once");
const BACKFILL = flag("backfill");
const DRY = flag("dry-run");
const VERIFY = flag("verify");
const INTERVAL = Math.max(3, Number(arg("interval", 15)) || 15);
const SOURCE = String(arg("source", arg("format", "manual")));
const STATE = String(arg("state", path.join(ROOT, "state", `capture-tail-${AGENT ?? SOURCE}.json`)));
const LOG = path.join(path.dirname(STATE), `capture-tail-${AGENT ?? SOURCE}.log`);
const MAX_CHARS = 8000;

function printHelp() {
  console.log(`用法 / Usage:
  node scripts/capture-tail.mjs --agent <id> [--manifest-dir <dir>] [--once] [--backfill] [--verify] [--dry-run]
  node scripts/capture-tail.mjs --dir <path> [--dir <path>] [--format <format>] [--source <source>] [--once]

选项:
  --agent <id>          从 manifest 读取 transcript 配置
  --manifest-dir <dir>  manifest 目录；默认 data/runtime/agents
  --dir <path>          旧式 transcript 目录，可重复
  --format <format>     jsonl|jsonl-zst|json-object
  --source <source>     evidence source（旧式模式）
  --state <file>        字节偏移状态文件
  --interval <seconds>  守护轮询间隔，最小 3 秒
  --once                扫描一轮后退出
  --backfill            从 offset 0 扫描
  --verify              提交后读回 evidence；连续三轮不可解析时退出 1
  --dry-run             预览消息，不提交且不写偏移
  --help, -h            打印本用法，不读取 manifest、不进入守护`);
}

if (flag("help") || argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

function normalizePath(value) { return String(value).replaceAll("\\", "/").toLowerCase(); }
function rejectCoupledPath(value, label) { if (normalizePath(value).includes("data/memory")) throw new Error(`${label} 不得包含 data\\memory 耦合路径: ${value}`); }
function homePath(value) { const home = process.env.HOME || process.env.USERPROFILE || os.homedir(); return String(value).replace(/^~(?=$|[\\/])/u, home); }
function wildcardRegex(pattern) {
  const escaped = String(pattern).split("*").map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "iu");
}
function expandDirs(pattern) {
  const resolved = path.resolve(homePath(pattern));
  const parts = resolved.split(path.sep);
  const roots = [parts.shift() || path.parse(resolved).root];
  for (const part of parts) {
    const next = [];
    for (const root of roots) {
      if (!part.includes("*")) { next.push(path.join(root, part)); continue; }
      try { for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && wildcardRegex(part).test(entry.name)) next.push(path.join(root, entry.name)); } catch { /* missing sources are a valid discovered state */ }
    }
    roots.splice(0, roots.length, ...next);
  }
  return roots.filter((candidate) => { try { return fs.statSync(candidate).isDirectory(); } catch { return false; } });
}
function sourceFiles(source) {
  const re = wildcardRegex(source.glob ?? "*");
  return source.dirs.flatMap(expandDirs).flatMap((dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && re.test(entry.name)).map((entry) => path.join(dir, entry.name)); } catch { return []; }
  }).sort();
}
function text(value) { return typeof value === "string" ? value : Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : item?.text ?? "").join("\n") : ""; }
export function extractMessage(obj) {
  return extractMessages(obj)[0] ?? null;
}
function extractMessages(obj) {
  if (!obj || typeof obj !== "object") return [];
  const messages = [];
  const candidates = [obj, obj.message, obj.payload?.type === "message" ? obj.payload : null];
  if (!AGENT) candidates.push(obj.payload?.item, obj.payload?.data, obj.item, obj.data);
  for (const candidate of candidates) {
    if (!candidate || !["user", "assistant"].includes(candidate.role)) continue;
    const content = text(candidate.content ?? candidate.text).trim();
    if (content) messages.push({ role: candidate.role, content });
  }
  if (Array.isArray(obj.messages)) for (const item of obj.messages) messages.push(...extractMessages(item));
  return messages;
}
function parseContent(buffer, format) {
  if (format === "jsonl-zst") {
    if (typeof zlib.zstdDecompressSync !== "function") throw new Error("当前 Node 不提供 zstdDecompressSync，无法读取 jsonl-zst");
    buffer = zlib.zstdDecompressSync(buffer);
  }
  const raw = buffer.toString("utf8");
  if (format === "json-object") {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.messages) ? parsed.messages : [parsed];
    return items.flatMap(extractMessages);
  }
  const messages = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try { messages.push(...extractMessages(JSON.parse(line))); } catch { /* incomplete or non-message lines are ignored */ }
  }
  return messages;
}
function log(message) { const line = `${new Date().toISOString()} ${message}`; console.log(line); try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + "\n"); } catch {} }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } }
function saveState(value) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(value, null, 2) + "\n", "utf8"); }
function auth(write) {
  const ref = process.env.MEMORY_LIB_CRED_REF ?? write.credentialRef;
  const secret = process.env.MEMORY_LIB_SECRET ?? readWincredSecret(ref) ?? readLegacySecret();
  if (!ref || !secret) throw new Error("读不到 memory-lib 凭据；请把 credentialRef 对应 secret 放入 Windows Credential Manager，或设置 MEMORY_LIB_SECRET");
  return { credential_ref: ref, secret, principal: { agent_id: process.env.MEMORY_LIB_AGENT ?? write.agent, role_id: process.env.MEMORY_LIB_ROLE ?? write.role } };
}
function readWincredSecret(ref) {
  if (process.platform !== "win32" || !ref) return null;
  const helper = path.join(ROOT, "app", "memory-lib", "scripts", "wincred-read.ps1");
  try {
    const result = spawnSync("pwsh", ["-NoProfile", "-File", helper, "-Target", String(ref).replaceAll("/", "_")], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return null;
    const secret = result.stdout.trim();
    return secret && !secret.startsWith("WINCRED_READ_NOT_FOUND") ? secret : null;
  } catch { return null; }
}
function readLegacySecret() {
  const candidates = [path.join(ROOT, "app", "memory-lib", "scripts", "..", "..", "..", "..", "..", "..", "Users", "admin", ".dsh", "profiles", "web", "cordis.patch.yml"), "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml"];
  for (const file of candidates) {
    try { const y = fs.readFileSync(file, "utf8"); const secret = y.match(/X-MCP-Secret:\s*['\"]?([^'\"\r\n]+)/)?.[1]?.trim(); if (secret) return secret; } catch {}
  }
  return null;
}
async function readManifest(id) {
  const file = path.join(MANIFEST_DIR, `${id}.json`);
  const manifest = JSON.parse(await fsp.readFile(file, "utf8"));
  if (manifest.write?.mode !== "transcript") throw new Error(`${id} write.mode 不是 transcript`);
  rejectCoupledPath(file, "manifest");
  for (const [i, source] of (manifest.write.sources ?? []).entries()) { if (!Array.isArray(source.dirs) || !source.dirs.length) throw new Error(`write.sources[${i}].dirs 必须非空`); for (const dir of source.dirs) rejectCoupledPath(dir, `write.sources[${i}].dirs`); }
  return manifest;
}
function legacyConfig() {
  const dirs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--dir" && argv[i + 1]) dirs.push(argv[++i]);
  if (!dirs.length) throw new Error("需要 --agent <id> 或 --dir <transcript 目录>（可重复）");
  const format = String(arg("format", "jsonl"));
  return { id: SOURCE, write: { mode: "transcript", source: String(arg("source", SOURCE)), agent: process.env.MEMORY_LIB_AGENT ?? "pilot-01", role: process.env.MEMORY_LIB_ROLE ?? "capture-ingest", credentialRef: process.env.MEMORY_LIB_CRED_REF ?? "memory-lib/deepseek-harness", sources: [{ dirs, format: ["jsonl", "jsonl-zst", "json-object"].includes(format) ? format : "jsonl", glob: format === "jsonl-zst" ? "*.zst" : format === "json-object" ? "*.json" : "*.jsonl" }] } };
}
async function post(body) {
  const response = await fetch(`${API}/v1/conversations/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok && json.ok !== false, body: json };
}
async function verifyCapture(result, expectedSource) {
  const evidencePath = result?.body?.data?.evidencePath ?? result?.body?.evidencePath;
  if (!evidencePath) throw new Error(`提交成功但响应没有 evidencePath: ${JSON.stringify(result.body).slice(0, 240)}`);
  const evidence = await fsp.readFile(evidencePath, "utf8");
  const source = evidence.match(/^source:\s*["']?([^"'\r\n]+)["']?\s*$/mu)?.[1]?.trim();
  if (source !== expectedSource) throw new Error(`evidence source=${source ?? "<missing>"}，期望 ${expectedSource}`);
  console.log(`evidence: ${evidencePath} source=${source}`);
  return evidencePath;
}
async function writeManifestUpdate(update) {
  if (!AGENT) return;
  const file = path.join(MANIFEST_DIR, `${AGENT}.json`);
  const current = JSON.parse(await fsp.readFile(file, "utf8"));
  update(current);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temp, JSON.stringify(current, null, 2) + "\n", "utf8");
  await fsp.rename(temp, file);
}
async function noteUnparsable(file) {
  await writeManifestUpdate((current) => { current.notes = `unparsable:${file}`; });
}
async function pass(manifest, state) {
  const credential = DRY ? null : auth(manifest.write);
  let files = 0, messages = 0, posted = 0, failed = 0, verified = 0;
  for (const source of manifest.write.sources) {
    for (const file of sourceFiles(source)) {
      files++;
      const size = fs.statSync(file).size;
      const rec = state[file] ?? { offset: size, conversationId: path.basename(file).replace(/\.[^.]+$/u, "") };
      if (BACKFILL) rec.offset = 0;
      if (size < rec.offset) rec.offset = 0;
      if (size === rec.offset) { state[file] = rec; continue; }
      const start = rec.offset;
      const buffer = fs.readFileSync(file).subarray(start);
      let batch = [];
      try { batch = parseContent(buffer, source.format).map((message) => ({ ...message, content: message.content.slice(0, MAX_CHARS) })); } catch { /* handled as unparsable below */ }
      const end = size;
      if (!batch.length && buffer.length > 0) {
        log(`WARN unparsable ${file} @offset=${start}`);
        if (!DRY) {
          rec.unparsableRounds = (rec.unparsableRounds ?? 0) + 1;
          state[file] = rec;
          saveState(state);
          if (rec.unparsableRounds >= 3) {
            await noteUnparsable(file);
            if (VERIFY) failed++;
          }
        }
        continue;
      }
      if (batch.length) {
        delete rec.unparsableRounds;
        messages += batch.length;
        const event = { ...credential, source: manifest.write.source, conversation_id: rec.conversationId, event_id: `${rec.conversationId}:${start}-${end}`, session_id: rec.conversationId, workspace: path.dirname(file), messages: batch };
        if (DRY) log(`[dry] ${manifest.id} ${file} +${batch.length} 条（偏移保持 ${start}）`);
        else {
          try {
            const result = await post(event);
            if (!result.ok) { failed++; log(`POST 失败 ${result.status}: ${JSON.stringify(result.body).slice(0, 240)}`); }
            else { posted++; if (VERIFY) { await verifyCapture(result, manifest.write.source); verified++; } }
          } catch (error) { failed++; log(`POST/verify 异常: ${error.message}`); }
        }
      }
      if (!DRY) { rec.offset = end; state[file] = rec; saveState(state); }
    }
  }
  return { files, messages, posted, failed, verified };
}
async function promoteVerified(manifest) {
  const previous = manifest.state;
  await writeManifestUpdate((current) => {
    if (current.state === "discovered") current.state = "verified";
    manifest.state = current.state;
  });
  log(`manifest state: ${previous} → ${manifest.state}`);
}

const manifest = AGENT ? await readManifest(AGENT) : legacyConfig();
if (AGENT && !ONCE && manifest.state !== "enabled") throw new Error(`${AGENT} state=${manifest.state}；持续托管只运行 enabled，验证请使用 --once`);
const state = loadState();
log(`启动：${AGENT ? `agent=${AGENT}` : `source=${manifest.write.source}`} sources=${manifest.write.sources.length} backfill=${BACKFILL} dry=${DRY} verify=${VERIFY}`);
if (ONCE) {
  const result = await pass(manifest, state);
  log(`完成：扫 ${result.files} 文件，抽出 ${result.messages} 条消息，提交 ${result.posted} 次，验证 ${result.verified} 次，失败 ${result.failed}`);
  if (!DRY && VERIFY && result.verified > 0 && AGENT) await promoteVerified(manifest);
  process.exitCode = result.failed ? 1 : 0;
} else {
  for (;;) { try { const result = await pass(manifest, state); if (result.messages) log(`本轮：${result.messages} 条消息，提交 ${result.posted}，失败 ${result.failed}`); } catch (error) { log(`本轮异常: ${error.message}`); } await new Promise((resolve) => setTimeout(resolve, INTERVAL * 1000)); }
}
