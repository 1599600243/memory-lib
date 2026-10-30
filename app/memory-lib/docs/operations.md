# D29 运维手册

## 运行边界

memory-lib 只绑定 `127.0.0.1:8787`。文件是真相，SQLite/向量是可重建派生索引。生产启动参数、WinCred、registry、审计路径和 loopback 绑定不得改变。

## 健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/health | ConvertTo-Json -Depth 20
```

重点检查 `library_files`、`indexed_files`、`pending_changes`、`failed` 与 vector 状态。`evidence/conversations`、learning、archives、runtime 和 live tools 不属于检索或索引根。

## D29 写入与捕获

- 正式记忆只能通过 `POST /v1/write` 或 MCP `memory_write` 直接写入目标层。
- 每次写入都要有非空 `evidence_refs`，服务端负责身份、scope、字段校验、幂等与审计。
- 对话捕获只保存脱敏原文到 `evidence/conversations`，不创建候选、不触发模型提炼、不进入普通检索。
- 需要长期保存的事实、决定、偏好、任务由对话模型单独调用 `memory_write`。
- learning 文件由独立学习助手管理，不要将其导入 memory-lib 检索根。
- 文档导入先 `dry_run`，再用完全相同参数执行，目标是 `evidence/documents`。

## 索引维护

索引损坏或配置变更时，使用仓库既有 index 脚本重建；不要手工写 SQLite。直接写入在刷新完成前由 file-first 补差可见。验证完成后确认 `pending_changes=0` 且 `failed=0`。

## 凭证与审计

凭证由 registry 反解 framework，再校验 agent、role、scope 和 action。secret 不进 URL、日志或审计；审计记录请求结果与 credential fingerprint。默认使用 WinCred，file store 只有显式配置时启用。

## 已退役能力

candidate/inbox、proposal、review/promote、knowledge quarantine、auto-review 和图谱生产工作流不属于 D29。不要恢复已删除路由、管理队列或兼容 shim；历史验收和开发报告只保存在 `docs/archive-*`。

## 变更验证

```powershell
node --check src/memory-lib.mjs
node --check src/localhost-server.mjs
node --check mcp/mcp-server.mjs
node scripts/run-tests.mjs
```

生产重启后重新获取完整 `/v1/health`，并用授权 MCP 客户端对 D29 关键查询做前后路径对比。
