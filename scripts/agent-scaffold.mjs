#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1))), "..");
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback; };
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const manifestDir = path.resolve(value("manifest-dir", path.join(ROOT, "data", "runtime", "agents")));
const id = value("agent");
const skillsDir = path.resolve(process.env.DSH_SKILLS_DIR || path.join(home, ".dsh", "skills"));

function help() {
  console.log(`用法 / Usage:
  node scripts/agent-scaffold.mjs --agent <id> [--manifest-dir <dir>] [--dry-run]
  node scripts/agent-scaffold.mjs --agent <id> [--manifest-dir <dir>] --write [--write-config] [--force]

默认打印四类产物的路径与完整内容，不写配置；--write 幂等写入三份 scaffold 产物。
  --agent <id>          manifest id
  --manifest-dir <dir>  manifest 目录
  --dry-run             只打印，不落盘（默认）
  --write               写入写侧校验、skill 与校验清单；读侧配置只打印
  --write-config        与 --write 合用，显式写入 read.configPath
  --force               允许 --write-config 修改第三方文件；写前仍备份
  --help, -h            打印用法`);
}
if (has("help") || argv.includes("-h")) { help(); process.exit(0); }
if (!id) { console.error("缺少 --agent <id>；先用 agent-discover 生成 manifest，再运行 scaffold"); process.exit(2); }
if (has("write") && has("dry-run")) { console.error("--write 与 --dry-run 不能同时使用"); process.exit(2); }
if (has("write-config") && !has("write")) { console.error("--write-config 必须与 --write 合用"); process.exit(2); }
if (has("force") && !has("write-config")) { console.error("--force 只用于 --write --write-config"); process.exit(2); }

