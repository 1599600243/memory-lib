#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1))), "..");
const DEFAULT_MANIFEST_DIR = path.join(ROOT, "data", "runtime", "agents");
const FORMATS = new Set(["jsonl", "jsonl-zst", "json-object"]);
const STATES = new Set(["discovered", "verified", "enabled", "disabled"]);
const MODES = new Set(["mcp", "http", "none"]);
const WRITE_MODES = new Set(["transcript", "hook", "none"]);
const INJECTS = new Set(["native", "brief-on-demand"]);
const APPLY_KINDS = new Set(["config", "cli", "manual"]);
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback; };
const manifestDir = path.resolve(value("manifest-dir", DEFAULT_MANIFEST_DIR));
const agentId = value("agent");

function printHelp() {
  console.log(`用法 / Usage:
  node scripts/agent-discover.mjs --agent <id> [--manifest-dir <dir>] [--write]
  node scripts/agent-discover.mjs --validate [--manifest-dir <dir>]
  node scripts/agent-discover.mjs --agent <id> [--manifest-dir <dir>] --enable|--disable

选项:
  --agent <id>          只探测或变更一个 agent：codex|claude-code|openclaw|dsh|cursor
  --manifest-dir <dir>  manifest 目录；默认 data/runtime/agents
  --validate            校验全部 manifest；同步 read.configPathVerified，路径不存在时 WARN
  --write               写入探测得到的 manifest；保留已有 verified/enabled/disabled 状态
  --enable              将已 verified 的 manifest 改为 enabled
  --disable             将现有 manifest 改为 disabled
  --help, -h            打印本用法，不执行探测

示例:
  node scripts/agent-discover.mjs --agent openclaw
  node scripts/agent-discover.mjs --agent openclaw --write
  node scripts/agent-discover.mjs --validate

规范: docs/AGENT-SPEC.md
接入指引: memory-onboard skill（C:/Users/admin/.dsh/skills/memory-onboard/SKILL.md）`);
}

