# memory-lib D29 架构

## 目标

memory-lib 是独立的 loopback 服务，文件是真相，SQLite/向量是可重建派生索引。D29 将持久化写入统一为服务端授权后的直接目标层写入，不再提供 candidate/inbox/review/promote 流程。

## 关键边界

- 服务只绑定 `127.0.0.1`；凭证、framework、agent、role 和 scope 由服务端解析与校验。
- `POST /v1/write` 与 MCP `memory_write` 直接写入一个明确 D29 层，每次写入要求非空 `evidence_refs`。
- 对话原文只进入 `evidence/conversations`，不进入默认检索根；长期内容必须单独通过直接写入保存。
- `learning/**` 由独立学习助手管理，物理保留但不进入 memory-lib 的 health roots、index 或 search。
- 新写文件在派生索引刷新前由 bounded file-first 词法补差保证可见。
- graph、knowledge quarantine、candidate inbox、review/promote 不是 D29 活跃能力；`docs/graph-design.md` 仅作未完成历史设计记录。

## 可检索根

`curated/shared`、`curated/agents`、`project-state`、`tools-memory`、`plans`、`profile`、`evidence/documents`。对话证据、learning、archives、runtime 和 live tools 均排除。