const manifestFile = path.join(manifestDir, `${id}.json`);
let manifest;
try { manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8")); }
catch (error) { console.error(`读不到 manifest ${manifestFile}：${error.message}；请先运行 agent-discover --agent ${id} --write`); process.exit(1); }
if (manifest.id !== id) { console.error(`manifest.id=${manifest.id} 与 --agent ${id} 不一致`); process.exit(1); }
const declaredApplyKind = manifest.read?.apply?.kind ?? "config";
if (has("write-config") && declaredApplyKind !== "config") { console.error(`--write-config 仅适用于 read.apply.kind=config；当前为 ${declaredApplyKind}`); process.exit(2); }

function validateTarget() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-scaffold-validate-"));
  try {
    fs.copyFileSync(manifestFile, path.join(temp, `${id}.json`));
    return spawnSync(process.execPath, [path.join(ROOT, "scripts", "agent-discover.mjs"), "--validate", "--manifest-dir", temp], { encoding: "utf8", windowsHide: true, env: process.env });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const validation = validateTarget();
if (validation.status !== 0) { process.stderr.write(validation.stderr || validation.stdout || "manifest 校验失败\n"); process.exit(validation.status || 1); }

function expandHome(input) { return String(input).replace(/^~(?=$|[\\/])/u, home); }
function renderManifestPath(input, placeholder = "<path>") {
  const raw = String(input);
  const resolved = path.resolve(expandHome(raw));
  const tempRoot = path.resolve(os.tmpdir());
  const within = (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`);
  return within(tempRoot) || within(manifestDir) ? placeholder : raw;
}
function assertSafeStrings(item, at = "manifest") {
  if (typeof item === "string") { if (/[\u0000-\u001f\u007f]/u.test(item)) throw new Error(`${at} 含控制字符，不能安全生成配置或 skill`); return; }
  if (Array.isArray(item)) return item.forEach((child, index) => assertSafeStrings(child, `${at}[${index}]`));
  if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) assertSafeStrings(child, `${at}.${key}`);
}
assertSafeStrings(manifest);
function mcpStdioEntry() {
  return { command: process.execPath, args: [path.join(ROOT, "scripts", "memory-mcp-launch.mjs")], env: { MCP_MEMORY_URL: "http://127.0.0.1:8787", MCP_MEMORY_CRED_REF: manifest.read.credentialRef, MCP_MEMORY_AGENT: manifest.read.agent, MCP_MEMORY_ROLE: manifest.read.role } };
}
const applyKind = manifest.read?.apply?.kind ?? "config";
function renderApplyCommand(template) {
  const replacements = { "<node>": process.execPath, "<launcher>": path.join(ROOT, "scripts", "memory-mcp-launch.mjs"), "<ref>": manifest.read.credentialRef, "<agent>": manifest.read.agent, "<role>": manifest.read.role };
  let command = template;
  for (const [placeholder, actual] of Object.entries(replacements)) command = command.replaceAll(placeholder, actual);
  const unknown = command.match(/<[^<>]+>/u)?.[0];
  if (unknown) throw new Error(`read.apply.command 含未定义占位符 ${unknown}；只支持 ${Object.keys(replacements).join(", ")}`);
  return command;
}
function yamlConfigBlock(entry, keyPath = "mcp") {
  const env = Object.entries(entry.env).map(([key, val]) => `      ${key}: ${JSON.stringify(val)}`).join("\n");
  return `# BEGIN MemoryLib scaffold: ${manifest.read.server}\n${keyPath}:\n  ${manifest.read.server}:\n    command: ${JSON.stringify(entry.command)}\n    args:\n${entry.args.map((arg) => `      - ${JSON.stringify(arg)}`).join("\n")}\n    env:\n${env}\n# END MemoryLib scaffold: ${manifest.read.server}`;
}
function mergeYamlServer(previous, block, server, keyPath = "mcp") {
  if (!previous.trim()) return `${block}\n`;
  const serverBlock = block.split("\n").slice(2, -1).join("\n");
  const escaped = server.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  const escapedKey = keyPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  const keyPattern = new RegExp(`^${escapedKey}:\\s*(?:#.*)?$`, "mu");
  const keyMatch = keyPattern.exec(previous);
  if (keyMatch) {
    const start = keyMatch.index + keyMatch[0].length;
    const tail = previous.slice(start);
    const endOffset = tail.search(/^\S.*$/mu);
    const end = endOffset < 0 ? previous.length : start + endOffset;
    const body = previous.slice(start, end);
    const serverPattern = new RegExp(`^  ${escaped}:\\s*(?:#.*)?$(?:\\r?\\n(?: {4,}.*|\\s*))*`, "mu");
    const merged = serverPattern.test(body) ? body.replace(serverPattern, `${serverBlock}\n`) : `${body}${body.endsWith("\n") || !body ? "" : "\n"}${serverBlock}\n`;
    return previous.slice(0, start) + merged + previous.slice(end);
  }
  return `${previous}${previous.endsWith("\n") ? "" : "\n"}\n${block}\n`;
}
function setDottedServer(record, keyPath, server, entry) {
  const keys = String(keyPath || "mcpServers").split(".").filter(Boolean);
  let node = record;
  for (const key of keys) node = node[key] = { ...(node[key] ?? {}) };
  node[server] = entry;
  return record;
}
function jsonServerSnippet(keyPath, server, entry) { return setDottedServer({}, keyPath, server, entry); }
function readConfig() {
  if (manifest.read.mode === "none") {
    const content = `# ${manifest.displayName} read side\n\nread.mode=none；无需配置 MemoryLib 读侧。\n`;
    return { path: path.join(manifestDir, `${id}.read-disabled.md`), displayPath: `<manifest-dir>/${id}.read-disabled.md`, content, snippet: content, owned: true, persistByDefault: true, writable: true };
  }
  if (manifest.read.mode === "http") throw new Error(`read.mode=http 没有跨客户端通用的 credentialRef 运行时解析器；请改用 mcp，或为 ${manifest.read.configPath} 提供客户端专用 adapter`);
  if (applyKind === "cli") {
    const command = renderApplyCommand(manifest.read.apply.command);
    return { path: null, displayPath: "CLI", content: command + "\n", snippet: `${command}\n${manifest.read.apply.verifyCommand}\n`, owned: true, writable: false };
  }
  if (applyKind === "manual") {
    const guidance = "这个 agent 需要手工配，我们不知道它读哪里；请查该 agent 的 MCP 文档后手工注册。\n";
    return { path: null, displayPath: "manual", content: guidance, snippet: guidance, owned: true, writable: false };
  }
  const target = path.resolve(expandHome(manifest.read.configPath));
  const entry = mcpStdioEntry();
  const extension = path.extname(target).toLowerCase();
  if (extension === ".toml") {
    const server = manifest.read.server, keyPath = manifest.read.apply?.keyPath || "mcp_servers", begin = `# BEGIN MemoryLib scaffold: ${server}`, end = `# END MemoryLib scaffold: ${server}`;
    const block = `${begin}\n[${keyPath}.${server}]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args.map(JSON.stringify).join(", ")}]\n\n[${keyPath}.${server}.env]\n${Object.entries(entry.env).map(([key, val]) => `${key} = ${JSON.stringify(val)}`).join("\n")}\n${end}`;
    const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const escaped = server.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    const escapedKey = keyPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    const ownedPattern = new RegExp(`# BEGIN MemoryLib scaffold: ${escaped}[\\s\\S]*?# END MemoryLib scaffold: ${escaped}`, "u");
    const unmanagedPattern = new RegExp(`^\\[${escapedKey}\\.${escaped}\\][\\s\\S]*?(?=^\\[(?!${escapedKey}\\.${escaped}(?:\\.|\\]))|(?![\\s\\S]))`, "mu");
    const owned = !previous || ownedPattern.test(previous);
    let content;
    if (ownedPattern.test(previous)) content = previous.replace(ownedPattern, block);
    else if (unmanagedPattern.test(previous)) content = previous.replace(unmanagedPattern, `${block}\n`);
    else content = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${block}\n`;
    return { path: target, displayPath: renderManifestPath(manifest.read.configPath, "<config-path>"), content, snippet: `${block}\n`, owned, writable: true };
  }
  if (extension === ".yml" || extension === ".yaml") {
    const keyPath = manifest.read.apply?.keyPath || "mcp";
    const block = yamlConfigBlock(entry, keyPath), previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const escaped = manifest.read.server.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    const ownedPattern = new RegExp(`# BEGIN MemoryLib scaffold: ${escaped}[\\s\\S]*?# END MemoryLib scaffold: ${escaped}`, "u");
    const owned = !previous || ownedPattern.test(previous);
    const content = ownedPattern.test(previous) ? previous.replace(ownedPattern, block) : mergeYamlServer(previous, block, manifest.read.server, keyPath);
    return { path: target, displayPath: renderManifestPath(manifest.read.configPath, "<config-path>"), content, snippet: `${block}\n`, owned, writable: true };
  }
  let record = {}, owned = true;
  if (fs.existsSync(target)) {
    try { record = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw new Error(`${target} 不是合法 JSON；请修复后重试，未覆盖`); }
    const marker = record.memoryLibScaffold;
    owned = marker?.owner === "agent-scaffold" && marker.agent === id && marker.server === manifest.read.server;
  }
  const marker = { owner: "agent-scaffold", agent: id, server: manifest.read.server };
  record.memoryLibScaffold = marker;
  const keyPath = manifest.read.apply?.keyPath || "mcpServers";
  const snippet = jsonServerSnippet(keyPath, manifest.read.server, entry);
  setDottedServer(record, keyPath, manifest.read.server, entry);
  return { path: target, displayPath: renderManifestPath(manifest.read.configPath, "<config-path>"), content: JSON.stringify(record, null, 2) + "\n", snippet: JSON.stringify(snippet, null, 2) + "\n", owned, writable: true };
}
function skillConfigBlock() {
  if (manifest.read.mode === "none" || applyKind === "manual") return "";
  if (applyKind === "cli") return `\n\`\`\`powershell\n${renderApplyCommand(manifest.read.apply.command)}\n\`\`\`\n\n验证注册结果：\n\`\`\`powershell\n${manifest.read.apply.verifyCommand}\n\`\`\`\n`;
  const entry = mcpStdioEntry();
  const extension = path.extname(manifest.read.configPath).toLowerCase();
  if (extension === ".toml") {
    const keyPath = manifest.read.apply?.keyPath || "mcp_servers";
    const lines = `[${keyPath}.${manifest.read.server}]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args.map(JSON.stringify).join(", ")}]\n\n[${keyPath}.${manifest.read.server}.env]\n${Object.entries(entry.env).map(([key, val]) => `${key} = ${JSON.stringify(val)}`).join("\n")}`;
    return `\n\`\`\`toml\n${lines}\n\`\`\`\n`;
  }
  if (extension === ".yml" || extension === ".yaml") return `\n\`\`\`yaml\n${yamlConfigBlock(entry, manifest.read.apply?.keyPath || "mcp").replace(/^# .*$/gmu, "").trim()}\n\`\`\`\n`;
  const value = jsonServerSnippet(manifest.read.apply?.keyPath || "mcpServers", manifest.read.server, entry);
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}
function skillPathValue(input, field) {
  const rendered = renderManifestPath(input, "");
  return rendered || `manifest 的 \`${field}\` 字段`;
}
function absoluteCommand(script, args) {
  return `node ${JSON.stringify(path.join(ROOT, "scripts", script))} ${args}`;
}
function writeDescription() {
  const write = manifest.write;
  if (write.mode === "transcript") {
    const rows = write.sources.map((source, index) => `- ${source.dirs.map((dir, dirIndex) => `${skillPathValue(dir, `write.sources[${index}].dirs[${dirIndex}]`)}`).join(", ")}（format=${source.format}, glob=${source.glob ?? "*"}）`).join("\n");
    const manifestFileForSkill = path.join(ROOT, "data", "runtime", "agents", `${id}.json`);
    return `manifest 的标准位置是 \`${manifestFileForSkill}\`；对话源目录读取该文件的 \`write.sources[].dirs\`，逐项含义如下：\n${rows}\n运行验证：\n\`\`\`powershell\n${absoluteCommand("capture-tail.mjs", `--agent ${id} --manifest-dir ${JSON.stringify(path.dirname(manifestFileForSkill))} --once --backfill --verify`)}\n\`\`\``;
  }
  if (write.mode === "hook") return `你要自己 POST 到 \`http://127.0.0.1:8787/v1/conversations/capture\`。每次至少提供 \`source\`、\`conversation_id\`、\`messages\` 三个业务字段；身份使用 credentialRef \`${write.credentialRef}\` 与 \`${write.agent}/${write.role}\`。`;
  return "write.mode=none；本接入不写回对话。";
}
function skillContent() {
  const read = manifest.read;
  const canonicalManifest = path.join(ROOT, "data", "runtime", "agents", `${id}.json`);
  const scaffoldCommand = absoluteCommand("agent-scaffold.mjs", `--agent ${id} --write`);
  const stdioLaunchCommand = `$env:MCP_MEMORY_URL=\"http://127.0.0.1:8787\"; $env:MCP_MEMORY_CRED_REF=${JSON.stringify(read.credentialRef)}; $env:MCP_MEMORY_AGENT=${JSON.stringify(read.agent)}; $env:MCP_MEMORY_ROLE=${JSON.stringify(read.role)}; node ${JSON.stringify(path.join(ROOT, "scripts", "memory-mcp-launch.mjs"))}`;
  const manifestIntro = `manifest 的生产标准位置是 \`${canonicalManifest}\`；\`--manifest-dir\` 表示这个文件的父目录。技能交付前，生成者必须审核并把隔离或自定义目录中的 manifest 提升到这个标准位置；技能使用者从该标准位置读取，不负责猜测临时源目录。重新生成运行：\`${scaffoldCommand}\`。`;
  let readStep;
  if (read.mode === "none") readStep = `此 agent 的 \`read.mode=none\`，跳过读侧配置与健康检查。${manifestIntro}`;
  else if (applyKind === "cli") readStep = `${manifestIntro} 使用该 agent 自己的 CLI 注册；下面命令只供复制粘贴，scaffold 不执行它。\n${skillConfigBlock()}\n命令使用真实 Node \`${process.execPath}\` 与 launcher \`${path.join(ROOT, "scripts", "memory-mcp-launch.mjs")}\`。`;
  else if (applyKind === "manual") readStep = `${manifestIntro} 这个 agent 需要手工配，我们不知道它读哪里；请查该 agent 的 MCP 文档并手工注册。scaffold 不写读侧配置文件；在确定该 agent 的真实路径和键之前，只执行下方公共 health 验证。`;
  else readStep = `${manifestIntro} 把下面完整配置块合并到 ${skillPathValue(read.configPath, "read.configPath")} 的正确键路径；scaffold 默认只打印，新配置文件可用 \`${scaffoldCommand} --write-config\` 写入，既有配置按下方合并规则处理。\n${skillConfigBlock()}\n配置中的 launcher 写实路径是 \`${path.join(ROOT, "scripts", "memory-mcp-launch.mjs")}\`，由真实 Node \`${process.execPath}\` 启动并在运行时解析 \`credentialRef=${read.credentialRef}\`。\n\n**合并规则**：任何既有第三方配置都先拒绝修改并要求人工确认；确认保留备份后运行 \`${scaffoldCommand} --write-config --force\`。scaffold 只合并 MemoryLib server 字段，保留他人 server 与其 \`env\`，不整段覆盖目标配置；已有同名 server 属于冲突，同样必须人工确认。`;
  if (read.mode !== "none" && (read.apply === undefined || read.apply.inferred === true)) readStep = `**以下为自动探测的猜测，请确认后再执行（你若知道自己怎么配，以你的为准）**\n\n${readStep}`;
  if (read.mode !== "none") readStep += `\n\n### 普通接入方（reader）\n\n| 身份 | 入口 | 工具或 HTTP payload | 完成标准 |\n|---|---|---|---|\n| 普通接入方（reader） | \`memory_health({})\` / \`GET http://127.0.0.1:8787/v1/health\`（HTTP 200） | 扁平 \`ok, service, version, health, audit, vector, capacity, index, audit_rotation\`，无 \`checks\` | \`health === "healthy"\`；可加 \`vector.status === "ok"\`、\`index.failed === 0\` |\n\n可用任意 MCP 客户端连接 launcher 的 **stdio**。手写 JSON-RPC 时，先在 PowerShell 运行 \`${stdioLaunchCommand}\`；该命令只传 credentialRef，不含明文凭据。然后按行写入：\n1. \`{ "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{ "protocolVersion":"2024-11-05", "capabilities":{}, "clientInfo":{ "name":"memory-skill", "version":"1" } } }\`\n2. \`{ "jsonrpc":"2.0", "method":"notifications/initialized" }\`\n3. \`{ "jsonrpc":"2.0", "id":2, "method":"tools/call", "params":{ "name":"memory_health", "arguments":{} } }\`\n读取 id=2 的响应，并把 \`result.content[0].text\` 解析为 JSON；上表列的是解析后的工具 payload，不是 JSON-RPC 外层。\n\n### 管理员\n\n| 身份 | 入口 | 额外结构 | 完成标准 |\n|---|---|---|---|\n| 管理员 | \`POST /v1/admin/health\`（\`librarian-admin\`） | \`checks[10]\`、\`dataRoot\`、\`roots\`、\`scopeMode\`、\`principal\` 等 | 10 项 \`checks\` 全为 \`ok\` |`;
  const recall = manifest.inject === "brief-on-demand" ? "回答涉及以前、上次、之前或历史决定的问题前，先调 `memory_recall_brief`：`memory_recall_brief({ query: \"用户原话\", memory_only: true })`。" : "需要历史上下文时调用 `memory_recall_brief({ query: \"当前问题\", memory_only: true })`；native 注入仍以工具结果为准。";
  const writeDone = manifest.write.mode === "none" ? "确认本接入无需写回。" : manifest.write.mode === "transcript" ? "运行上面的 capture-tail verify，打印 evidence 与正确 source。" : "按 hook 约定成功提交一次 capture。";
  return `---\nname: memory-${id}\ndescription: ${JSON.stringify(`接入或排查 ${manifest.displayName} 的 MemoryLib 读侧、记忆召回与对话写回时使用。`)}\n---\n# ${manifest.displayName} MemoryLib 接入\n\n## 1. 配置并验证读侧\n${readStep}\n\n完成标准：${read.mode === "none" ? "确认无需读能力。" : "`memory_health({})` 返回 `health: \"healthy\"`。"}\n\n## 2. 使用记忆\n${recall}\n\n完成标准：需要历史的问题先取得有界摘要，再回答。\n\n## 3. 写回\n${writeDescription()}\n\n完成标准：${writeDone}\n\n## 失败排查\n- **401**：直接访问 \`/health\` 匿名也返回 401 是正常的；免重启匿名探针应使用 \`/v1/health\`。只有 \`memory_health\` 返回 401 才按凭据问题处理：核对 \`credentialRef\` 和凭据管理器。\n- **403**：身份角色不允许该操作；读取用 ${read.role ?? "n/a"}，capture 用 ${manifest.write.role ?? "n/a"}。\n- **404**：MCP/HTTP 地址或路由错误；核对 \`http://127.0.0.1:8787/mcp\` 与 capture 路由。\n- **0 条**：先看目录、glob（缺省为 \`*\`）、格式和 offset；不可解析会打印 \`WARN unparsable\`。\n\n## 红线\n- 不许明文保存凭据，只引用 \`credentialRef\`。\n- 不许配置 MemoryLib 的磁盘数据路径；只使用 MCP/HTTP 地址。\n- 不许直写 curated；对话只能走 capture evidence。\n`;
}
const read = readConfig();
const validationPath = path.join(manifestDir, `${id}.write-validation.md`);
const validationContent = `# ${manifest.displayName} 写侧校验\n\n- manifest: <manifest-dir>/${id}.json\n- id: ${manifest.id}\n- write.mode: ${manifest.write.mode}\n- credentialRef: ${manifest.write.credentialRef ?? "n/a"}\n- agent/role: ${manifest.write.agent ?? "n/a"}/${manifest.write.role ?? "n/a"}\n- schema: PASS\n- sources: ${manifest.write.mode === "transcript" ? manifest.write.sources.map((source) => `${source.dirs.map((dir) => renderManifestPath(dir, "<source-dir>")).join(",")} | ${source.format} | ${source.glob ?? "*"}`).join("; ") : "n/a"}\n`;
const skillPath = path.join(skillsDir, `memory-${id}`, "SKILL.md"), checklistPath = path.join(manifestDir, `${id}.checklist.md`);
const healthStep = manifest.read.mode === "none" ? "确认 read.mode=none，无需 health" : "调用 `memory_health({})`，期望扁平响应的 `health: \"healthy\"`（reader 响应不含 checks）";
const captureStep = manifest.write.mode === "transcript" ? `\`node scripts/capture-tail.mjs --agent ${id} --manifest-dir <manifest-dir> --once --backfill --verify\`` : `确认 write.mode=${manifest.write.mode} 的写回方式已按 skill 验证`;
const checklistContent = `# ${manifest.displayName} 接入校验清单\n\n1. \`node scripts/agent-discover.mjs --validate --manifest-dir <manifest-dir>\`\n2. 审核打印的读侧片段；声明位置：\`${manifest.read.mode === "none" ? read.displayPath : renderManifestPath(manifest.read.configPath, "<config-path>")}\`\n3. ${healthStep}\n4. ${captureStep}\n5. verify 后在 \`<manifest-dir>/${id}.json\` 将 state 改为 enabled\n`;
const outputs = [{ kind: "write-validation", path: validationPath, displayPath: `<manifest-dir>/${id}.write-validation.md`, content: validationContent }, { kind: "skill", path: skillPath, displayPath: `<skills-dir>/memory-${id}/SKILL.md`, content: skillContent() }, { kind: "checklist", path: checklistPath, displayPath: `<manifest-dir>/${id}.checklist.md`, content: checklistContent }];
const forbiddenKey = /^\s*["']?(secret|password|token|apiKey|api_key|bearer)["']?\s*[:=]/imu;
for (const output of [{ kind: "read-config", content: read.content }, ...outputs]) {
  if (/data[\\/]memory/iu.test(output.content)) throw new Error(`${output.kind} 含禁止的记忆库数据路径`);
  if (forbiddenKey.test(output.content)) throw new Error(`${output.kind} 含禁止的明文密钥字段`);
}
function printableConfig() {
  return read.snippet;
}
console.log(`\n===== read-config-snippet: ${read.displayPath} =====\n${printableConfig()}`);
if (!has("write")) {
  for (const output of outputs) console.log(`\n===== ${output.kind}: ${output.displayPath} =====\n${output.content}`);
  console.log("\ndry-run: artifacts=3 configWritten=0");
} else {
  const targetExists = read.path ? fs.existsSync(read.path) : false;
  if (!read.persistByDefault && read.path && !targetExists) console.error(`WARN read.configPath 不存在：${manifest.read.configPath}；默认不创建，仅打印配置片段`);
  if (has("write-config") && targetExists && !read.owned && !has("force")) throw new Error(`${read.path} 是已存在的第三方配置；拒绝修改。确认后加 --force，scaffold 会先留 .bak-<ts>`);
  let created = 0, unchanged = 0, backedUp = 0, configWritten = 0;
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const toWrite = [...outputs, ...(read.persistByDefault ? [{ kind: "read-disabled", path: read.path, content: read.content }] : has("write-config") && read.path ? [{ kind: "read-config", path: read.path, content: read.content }] : [])];
  for (const output of toWrite) {
    await fsp.mkdir(path.dirname(output.path), { recursive: true });
    const previous = await fsp.readFile(output.path, "utf8").catch(() => null);
    if (previous === output.content) { unchanged++; console.log(`unchanged ${output.path}`); continue; }
    if (previous !== null) { const backup = `${output.path}.bak-${stamp}`; await fsp.copyFile(output.path, backup); backedUp++; console.log(`backup ${backup}`); } else created++;
    await fsp.writeFile(output.path, output.content, "utf8");
    if (output.kind === "read-config") configWritten = 1;
    console.log(`write ${output.path}`);
  }
  if (manifest.read?.mode !== "none" && configWritten === 1 && manifest.read.configPathVerified !== true) {
    manifest.read.configPathVerified = true;
    await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  console.log(`summary created=${created} unchanged=${unchanged} backedUp=${backedUp} configWritten=${configWritten}`);
}
