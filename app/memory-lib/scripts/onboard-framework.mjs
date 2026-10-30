#!/usr/bin/env node
// memory-lib — 新框架接入一键注册（onboard-framework）
//
// 让「任意框架凭身份访问记忆库」变成一条命令，而不是手工：
//   编辑 identity.json + 生成/存 secret + 手拼目标框架配置。
//
// 用法：
//   node scripts/onboard-framework.mjs \
//     --framework-id my-app \
//     --agent app-agent-01 \
//     --role researcher \
//     --scope "layer=memory,visibility=shared" \
//     --scope "layer=knowledge,visibility=shared" \
//     --action search,get,propose \
//     [--credential-ref memory-lib/my-app] \
//     [--registry <identity.json>] \
//     [--secrets-dir <dir>] \
//     [--wincred] [--no-file] \
//     [--url http://127.0.0.1:8787]
//
// F8：wincred 是权威凭证存储（服务端默认 --secret-store wincred），生产接入用
//   `--wincred`（只留凭据管理器可再加 --no-file）。不带 --wincred 时只写 secret 文件，
//   默认配置的服务端读不到该凭证。
//
// 行为：
//   1. 生成 48 字节随机 secret（base64url）；
//   2. 写 Windows 凭据管理器（--wincred 开启；服务端默认 --secret-store wincred，生产必须开启）；
//      写失败 = 命令失败（退出码 1），不更新 identity.json、不留半套 secret 文件；
//   3. 写 secret 文件 <secrets-dir>/<sanitized-ref>.secret（默认；--no-file 只留 wincred）；
//   4. 增量更新 identity.json（framework/agent/role 不存在则新增，存在则更新该 role 的 scope/action）；
//   5. 打印四种接入方式的就绪配置片段（MCP streamable-http / MCP stdio / REST / node SDK）。
//
// 幂等：重复运行同 framework/agent/role 会更新（不会重复插入）。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
// ATOMICWRITE-1：registry 落地与 secret 文件搬移都收敛到统一助手。
import { atomicWriteFile, renameWithRetry } from "../src/atomic-write.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function sanitizeRef(ref) {
  return String(ref).replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ---- 极简 argv 解析 ----
