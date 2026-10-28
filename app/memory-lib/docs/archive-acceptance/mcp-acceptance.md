# MCP adapter 验收报告

日期：2026-08-22（本会话）
状态：**全部通过（handler 11/11 + 集成冒烟成功）**

## 交付内容

1. **`mcp/mcp-server.mjs`**：零依赖 stdio JSON-RPC MCP 服务器
   - 协议：initialize / notifications / ping / tools/list / tools/call（含标准错误码 -32700/-32600/-32601/-32602）
   - 工具：`memory_search` / `memory_get` / `memory_propose` / `memory_health`
   - 身份：环境变量（`MCP_MEMORY_CRED_REF` / `MCP_MEMORY_SECRET` 或 `MCP_MEMORY_SECRET_FILE` / `MCP_MEMORY_AGENT` / `MCP_MEMORY_ROLE`），**永不来自客户端输入**
   - 授权：完全在 core 侧执行（MCP 只转发），越权调用原样返回错误
2. **`mcp/README.md`**：Claude Desktop / Cursor 配置示例 + 环境变量说明 + 自测命令

## 测试结果

| 项 | 结果 |
|---|---|
| handler 单元测试（进程内 core） | ✅ **11/11**：initialize / 通知无响应 / ping / 工具列表（4 工具）/ search 命中 / get / **reader 调 propose → isError（core 拒绝）** / researcher 调 propose → 成功 / 缺 content → 报错 / 未知工具 -32602 / 未知方法 -32601 |
| 集成冒烟（连运行中 8787 core，生产数据） | ✅ initialize → tools/list（4 工具带 schema）→ memory_search "memory" 命中生产 curated/shared（2 条）→ memory_health healthy |

> 注：本环境 pwsh 直通 node 的管道有沙箱怪癖（无输出），改用 `cmd /c ... < input` 输入重定向验证通过；真实 MCP 客户端（Claude/Cursor）用原生 stdio 管道启动，不受影响。

## 修复记录

- `toolResult(id, isError, text)` 参数顺序曾被传反（成功返回 isError=true）——已修正为 `r.status !== 200`，测试覆盖成功/失败两态

## 意义

「凭身份访问」愿景的**最后一块拼图**到位：Claude、Cursor 等任何 MCP 客户端凭 credential 即可搜索/读取/提议记忆库，权限仍由 core 统一治理，全程审计。未来接其他框架 = 注册 framework + agent + role，零改 core。

## 使用

见 `mcp/README.md`（Claude Desktop / Cursor 配置）。前提：core 在跑（`node server.mjs`）。