if (argv.length === 0 || has("help") || argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const CANDIDATES = {
  codex: { displayName: "Codex", dirs: ["~/.codex/sessions"], format: "jsonl", glob: "*.jsonl", configPath: "~/.codex/config.toml", configFormat: "toml", keyPath: "mcp_servers.memory", recommendedApply: { kind: "config" } },
  "claude-code": { displayName: "Claude Code", dirs: ["~/.claude/projects"], format: "jsonl", glob: "*.jsonl", configPath: "~/.claude.json", alternateConfigPaths: ["~/.claude/settings.json"], configFormat: "json", keyPath: "mcpServers", recommendedApply: { kind: "config" } },
  openclaw: { displayName: "OpenClaw", dirs: ["~/.openclaw/agents/*/sessions"], format: "jsonl-zst", glob: "*.jsonl*", configPath: "~/.openclaw/openclaw.json", configFormat: "json", keyPath: "mcp.servers", recommendedApply: { kind: "cli", command: "openclaw mcp add memory --command \"<node>\" --arg \"<launcher>\" --env MCP_MEMORY_URL=http://127.0.0.1:8787 --env MCP_MEMORY_CRED_REF=<ref> --env MCP_MEMORY_AGENT=<agent> --env MCP_MEMORY_ROLE=<role>", verifyCommand: "openclaw mcp list" } },
  dsh: { displayName: "DSH", dirs: [], format: "jsonl", glob: "*.jsonl", writeMode: "none", configPath: "~/.dsh/profiles/web/cordis.patch.yml", configFormat: "yaml", keyPath: "mcp.memory", recommendedApply: { kind: "config" } },
  cursor: { displayName: "Cursor", dirs: ["~/.cursor/projects"], format: "jsonl", glob: "*.jsonl", configPath: "~/.cursor/config.json", configFormat: "json", keyPath: "mcpServers", recommendedApply: { kind: "config" } },
};

function homePath(input) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return input.replace(/^~(?=$|[\\/])/u, home);
}
function configPathExists(configPath) {
  try { return fs.statSync(homePath(configPath)).isFile(); } catch { return false; }
}
function executableExists(command) {
  const bin = String(command ?? "").trim().split(/\s+/u)[0];
  if (!bin) return false;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(dir.replace(/^"|"$/gu, ""), process.platform === "win32" && path.extname(bin) ? bin : `${bin}${extension.toLowerCase()}`);
      try { if (fs.statSync(file).isFile()) return true; } catch { /* equivalent to where: keep searching PATH */ }
    }
  }
  return false;
}
function jsonHasPath(value, dotted) {
  return dotted.split(".").every((key) => ((value = value?.[key]) !== undefined));
}
function configHasKnownKey(configPath, candidate) {
  const file = homePath(configPath);
  if (!configPathExists(configPath)) return false;
  try {
    const content = fs.readFileSync(file, "utf8");
    if (candidate.configFormat === "json") return jsonHasPath(JSON.parse(content), candidate.keyPath);
    if (candidate.configFormat === "toml") return /^\s*\[mcp_servers\.memory\]\s*$/mu.test(content);
    if (candidate.configFormat === "yaml") {
      const mcpBlock = content.match(/^mcp:\s*(?:#.*)?$((?:\r?\n(?: {2,}.*|\s*))*)/mu)?.[1] ?? "";
      return /^  memory:\s*/mu.test(mcpBlock);
    }
  } catch { return false; }
  return false;
}
const INFERRED_FROM = "AGENT-SPEC §9.2 hint table";
function inferredApply(apply) { return { ...apply, inferred: true, inferredFrom: INFERRED_FROM }; }
function detectApply(candidate) {
  if (candidate.recommendedApply.kind === "cli" && executableExists(candidate.recommendedApply.command)) {
    return { configPath: candidate.configPath, configPathVerified: configHasKnownKey(candidate.configPath, candidate), apply: inferredApply(candidate.recommendedApply) };
  }
  for (const configPath of [candidate.configPath, ...(candidate.alternateConfigPaths ?? [])]) {
    if (configHasKnownKey(configPath, candidate)) {
      const suffix = `.${candidate.keyPath.split(".").at(-1)}`;
      const keyPath = candidate.keyPath.endsWith(suffix) ? candidate.keyPath.slice(0, -suffix.length) : candidate.keyPath;
      return { configPath, configPathVerified: true, apply: inferredApply({ kind: "config", keyPath }) };
    }
  }
  return { configPath: candidate.configPath, configPathVerified: false, apply: inferredApply({ kind: "manual" }) };
}
function escapeRegExp(value) { return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"); }
function configHasDeclaredKey(read, candidate) {
  if (!configPathExists(read.configPath)) return false;
  const keyPath = read.apply?.keyPath;
  if (!keyPath) return candidate ? configHasKnownKey(read.configPath, candidate) : true;
  try {
    const file = homePath(read.configPath);
    const content = fs.readFileSync(file, "utf8");
    const extension = path.extname(file).toLowerCase();
    if (extension === ".json") return jsonHasPath(JSON.parse(content), `${keyPath}.${read.server}`);
    if (extension === ".toml") return new RegExp(`^\\s*\\[${escapeRegExp(keyPath)}\\.${escapeRegExp(read.server)}\\]\\s*$`, "mu").test(content);
    if (extension === ".yml" || extension === ".yaml") {
      const top = escapeRegExp(keyPath);
      const server = escapeRegExp(read.server);
      const block = content.match(new RegExp(`^${top}:\\s*(?:#.*)?$((?:\\r?\\n(?: {2,}.*|\\s*))*)`, "mu"))?.[1] ?? "";
      return new RegExp(`^  ${server}:\\s*`, "mu").test(block);
    }
  } catch { return false; }
  return false;
}
function normalizePath(value) { return String(value).replaceAll("\\", "/").toLowerCase(); }
function assertNoMemoryRoot(value, label) {
  if (normalizePath(value).includes("data/memory")) throw new Error(`${label} 不得包含 data\\memory 耦合路径: ${value}`);
}
function text(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => typeof item === "string" ? item : item?.text ?? "").join("\n");
}
export function extractMessage(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [obj, obj.message, obj.payload?.type === "message" ? obj.payload : null];
  for (const candidate of candidates) {
    if (!candidate || (candidate.role !== "user" && candidate.role !== "assistant")) continue;
    const content = text(candidate.content ?? candidate.text).trim();
    if (content) return { role: candidate.role, content };
  }
  if (Array.isArray(obj.messages)) {
    const messages = obj.messages.map(extractMessage).filter(Boolean);
    if (messages.length) return messages[0];
  }
  return null;
}
function decompress(buffer) {
  if (typeof zlib.zstdDecompressSync !== "function") throw new Error("当前 Node 不提供 zstdDecompressSync，无法读取 jsonl-zst");
  return zlib.zstdDecompressSync(buffer).toString("utf8");
}
function readSample(file, format) {
  const raw = fs.readFileSync(file);
  const source = format === "jsonl-zst" ? decompress(raw) : raw.toString("utf8");
  if (format === "json-object") {
    const value = JSON.parse(source);
    if (Array.isArray(value?.messages)) return value.messages.map(extractMessage).find(Boolean) ?? null;
    return extractMessage(value);
  }
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try { const message = extractMessage(JSON.parse(line)); if (message) return message; } catch { /* keep scanning */ }
  }
  return null;
}
function wildcardRegex(pattern) {
  const escaped = String(pattern).split("*").map((part) => part.replace(/[-/\\^$+?.()|[\]{}]/gu, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "iu");
}
function expandDir(pattern) {
  const resolved = homePath(pattern);
  const parts = path.resolve(resolved).split(path.sep);
  const roots = [parts.shift() || path.parse(path.resolve(resolved)).root];
  for (const part of parts) {
    const next = [];
    for (const root of roots) {
      if (!part.includes("*")) { next.push(path.join(root, part)); continue; }
      try { for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && wildcardRegex(part).test(entry.name)) next.push(path.join(root, entry.name)); } catch { /* missing is a discovery result */ }
    }
    roots.splice(0, roots.length, ...next);
  }
  return roots.filter((candidate) => { try { return fs.statSync(candidate).isDirectory(); } catch { return false; } });
}
function filesIn(dirs, glob) {
  const re = wildcardRegex(glob);
  const result = [];
  for (const dir of dirs) {
    try { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isFile() && re.test(entry.name)) result.push(path.join(dir, entry.name)); } catch { /* absent */ }
  }
  return result.sort();
}
const FORBIDDEN_SECRET_KEYS = new Set(["secret", "password", "token", "apikey", "api_key", "bearer"]);
function findForbiddenSecretKeys(value, at, errors) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenSecretKeys(item, `${at}[${index}]`, errors));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const field = `${at}.${key}`;
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) errors.push(`${field} 禁止出现明文密钥字段；请使用 credentialRef`);
    findForbiddenSecretKeys(child, field, errors);
  }
}
function validateManifest(manifest, label = "manifest") {
  const errors = [];
  const requiredString = (obj, key, at) => { if (typeof obj?.[key] !== "string" || !obj[key]) errors.push(`${at}.${key} 必须是非空字符串`); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [`${label} 必须是对象`];
  findForbiddenSecretKeys(manifest, label, errors);
  if (manifest.specVersion !== 1) errors.push(`${label}.specVersion 必须是 1`);
  requiredString(manifest, "id", label); requiredString(manifest, "displayName", label);
  if (typeof manifest.id === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id)) errors.push(`${label}.id 必须匹配 kebab-case：^[a-z0-9]+(-[a-z0-9]+)*$`);
  if (!MODES.has(manifest.read?.mode)) errors.push(`${label}.read.mode 必须是 mcp|http|none`);
  if (manifest.read?.mode === "mcp" || manifest.read?.mode === "http") {
    for (const key of ["server", "configPath", "credentialRef", "agent", "role"]) requiredString(manifest.read, key, `${label}.read`);
    if (manifest.read.apply !== undefined) {
      if (!APPLY_KINDS.has(manifest.read.apply?.kind)) errors.push(`${label}.read.apply.kind 必须是 config|cli|manual`);
      if (manifest.read.apply?.kind === "cli") {
        requiredString(manifest.read.apply, "command", `${label}.read.apply`);
        requiredString(manifest.read.apply, "verifyCommand", `${label}.read.apply`);
      }
      if (manifest.read.apply?.kind === "config" && manifest.read.apply.keyPath !== undefined) requiredString(manifest.read.apply, "keyPath", `${label}.read.apply`);
      if (manifest.read.apply?.kind === "manual" && (manifest.read.apply.command !== undefined || manifest.read.apply.verifyCommand !== undefined)) errors.push(`${label}.read.apply.kind=manual 时不要提供 command/verifyCommand`);
      if (manifest.read.apply?.inferred !== undefined && typeof manifest.read.apply.inferred !== "boolean") errors.push(`${label}.read.apply.inferred 必须是布尔值`);
      if (manifest.read.apply?.inferred === true && manifest.read.apply.inferredFrom !== INFERRED_FROM) errors.push(`${label}.read.apply.inferredFrom 必须等于 ${INFERRED_FROM}`);
      if (manifest.read.apply?.inferred === true && !CANDIDATES[manifest.id]) errors.push(`${label}.read.apply 标记 inferred，但 §9.2 提示表中不存在该 agent`);
      if (manifest.read.apply?.inferred !== true && manifest.read.apply.inferredFrom !== undefined) errors.push(`${label}.read.apply.inferred 不为 true 时不得提供 inferredFrom`);
    }
    if (manifest.read.configPathVerified !== undefined && typeof manifest.read.configPathVerified !== "boolean") errors.push(`${label}.read.configPathVerified 必须是布尔值`);
  }
  if (!WRITE_MODES.has(manifest.write?.mode)) errors.push(`${label}.write.mode 必须是 transcript|hook|none`);
  if (manifest.write?.mode === "transcript" || manifest.write?.mode === "hook") {
    requiredString(manifest.write, "source", `${label}.write`);
    requiredString(manifest.write, "credentialRef", `${label}.write`); requiredString(manifest.write, "agent", `${label}.write`); requiredString(manifest.write, "role", `${label}.write`);
    if (manifest.write.role !== "capture-ingest") errors.push(`${label}.write.role 必须是 capture-ingest`);
  }
  if (manifest.write?.mode === "transcript") {
    if (!Array.isArray(manifest.write.sources) || !manifest.write.sources.length) errors.push(`${label}.write.sources 必须是非空数组`);
    for (const [i, source] of (manifest.write.sources ?? []).entries()) {
      const at = `${label}.write.sources[${i}]`;
      if (!Array.isArray(source?.dirs) || !source.dirs.length || source.dirs.some((item) => typeof item !== "string" || !item)) errors.push(`${at}.dirs 必须是非空字符串数组`);
      if (!FORMATS.has(source?.format)) errors.push(`${at}.format 必须是 jsonl|jsonl-zst|json-object`);
      if (source?.glob !== undefined && (typeof source.glob !== "string" || !source.glob)) errors.push(`${at}.glob 必须是非空字符串；缺省时默认为 *`);
      for (const dir of source?.dirs ?? []) { try { assertNoMemoryRoot(dir, `${at}.dirs`); } catch (error) { errors.push(error.message); } }
    }
  } else if (manifest.write?.mode === "hook" && manifest.write.sources !== undefined && (!Array.isArray(manifest.write.sources) || manifest.write.sources.length !== 0)) {
    errors.push(`${label}.write.sources 在 hook 模式必须缺省或为空数组`);
  }
  if (!INJECTS.has(manifest.inject)) errors.push(`${label}.inject 必须是 native|brief-on-demand`);
  if (!STATES.has(manifest.state)) errors.push(`${label}.state 必须是 discovered|verified|enabled|disabled`);
  if (typeof manifest.notes !== "string") errors.push(`${label}.notes 必须是字符串`);
  for (const field of [manifest.read?.configPath, manifest.read?.credentialRef, manifest.write?.credentialRef]) if (typeof field === "string") { try { assertNoMemoryRoot(field, `${label}.manifest`); } catch (error) { errors.push(error.message); } }
  return errors;
}
export { validateManifest };
function makeManifest(id, candidate, dirs, sample, note = "") {
  const detectedRead = detectApply(candidate);
  const write = candidate.writeMode === "none" ? { mode: "none" } : { mode: "transcript", source: id, sources: [{ dirs: candidate.dirs, format: candidate.format, glob: candidate.glob }], credentialRef: `memory-lib/${id}`, agent: "pilot-01", role: "capture-ingest" };
  return { specVersion: 1, id, displayName: candidate.displayName, read: { mode: "mcp", server: "memory", ...detectedRead, credentialRef: `memory-lib/${id}`, agent: "pilot-01", role: "reader" }, write, inject: "brief-on-demand", state: "discovered", notes: note, ...(sample ? { detected: { format: candidate.format, sample: { role: sample.role, contentChars: sample.content.length } } } : {}) };
}
async function discover(id) {
  const candidate = CANDIDATES[id];
  if (!candidate) throw new Error(`未知 agent: ${id}；可选 ${Object.keys(CANDIDATES).join(", ")}`);
  const dirs = candidate.dirs.flatMap(expandDir);
  const files = filesIn(dirs, candidate.glob);
  let sample = null;
  let error = "";
  if (files.length) { try { sample = readSample(files[0], candidate.format); if (!sample) error = `文件存在但抽不到消息形状（${files[0]}）`; } catch (e) { error = `格式读取失败（${e.message}）`; } }
  const note = !dirs.length ? "目录未出现；保持 discovered，等待接入方创建目录" : error ? `${error}；保持 discovered，未猜测格式` : sample ? `已探测 ${files.length} 个文件，抽样确认 ${candidate.format}` : "目录存在但尚未发现匹配文件；保持 discovered";
  return makeManifest(id, candidate, dirs.length ? dirs : candidate.dirs, sample, note);
}
async function writeManifest(manifest) { await fsp.mkdir(manifestDir, { recursive: true }); await fsp.writeFile(path.join(manifestDir, `${manifest.id}.json`), JSON.stringify(manifest, null, 2) + "\n", "utf8"); }
async function validateAll() {
  let bad = 0;
  let entries = [];
  try { entries = (await fsp.readdir(manifestDir)).filter((name) => name.endsWith(".json")); } catch { return 0; }
  for (const name of entries) {
    const file = path.join(manifestDir, name);
    try {
      const manifest = JSON.parse(await fsp.readFile(file, "utf8"));
      const errors = validateManifest(manifest, name);
      if (errors.length) { bad++; console.error(errors.join("\n")); continue; }
      if (manifest.read?.mode !== "none") {
        const configPathVerified = configHasDeclaredKey(manifest.read, CANDIDATES[manifest.id]);
        if (!configPathVerified) {
          const reason = configPathExists(manifest.read.configPath) ? "未发现已知键路径" : "不存在";
          console.error(`WARN ${name}: read.configPath ${reason}：${manifest.read.configPath}`);
        }
        if (manifest.read.apply?.inferred === true) console.error(`WARN ${name}: read.apply 为自动探测的猜测，请确认`);
      }
      console.log(`OK ${name}`);
    } catch (error) { bad++; console.error(`${name}: JSON 无法解析: ${error.message}`); }
  }
  return bad;
}
if (has("validate")) process.exitCode = await validateAll();
else {
  const ids = agentId ? [agentId] : Object.keys(CANDIDATES);
  for (const id of ids) {
    const manifest = await discover(id);
    const errors = validateManifest(manifest, id);
    if (errors.length) throw new Error(errors.join("\n"));
    const action = has("enable") ? "enabled" : has("disable") ? "disabled" : null;
    if (action) {
      const file = path.join(manifestDir, `${id}.json`);
      const existing = JSON.parse(await fsp.readFile(file, "utf8").catch(() => "null"));
      if (!existing) throw new Error(`${id} manifest 不存在；先用 --write`);
      if (action === "enabled" && existing.state !== "verified") throw new Error(`${id} 只能从 verified 启用，当前 state=${existing.state}`);
      existing.state = action; await writeManifest(existing); console.log(`${id}: state=${action}`); continue;
    }
    if (has("write")) {
      const file = path.join(manifestDir, `${id}.json`);
      const existing = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (existing?.read?.apply !== undefined && existing.read.apply.inferred !== true) {
        manifest.read = existing.read;
        manifest.read.configPathVerified = configHasDeclaredKey(manifest.read, CANDIDATES[id]);
      }
      if (existing && STATES.has(existing.state) && existing.state !== "discovered") manifest.state = existing.state;
      const mergedErrors = validateManifest(manifest, id);
      if (mergedErrors.length) throw new Error(mergedErrors.join("\n"));
      await writeManifest(manifest);
    }
    const discoveryError = /文件存在但抽不到消息形状|格式读取失败/u.test(manifest.notes);
    if (discoveryError) { console.error(`${id}: ${manifest.notes}`); process.exitCode = 1; }
    console.log(JSON.stringify({ agent: id, state: manifest.state, dirs: manifest.write.mode === "transcript" ? manifest.write.sources[0].dirs : [], format: manifest.write.mode === "transcript" ? manifest.write.sources[0].format : null, notes: manifest.notes, manifest: path.join(manifestDir, `${id}.json`), wrote: has("write") }, null, 2));
  }
}
