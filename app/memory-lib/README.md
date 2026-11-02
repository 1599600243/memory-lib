# memory-lib（D29）

独立运行在 `127.0.0.1:8787` 的本地记忆服务。文件是真相，SQLite/向量是可重建派生索引；身份、scope、action 和审计由服务端统一执行。

## 当前协议

所有正式持久化写入均走零模型直接写入：HTTP `POST /v1/write` 或 MCP `memory_write`。支持层：`curated-shared`、`agent`、`project-state`、`project-decision`、`project-progress`、`tool`、`plan`、`profile`、`document`。每次写入必须提供非空 `evidence_refs`。

对话捕获只保存脱敏原文到 `evidence/conversations`，该路径是 storage-only，不进入默认检索。需要长期保存的内容由对话模型直接选择目标层并写入。学习助手的 `learning/**` 文件物理保留，但不属于 memory-lib 的检索根。

D29 不提供 candidate/inbox、模型提炼队列、review/promote、knowledge quarantine、episode 或 graph 生产工作流。

## 框架声明白名单

框架条目可选配置 `claim_allowlist` 字符串数组，约束该凭证可声明的 `agent_id/role_id`。规则格式为 `agent/role`；每段中的 `*` 可匹配任意字符，例如 `agent/*`、`*/reader`、`qq-*/chat-reader` 或 `*/*`。规则必须恰有一个 `/` 且两段非空；非法项会忽略。未配置、非数组或空数组时白名单关闭，保持既有身份解析行为。

## 外部来源可见性不变量

精炼提交若引用的证据来源为 `napcat-*`、`napcat:*`、`qq-*` 或 `qq:*`，不可将记忆写成 `shared` 或 `platform` 可见性；违规会以 `EXTERNAL_SOURCE_VISIBILITY_DENIED` 拒绝，且在写入任何结论前完成检查。个人及其它非共享可见性不受此规则影响。

只读巡检可运行：`node memory-lib/scripts/scan-external-visibility.mjs --data-root D:\\MemoryLib\\data\\memory`。脚本默认扫描该目录下 curated 与 project-* 记忆，并报告扫描数、命中数及命中文件/id。

## 来源可信度

正式记忆写入会根据 `evidence_refs` 写入 `source_trust`：可识别的 `napcat-*`、`napcat:*`、`qq-*`、`qq:*` 来源为 `external`，其余（包括缺失或不可解析的引用）为 `internal`。`/v1/memory/list`、`/v1/memory/find` 与 `/v1/search` 的每条结果透出该字段；历史文件未迁移，缺少该字段时返回 `unknown`。

## 可检索根

`curated/shared`、`curated/agents`、`project-state`、`tools-memory`、`plans`、`profile`、`evidence/documents`。

`evidence/conversations`、learning、archives、runtime 和 live tools 均排除。新写入在派生索引刷新前由 bounded file-first 词法补差保持可见。

## 目录

- `src/`：核心服务、检索、写入和身份授权
- `mcp/`：MCP 转发适配器
- `adapters/`：薄捕获适配器参考实现
- `test/`：当前 D29 及基础设施回归测试
- `docs/`：当前协议、架构、运维和接入文档
- `docs/archive-acceptance/`：历史验收记录
- `docs/archive-development/`：历史开发报告

## 启动

```powershell
node server.mjs --host 127.0.0.1 --port 8787 `
  --data-root I:\OpenClaw\memory-data\memory `
  --workspace-root I:\OpenClaw\memory-data `
  --registry I:\OpenClaw\memory-data\runtime\identity.json `
  --secrets-dir I:\OpenClaw\memory-data\runtime\secrets `
  --audit I:\OpenClaw\memory-data\runtime\audit\access.jsonl `
  --secret-store wincred --summary-index none
```

## 验证

```powershell
node --check src/memory-lib.mjs
node --check src/localhost-server.mjs
node --check mcp/mcp-server.mjs
node scripts/run-tests.mjs
```

当前实现和接入规则见 `docs/protocol.md`、`docs/onboarding.md`、`docs/operations.md` 与 `docs/architecture.md`。历史文档只作为记录，不是当前实现指令。
