# memory-lib D17 开发与验收报告

## 交付范围

- Conversation capture 只写脱敏 evidence，并保留 episodes、事件指纹幂等、partial 替换语义；机械 inbox 提取路径已删除。
- 选择兼容方案 (a)：REST/MCP/队列继续接受 `extract`，启动命令继续容忍 `--capture-extract`，但两者均废弃并忽略；响应固定 `candidateCount: 0`、`candidates: []`、`extracted: false`。
- poll capture 的逐事件日志、heartbeat 与 `DONE` 分离报告 `evidence_written`、`candidates_created`；删除含义模糊的 `submitted`，capture 的候选计数恒为 0。
- 新增 `POST /v1/ingest`、`GET /v1/ingest/status` 与 MCP `memory_ingest`。
- 新增 console“采集 / 导入”页：imports 快捷路径、完整参数、preview/confirm、结果与最近审计。
- 文档写入 `evidence/documents/<source>/<filename>-<hash8>.md`，进入 owned index、健康计数与授权搜索。

## 安全与一致性

- `dry_run:true` 默认且除审计外零写；执行要求同 principal、相同业务参数在 30 分钟内完成预览，授权消费一次。
- admin action、`librarian`、`librarian-admin` 可导入任意明确路径；其他身份只可访问解析后位于 `<workspaceRoot>/imports/` 的路径。
- 支持 `.md .txt .json .jsonl .csv .html`。真正包含凭据、私钥或连接串的文件整文件跳过；普通敏感信息在正文中局部脱敏。
- 内容哈希全局幂等；同一路径内容变化保留旧版本，并在新 frontmatter 写入 `prev_hash`、`supersedes`。
- preview、execution、path denial 均审计；审计不记录文件正文或凭据。

## 验收口径

- 服务测试：三文档 preview 零写、执行、重复幂等、内容变更版本链、敏感跳过、路径拒绝、recursive/glob、conversation evidence 路由。
- HTTP 测试：librarian 任意路径、普通身份 imports-only、即时索引搜索、preview/execute/deny 审计；`extract:true` 仍接受但 inbox 不增长。
- MCP 测试：工具清单包含 `memory_ingest`；capture 的 deprecated `extract` 字段通过 schema 和运行时兼容校验，候选结果恒为零。
- Console 测试：extract 默认未选、确认初始禁用、参数变化使预览失效、服务端 path/range、输出转义和审计入口。

## 上线预期

所有 conversation capture 配置下自动 inbox 增长均为 **0**。`extract:true` 和 `--capture-extract` 不再改变行为。显式 `propose`、pet remember 与受治理的导入候选入口仍可写 inbox；`episodes`、consolidator 和 document ingest 索引路径未改变。

本次开发未触碰生产数据，未重启生产服务。
