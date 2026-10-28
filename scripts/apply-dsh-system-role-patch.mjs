#!/usr/bin/env node
/**
 * apply-dsh-system-role-patch.mjs —— 给 DSH 的 π-ai 适配器打/撤「不向上游发 system 角色」补丁
 *
 * 为什么需要它（2026-10-16）：
 *   上游（blackaicoding 网关的 chat/completions 路径）**拒收 `role:"system"`**（400 "System messages are not allowed"，
 *   上游透传），而网关建议的 `/v1/responses` 路径**实测 stream=true 一律 502**（DSH 必须流式）⇒ 目前唯一可用组合是
 *   「留在 chat/completions + 本补丁（把系统提示并进首条 user 消息）」。
 *
 * 补丁内容（仅对 `openai-completions` 协议生效；anthropic/google/bedrock/mistral/responses 不动）：
 *   1) `piContext(options, messages)` → `piContext(options, messages, api)`，并在 openai-completions 时
 *      不再设置 `systemPrompt`，改为把系统提示作为**首条 user 消息**（π-ai 本就把 system 历史消息转成 user，语义等价）。
 *   2) `textOnlyContext` / `toPiContext` / `toPiContextWithImages` 增加 `api` 形参并向下传递。
 *   3) 调用点把 `profile.api` 传进去（已核实运行时 profile 对象确实带 `api`）。
 *
 * 用法：
 *   node apply-dsh-system-role-patch.mjs --check      # 只看当前是否已打（默认）
 *   node apply-dsh-system-role-patch.mjs --apply      # 打补丁（自动备份）
 *   node apply-dsh-system-role-patch.mjs --revert     # 从备份还原
 */
import fs from "node:fs";
import path from "node:path";

const TARGET = "D:\\AI\\deepseek-harness\\node_modules\\.pnpm\\@deepseek-ai+dsh-llm-pi-ai@_8f001180741cdc284be3cdaebf13c4b3\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js";
const BACKUP = "D:\\MemoryLib\\backups\\dsh-patch-20261015\\dsh-llm-pi-ai-index.js.bak";
const MARK = "2026-10-15 本地补丁";
const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--revert") ? "revert" : "check";

if (!fs.existsSync(TARGET)) { console.error(`找不到适配器文件：${TARGET}`); process.exit(2); }

if (mode === "check") {
  const t = fs.readFileSync(TARGET, "utf8");
  console.log(`文件：${TARGET}`);
  console.log(`  已打补丁：${t.includes(MARK)}`);
  console.log(`  mergeSystemIntoUser 存在：${t.includes("mergeSystemIntoUser")}`);
  console.log(`  piContext 签名：${/function piContext\(([^)]*)\)/u.exec(t)?.[1] ?? "(未找到)"}`);
  process.exit(0);
}

if (mode === "revert") {
  if (!fs.existsSync(BACKUP)) { console.error(`找不到备份：${BACKUP}`); process.exit(2); }
  fs.copyFileSync(BACKUP, TARGET);
  console.log("已从备份还原。");
  process.exit(0);
}

// ---- apply ----
fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
if (!fs.existsSync(BACKUP)) { fs.copyFileSync(TARGET, BACKUP); console.log(`已新建备份：${BACKUP}`); }
let t = fs.readFileSync(TARGET, "utf8");
if (t.includes(MARK)) { console.log("已经是打过补丁的状态，无需重复打。"); process.exit(0); }

const PATCH = {
  "function piContext(options, messages) {": `function piContext(options, messages, api) {
	// ⚠️ ${MARK}（不是上游代码）——见 D:\\MemoryLib\\reports\\GATEWAY-REPORT-system-role-400.md
	//    openai-completions 类上游自 2026 起不再接受 role="system"（改用 developer / instructions）；
	//    π-ai 只在 \`model.reasoning && compat.supportsDeveloperRole\` 时才发 developer，非标准 provider
	//    （如 blackaicoding 网关）该 compat 默认为 false ⇒ 仍发 system ⇒ 上游 400 "System messages are not allowed"。
	//    修法：把系统提示作为**首条 user 消息**传入（语义等价：π-ai 本就把 system 历史消息转成 user）。
	//    实测：该网关对 system → 400、对 developer/并进 user → 200；而它建议的 /v1/responses 流式一律 502，
	//    故目前唯一可用组合是「chat/completions + 本补丁」。`,
  "\tconst tools = toolsOf(options);\n\treturn {\n\t\t...options.system !== void 0 ? { systemPrompt: options.system } : {},\n\t\tmessages,\n\t\t...tools !== void 0 && tools.length > 0 ? { tools } : {}\n\t};":
    "\tconst tools = toolsOf(options);\n\tconst mergeSystemIntoUser = (api ?? \"openai-completions\") === \"openai-completions\";\n\tconst withTools = tools !== void 0 && tools.length > 0 ? { tools } : {};\n\tif (options.system !== void 0 && mergeSystemIntoUser) {\n\t\treturn {\n\t\t\tmessages: [\n\t\t\t\t{\n\t\t\t\t\trole: \"user\",\n\t\t\t\t\tcontent: options.system,\n\t\t\t\t\ttimestamp: 0\n\t\t\t\t},\n\t\t\t\t...messages\n\t\t\t],\n\t\t\t...withTools\n\t\t};\n\t}\n\treturn {\n\t\t...options.system !== void 0 ? { systemPrompt: options.system } : {},\n\t\tmessages,\n\t\t...withTools\n\t};",
  "function textOnlyContext(options, onReplayDegrade) {": "function textOnlyContext(options, onReplayDegrade, api) {",
  "function toPiContext(options, attachments, onReplayDegrade, maxRequestImageBytes) {\n\treturn attachments === void 0 ? textOnlyContext(options, onReplayDegrade) : toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes);\n}\nasync function toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes) {":
    "function toPiContext(options, attachments, onReplayDegrade, maxRequestImageBytes, api) {\n\treturn attachments === void 0 ? textOnlyContext(options, onReplayDegrade, api) : toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes, api);\n}\nasync function toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes, api) {",
  "return piContext(options, messages);": "return piContext(options, messages, api);",
  "toPiContext(options, void 0, onReplayDegrade) : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes)":
    "toPiContext(options, void 0, onReplayDegrade, void 0, profile.api) : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes, profile.api)",
};

for (const [from, to] of Object.entries(PATCH)) {
  const n = t.split(from).length - 1;
  if (n === 0) { console.error(`✘ 找不到锚点（可能上游代码变了）：${from.slice(0, 60)}…`); process.exit(3); }
  t = t.split(from).join(to);
  console.log(`  ✔ 替换 ${n} 处：${from.split("\n")[0].slice(0, 60)}…`);
}

// 语法自检：把内容写进**同目录、同扩展名（.js）**的临时文件交给 node --check
// （注意：`.mjs` 会让 `node --check` 按 CJS 解析而误报 "Unexpected token 'export'"）
const tmp = `${TARGET}.patchcheck-${process.pid}.js`;
fs.writeFileSync(tmp, t, "utf8");
const { execFileSync } = await import("node:child_process");
try { execFileSync(process.execPath, ["--check", tmp], { stdio: "inherit" }); }
catch { fs.unlinkSync(tmp); console.error("✘ 语法检查失败，未写入。"); process.exit(4); }
fs.unlinkSync(tmp);

fs.writeFileSync(TARGET, t, "utf8");
console.log(`✅ 补丁已写入（${fs.statSync(TARGET).size} 字节）。**必须重启 DSH 才生效**。`);
