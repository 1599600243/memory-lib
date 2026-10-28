# MCP adapter —— 让 Claude / Cursor 等凭身份直连记忆库

零依赖的 stdio MCP 服务器，把记忆核心（127.0.0.1 HTTP）暴露为标准 MCP 工具。
**授权永远在 core 侧**：MCP 服务器不决定访问权，它只转发机器身份（credential_ref + secret + agent/role）或同一 REST 使用的 `Authorization: Bearer <session>`。

## 工具

| 工具 | 说明 | 对应 core API |
|---|---|---|
| `memory_search` | 授权范围内搜索（query, limit） | POST /v1/search |
| `memory_get` | 按 id 读正式记忆 | POST /v1/get |
| `memory_write` | 直接写入 D29 目标层（`evidence_refs` 必填；可选 `visibility`: `platform/shared/user/private/role/agent/project/daily`，省略保持当前默认；归属始终取认证 principal，`platform` 需要 admin 权限） | POST /v1/write |
| `memory_health` | 健康状态 | GET /v1/health |
| `memory_refinement_pending` | 读取授权范围内待精炼对话证据 | POST /v1/refinement/pending |
| `learning_review_get` | 到期复习项（`topic` 可省略；省略=聚合全部学习主题，按 `next_due` 升序） | POST /v1/learning/review_get |

> 上表为常用工具；完整工具清单（47 个）见 `mcp/mcp-server.mjs` 的 `TOOLS`，或 MCP `tools/list`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MCP_MEMORY_URL` | `http://127.0.0.1:8787` | core 服务地址 |
| `MCP_MEMORY_CRED_REF` | `memory-lib/deepseek-harness` | 凭证编号 |
| `MCP_MEMORY_SECRET` | — | 密钥（优先于文件） |
| `MCP_MEMORY_SECRET_FILE` | — | **推荐**：密钥文件路径（避免进环境/命令行） |
| `MCP_MEMORY_AGENT` | `pilot-01` | 身份 |
| `MCP_MEMORY_ROLE` | `researcher` | 机器凭证角色（reader/researcher/…）；使用 session 时可省略机器身份变量 |
| `MCP_MEMORY_TOKEN` | — | 可选：现有 `/v1/auth/login` 返回的 Bearer session token；优先于机器凭证 |

## 使用前提

1. core 服务在跑：`node server.mjs`（或双击 `start-console.cmd` / 开机自启任务 `memory-lib-core`）
2. 身份已在注册表（生产：`I:\OpenClaw\memory-data\runtime\identity.json`），secret 文件在位（生产：`I:\OpenClaw\memory-data\runtime\secrets\`）

## Claude Desktop 接入（claude_desktop_config.json）

```json
{
  "mcpServers": {
    "memory-lib": {
      "command": "node",
      "args": ["D:\\AI\\deepseek-harness\\agentgongz\\memory-lib\\mcp\\mcp-server.mjs"],
      "env": {
        "MCP_MEMORY_URL": "http://127.0.0.1:8787",
        "MCP_MEMORY_CRED_REF": "memory-lib/deepseek-harness",
        "MCP_MEMORY_SECRET_FILE": "I:\\OpenClaw\\memory-data\\runtime\\secrets\\memory-lib_deepseek-harness.secret",
        "MCP_MEMORY_AGENT": "pilot-01",
        "MCP_MEMORY_ROLE": "researcher"
      }
    }
  }
}
```

## Cursor 接入（.cursor/mcp.json 或项目级配置）

```json
{
  "mcpServers": {
    "memory-lib": {
      "command": "node",
      "args": ["D:\\AI\\deepseek-harness\\agentgongz\\memory-lib\\mcp\\mcp-server.mjs"],
      "env": {
        "MCP_MEMORY_SECRET_FILE": "I:\\OpenClaw\\memory-data\\runtime\\secrets\\memory-lib_deepseek-harness.secret",
        "MCP_MEMORY_ROLE": "researcher"
      }
    }
  }
}
```

## 命令行自测

```powershell
# 先确保 core 在跑（node server.mjs）
$env:MCP_MEMORY_SECRET_FILE = "D:\AI\deepseek-harness\agentgongz\memory-lib\runtime\secrets\memory-lib_deepseek-harness.secret"
$env:MCP_MEMORY_ROLE = "researcher"
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | Out-File "$env:TEMP\mcp-in.jsonl" -Encoding utf8
cmd /c "node mcp\mcp-server.mjs < %TEMP%\mcp-in.jsonl"
```

## 安全

- 只连 127.0.0.1（core 强制回环）；身份不出现在 URL/日志/审计
- 密钥优先走文件（SECRET_FILE），不进命令行
- 越权调用由 core 拒绝（如无写权限身份调用 memory_write → isError），MCP 原样返回错误
- 每个工具调用在 core 审计留痕
