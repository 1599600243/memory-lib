# D29 接入清单

memory-lib 是框架无关的本地记忆服务。客户端注册身份后，通过 MCP 或 REST 使用同一套身份、scope、action 和审计链。D29 不使用 candidate/inbox/review/promote 工作流。

## 接入步骤

1. 在运行时注册 framework、agent、role、scope 和所需 action，并把 secret 放入受支持的凭据存储。
2. 配置 MCP 或 REST 客户端连接 `http://127.0.0.1:8787`，提交 credential reference、secret 和 principal。
3. 安装 `C:\Users\admin\.dsh\skills\automatic-memory-capture\SKILL.md`（或等价的 D29 捕获规范）。
4. 每轮通过 conversation capture 保存脱敏原文证据；需要持久化的内容由对话模型直接调用 `memory_write` 或 `POST /v1/write` 写入目标层。
5. 为每个直接写入提供非空 `evidence_refs`，并验证响应中的 layer、path、create/update 和 index 状态。

## D29 目标层

`curated-shared`、`agent`、`project-state`、`project-decision`、`project-progress`、`tool`、`plan`、`profile`、`document`。`evidence/conversations` 仅保存原文，不属于普通检索；`learning/**` 是独立学习助手存储，不进入 memory-lib 检索。

## MCP 配置示例

```yaml
serverName: memory
transport: streamable-http
url: http://127.0.0.1:8787/mcp
headers:
  X-MCP-Credential-Ref: memory-lib/my-app
  X-MCP-Secret: <secret>
  X-MCP-Agent: app-agent-01
  X-MCP-Role: researcher
```

优先使用 `memory_search`、`memory_list`、`memory_get`、`memory_health`、`memory_write`、`memory_capture_conversation` 和 `memory_capture_complete`。客户端不得实现第二套提炼、去重或治理，也不得调用已删除的 proposal、inbox、review、promote 接口。

## REST 写入示例

```json
{
  "layer": "curated-shared",
  "id": "decision-example",
  "body": "这里是经过确认的长期事实。",
  "tags": ["example"],
  "evidence_refs": ["evidence:conversation-id"],
  "principal": {"agent_id": "app-agent-01", "role_id": "researcher"}
}
```

发送到 `POST /v1/write`。项目进度使用 `layer: "project-progress"`、project 和六个规范 topic；相同日期与正文会去重并合并证据引用。

## 最小验收

- 重复提交相同 capture event 得到去重结果，不产生第二份 evidence。
- capture 原文落在 `evidence/conversations`，且默认 search 不返回该路径。
- 直接写入立即返回正式目标路径；索引尚未刷新时 file-first 仍能检索。
- reader 等无写权限身份得到拒绝；允许身份通过 action、scope、证据引用校验。
- 健康检查为 healthy，learning 文件保持不变且不出现在 memory-lib roots。
- 不以恢复旧 propose/inbox/review/promote API 作为兼容方案。