function parseArgs(argv) {
  const args = {
    scopes: [],
    actions: [],
    registry: "I:\\OpenClaw\\memory-data\\runtime\\identity.json",
    secretsDir: "I:\\OpenClaw\\memory-data\\runtime\\secrets",
    url: "http://127.0.0.1:8787",
    wincred: false,
    noFile: false,
  };
  const take = (i) => {
    if (i + 1 >= argv.length) throw new Error(`参数 ${argv[i]} 缺少值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--framework-id": args.frameworkId = take(i); i++; break;
      case "--credential-ref": args.credentialRef = take(i); i++; break;
      case "--agent": args.agentId = take(i); i++; break;
      case "--role": args.roleId = take(i); i++; break;
      case "--scope": args.scopes.push(take(i)); i++; break;
      case "--action": args.actions = args.actions.concat(take(i).split(",").map((s) => s.trim()).filter(Boolean)); i++; break;
      case "--registry": args.registry = take(i); i++; break;
      case "--secrets-dir": args.secretsDir = take(i); i++; break;
      case "--url": args.url = take(i); i++; break;
      case "--wincred": args.wincred = true; break;
      case "--no-file": args.noFile = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`未知参数: ${a}（--help 查看用法）`);
    }
  }
  return args;
}

function parseScope(str) {
  const s = {};
  for (const part of String(str).split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) throw new Error(`--scope 片段格式错误（应为 k=v）: "${part}"`);
    s[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  if (!s.layer || !s.visibility) throw new Error(`--scope 必须含 layer= 和 visibility=，收到: ${str}`);
  return s;
}

function validate(args) {
  if (!args.frameworkId) throw new Error("--framework-id 必填");
  if (!args.agentId) throw new Error("--agent 必填");
  if (!args.roleId) throw new Error("--role 必填");
  if (args.scopes.length === 0) throw new Error("至少一个 --scope 必填");
  if (args.actions.length === 0) throw new Error("--action 必填（如 search,get,propose）");
  args.credentialRef = args.credentialRef || `memory-lib/${args.frameworkId}`;
  if (!/^[a-zA-Z0-9._/-]+$/.test(args.credentialRef)) throw new Error(`credential_ref 含非法字符: ${args.credentialRef}`);
  args.scopes = args.scopes.map(parseScope);
}

// ---- registry 增量更新（原子写） ----
async function updateRegistry(registryPath, { frameworkId, credentialRef, agentId, roleId, scopes, actions }) {
  let registry;
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (e) {
    throw new Error(`identity.json 不可读: ${registryPath}（${e.message}）`);
  }
  if (registry?.version !== 1 || !Array.isArray(registry.frameworks)) {
    throw new Error(`identity.json schema 不支持: ${registryPath}`);
  }

  let framework = registry.frameworks.find((f) => f.framework_id === frameworkId);
  if (!framework) {
    framework = { framework_id: frameworkId, credential_ref: credentialRef, credential: { status: "active", revoked_at: null }, agents: [] };
    registry.frameworks.push(framework);
  } else if (framework.credential_ref && framework.credential_ref !== credentialRef) {
    throw new Error(`framework ${frameworkId} 已绑定 credential_ref=${framework.credential_ref}，与 ${credentialRef} 冲突（一个 framework 一个凭证）`);
  }
  framework.credential_ref = credentialRef;

  let agent = framework.agents.find((a) => a.agent_id === agentId);
  if (!agent) {
    agent = { agent_id: agentId, roles: [] };
    framework.agents.push(agent);
  }
  let role = agent.roles.find((r) => r.role_id === roleId);
  const isNew = !role;
  if (!role) {
    role = { role_id: roleId, scopes: [], actions: [] };
    agent.roles.push(role);
  }
  role.scopes = scopes;
  role.actions = actions;

  // ATOMICWRITE-1：收敛到统一助手（含 rename 重试；原先固定 `<path>.tmp`，并发会互踩）。
  await atomicWriteFile(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return { isNewRole: isNew };
}

// ---- 输出接入配置片段 ----
function renderSnippets({ frameworkId, credentialRef, agentId, roleId, url, secret }) {
  const stdioServer = path.join(path.dirname(here), "mcp", "mcp-server.mjs");
  const nodeBin = process.execPath;
  const serverName = frameworkId.replace(/[^A-Za-z0-9_-]/g, "_");
  const line = "─".repeat(72);

  return `
${line}
① MCP streamable-http（推荐 —— DeepSeek Harness / Cursor / 任何 MCP HTTP 客户端）
   以 DSH 的 cordis.patch.yml 为例（insert 到 profile/host 补丁层）：
${line}
- insert:
    - id: mcp-${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${serverName}
        transport: streamable-http
        url: ${url}/mcp
        headers:
          X-MCP-Credential-Ref: '${credentialRef}'
          X-MCP-Secret: '${secret}'
          X-MCP-Agent: '${agentId}'
          X-MCP-Role: '${roleId}'

${line}
② MCP stdio（Claude Desktop / Cursor 等，mcpServers 配置）
${line}
{
  "mcpServers": {
    "memory-lib-${serverName}": {
      "command": "${nodeBin.replace(/\\/g, "\\\\")}",
      "args": ["${stdioServer.replace(/\\/g, "\\\\")}"],
      "env": {
        "MCP_MEMORY_URL": "${url}",
        "MCP_MEMORY_CRED_REF": "${credentialRef}",
        "MCP_MEMORY_SECRET": "${secret}",
        "MCP_MEMORY_AGENT": "${agentId}",
        "MCP_MEMORY_ROLE": "${roleId}"
      }
    }
  }
}

${line}
③ REST library.v1（任何能发 HTTP 的框架）
${line}
curl -X POST ${url}/v1/search \\
  -H "content-type: application/json" \\
  -d '{"credential_ref":"${credentialRef}","secret":"${secret}","principal":{"agent_id":"${agentId}","role_id":"${roleId}"},"query":"审批"}'

${line}
④ node SDK（memory-lib/sdk/memory-client.mjs）
${line}
import { MemoryClient } from "memory-lib/sdk/memory-client.mjs";
const mem = new MemoryClient({ url: "${url}", credentialRef: "${credentialRef}", secret: "${secret}", agent: "${agentId}", role: "${roleId}" });
await mem.search({ query: "审批" });       // 读
await mem.get("mem_xxx");                  // 按 id 读
await mem.write({ layer: "curated-shared", content, evidence_refs: [evidenceId], source: "onboard-framework" }); // D29 直接写入目标层
`;
}

// ---- main ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node scripts/onboard-framework.mjs --framework-id <id> --agent <agent_id> --role <role_id> \\
  --scope "layer=memory,visibility=shared" [--scope ...] --action search,get,write \\
  [--credential-ref memory-lib/<id>] [--registry <path>] [--secrets-dir <dir>] [--wincred] [--no-file] [--url <url>]

说明: 服务端默认 --secret-store wincred；生产接入请带 --wincred（只留凭据管理器再加 --no-file）。`);
    return;
  }
  validate(args);

  // 1. 生成 secret
  const secret = crypto.randomBytes(48).toString("base64url");
  const secretFile = path.join(args.secretsDir, `${sanitizeRef(args.credentialRef)}.secret`);
  // 先写舞台文件：wincred-write.ps1 只从文件读 secret（secret 不进命令行），
  // 且写入失败时不能留下半套凭证 —— 全部成功后才 rename 成正式 secret 文件。
  const stageFile = path.join(args.secretsDir, `.tmp-${sanitizeRef(args.credentialRef)}.secret`);
  await fs.mkdir(args.secretsDir, { recursive: true });
  await fs.writeFile(stageFile, secret, { encoding: "utf8", mode: 0o600 });

  // 2. 写 Windows 凭据管理器（权威存储；服务端默认 --secret-store wincred）
  if (args.wincred) {
    const target = sanitizeRef(args.credentialRef);
    const script = path.join(here, "wincred-write.ps1");
    try {
      execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Target", target, "-SecretFile", stageFile], { stdio: "inherit" });
      console.log(`✅ Windows 凭据管理器已写: target=${target}（权威存储）`);
    } catch (e) {
      await fs.rm(stageFile, { force: true });
      throw new Error(
        `wincred 写入失败（target=${target}, ${e?.code ?? e?.status ?? e.message}）：identity.json 未更新，secret 文件未改动。\n` +
        `    先手工补写再重跑本命令：powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Target "${target}" -SecretFile "${secretFile}"`
      );
    }
  }

  // 3. 落 secret 文件：--no-file 表示只留 wincred（F8 推荐的生产形态）
  if (!args.noFile) {
    // ATOMICWRITE-1：这是把已写好的 stage 文件**移动**到最终位置，走 renameWithRetry。
    await renameWithRetry(stageFile, secretFile);
    console.log(`✅ secret 文件已写: ${secretFile}`);
  } else {
    await fs.rm(stageFile, { force: true });
    console.log(`ℹ️  --no-file：未落 secret 文件（凭证只在 Windows 凭据管理器）`);
  }
  if (!args.wincred) {
    console.error(`⚠️  未写 Windows 凭据管理器：服务端默认 --secret-store wincred 会读不到这个凭证。`);
    console.error(`    若该服务器确实显式使用 --secret-store file 才可忽略；否则请加 --wincred 重跑。`);
  }

  // 4. 注册 identity.json
  const reg = await updateRegistry(args.registry, {
    frameworkId: args.frameworkId,
    credentialRef: args.credentialRef,
    agentId: args.agentId,
    roleId: args.roleId,
    scopes: args.scopes,
    actions: args.actions,
  });
  console.log(`✅ identity.json 已更新: ${args.registry}`);
  console.log(`   framework=${args.frameworkId}  agent=${args.agentId}  role=${args.roleId}${reg.isNewRole ? "（新 role）" : "（更新已有 role）"}`);

  // 5. 输出配置片段
  console.log(renderSnippets({ frameworkId: args.frameworkId, credentialRef: args.credentialRef, agentId: args.agentId, roleId: args.roleId, url: args.url, secret }));
  console.log(`提示: 服务端默认 --secret-store wincred（读 Windows 凭据管理器）；因此生产接入请带 --wincred。只有服务器显式用 --secret-store file 时才依赖 secret 文件。`);
}

main().catch((e) => {
  console.error(`[onboard-framework] 失败: ${e.message}`);
  process.exit(1);
});
