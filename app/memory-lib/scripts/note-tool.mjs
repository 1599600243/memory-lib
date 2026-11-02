#!/usr/bin/env node
// 记录一条工具记忆（tools-memory/<工具名>.md）。
// 用法：
//   node scripts/note-tool.mjs graphify \
//     --purpose "把代码库变成可查询的符号图" \
//     --setup "uv tool install graphifyy；graphify extract <repo> --code-only --no-cluster" \
//     --params "extract --code-only 不调 LLM；update 增量约 8s" \
//     --pitfalls "中文自然语言 query 基本无效；>5000 节点要 --no-viz" \
//     --verify "graphify god-nodes 能列出枢纽；query canSeePath --mode explain 返回调用方" \
//     --evidence conversation-xxx,conversation-yyy
// 环境变量：MEMORY_LIB_URL（默认 http://127.0.0.1:8787）、CREDENTIAL_REF、SECRET、
//          AGENT_ID（默认 admin-01）、ROLE_ID（默认 librarian-admin）
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECTIONS = { purpose: "用途", setup: "接入方式", params: "关键参数", pitfalls: "已知坑", verify: "验证方式" };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
    else out._.push(arg);
  }
  return out;
}

async function loadCredentials() {
  let ref = process.env.CREDENTIAL_REF;
  let secret = process.env.SECRET;
  if ((!ref || !secret) && process.env.DSH_PROFILE) {
    const file = path.join(process.env.DSH_PROFILE, "cordis.patch.yml");
    const text = await fs.readFile(file, "utf8").catch(() => "");
    ref = ref ?? /X-MCP-Credential-Ref:\s*'([^']+)'/u.exec(text)?.[1];
    secret = secret ?? /X-MCP-Secret:\s*'([^']+)'/u.exec(text)?.[1];
  }
  return { ref, secret };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const toolName = args._[0];
  if (!toolName) {
    console.error("用法: node scripts/note-tool.mjs <工具名> --purpose ... --setup ... --params ... --pitfalls ... --verify ... --evidence id1,id2");
    process.exit(2);
  }
  const sections = {};
  for (const [flag, heading] of Object.entries(SECTIONS)) {
    const value = String(args[flag] ?? "").trim();
    if (!value) { console.error(`缺少 --${flag}（对应正文段「${heading}」）`); process.exit(2); }
    sections[heading] = value;
  }
  const evidence = String(args.evidence ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!evidence.length) { console.error("缺少 --evidence（非空证据 id，逗号分隔）"); process.exit(2); }

  const { ref, secret } = await loadCredentials();
  if (!ref || !secret) { console.error("缺少凭证：设置 CREDENTIAL_REF / SECRET，或 DSH_PROFILE 指向 profile 目录"); process.exit(2); }
  const url = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
  const payload = {
    credential_ref: ref,
    secret,
    principal: { agent_id: process.env.AGENT_ID ?? "admin-01", role_id: process.env.ROLE_ID ?? "librarian-admin" },
    tool_name: toolName,
    kind: args.kind ?? "tool",
    env: args.env ?? "win-local",
    sections,
    evidence_refs: evidence,
  };
  const response = await fetch(`${url}/v1/tools/note`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.text();
  if (!response.ok) { console.error(`HTTP ${response.status}: ${body}`); process.exit(1); }
  console.log(body);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
