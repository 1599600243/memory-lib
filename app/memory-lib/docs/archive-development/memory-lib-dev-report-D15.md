# memory-lib D15 开发报告

日期：2026-09-28

## 方向与边界

D15 将记忆流向改为写入全放行、模型主动 typed write、每日及触发式馆务整理。定时 steward 判重批次已由 ops 提交 `24b4ec1` 关闭；本次没有恢复 `--steward-schedule` 或修改 `autostart.cmd`。判重能力保留为手动或馆务按需能力。

## E1 捕获、partial 与质量校准

提交：`81f91a3`

- 文件：`src/conversation-memory.mjs`、`src/extraction-quality.mjs`、`test/extraction-quality.test.mjs`、`test/r10-queue-redaction.test.mjs`、`test/d15-capture-partial.test.mjs`。
- 函数：conversation capture/event fingerprint、partial replacement、`scoreCandidateQuality()`、inbox steward metadata parsing。
- 行为：redacted evidence write-through；机械提取进入 inbox；partial 事件可由完整事件替换；完整事件随后幂等；证据保存 framework/agent/role provenance。
- 真实样本：用户给出的四条技术事实旧分数为 0.4908–0.4973；修正中文词切分并增加技术事实、因果和约束信号后为 0.7248、0.4783、0.7742、0.7702，对照噪声为 0.4713–0.4743。没有整体下调阈值。
- 验证：`node --test test/extraction-quality.test.mjs test/d15-capture-partial.test.mjs test/r10-queue-redaction.test.mjs`。

未完成：尚未获得完整 94 条生产积压文件的脱敏人工标注集，因此校准依据是用户提供的真实摘录加噪声对照，而不是全量生产分布。

## E2 Typed REST/MCP 直写

提交：`5df88a9`

- 文件：`mcp/mcp-server.mjs`、`src/localhost-server.mjs`、`src/memory-lib.mjs`、`src/tools-memory.mjs`、`src/plans-memory.mjs`、`src/project-memory.mjs`、`test/mcp.test.mjs`。
- 函数：typed REST route handlers、MCP `authenticatedWrite()`、tool/plan/project provenance writers、direct proposal validation。
- 行为：复用权威 REST typed endpoints；MCP 镜像相同语义；非空 `evidence_refs`；认证 principal 覆盖请求身份；缺失/unknown 身份 fail-closed；只允许 memory shared/project/agent direct scope。
- 验证：`node --test test/mcp.test.mjs test/d2-memory.test.mjs test/d4-memory.test.mjs`。

未完成：DSH MCP 新身份需要 DSH 重启后生效；用户已实测 project-state 与 tools-memory 真实写入成功，本次没有修改 `cordis.patch.yml`。

## E3 馆务、合并与公平性

提交：`8a2cccb`

- 文件：`src/librarian-batch.mjs`、`src/consolidator.mjs`、`src/steward-batch.mjs`、`test/d15-librarian.test.mjs`、`test/d13-steward-rules.test.mjs`。
- 函数：`createLibrarianBatch()`、`mergeExisting()`、steward candidate selection、`recordStewardAttempt()`、`applyQualityRule()`。
- 行为：consolidate → merge → decay → archive；同 scope、相似度 0.72 合并为新条目，源条目标记 deprecated，不删除；候选按 attempts、importance、最旧尝试时间公平选择；pending-human 退避 24 小时。
- 状态：写入 `steward_attempts`、`steward_last_attempt_at`、`steward_last_outcome`、`steward_status`；旧候选缺字段时按 attempts=0 平滑迁移。
- 质量语义：0.5/0.7 只映射 maintenance/normal/high 整理优先级，不是准入门；direct 为 direct-approved；critical/persona 进入人工处理状态；敏感内容仍 quarantine；身份缺失仍 fail-closed。
- 验证：`node --test test/d15-librarian.test.mjs test/d13-steward-rules.test.mjs test/d6-steward.test.mjs`。

未完成：尚未在重启后的生产服务连续观察 3–4 次手动/馆务批次；用户计划用独立批次复核 input/decision 覆盖率。

## E4 巩固器独立日程

提交：`7c7664a`

- 文件：`src/consolidation-scheduler.mjs`、`test/d15-scheduler.test.mjs`；CLI/服务入口位于 E6 提交中的 `server.mjs` 及 E2 提交中的 `src/localhost-server.mjs`。
- 函数：`createConsolidationScheduler()`、server consolidation principal resolution。
- 行为：独立 consolidation schedule，默认每日间隔；触发 metadata 明确；启用时必须从 registry 唯一解析 `admin-01/librarian-admin`，否则启动失败。
- 验证：`node --test test/d15-scheduler.test.mjs test/d15-librarian.test.mjs`。

未完成：当前 autostart 未声明 `--consolidation-schedule`；何时在生产启用每日馆务需要 ops 单独确认。没有恢复 steward schedule。

## E5 检索折叠与质量排序

提交：`6db4a9a`；核心检索实现包含在 E2 提交 `5df88a9` 的 `src/memory-lib.mjs`。

- 文件：`src/memory-lib.mjs`、`test/d7-ranking.test.mjs`。
- 行为：授权过滤后按 canonical shared/project/agent/profile scope 同族折叠；evidence lane 不折叠；quality 是 ranking/maintenance 因子，不是写入门。
- 验证：`node --test test/d7-ranking.test.mjs test/contract.test.mjs`；全套 zero-write 测试通过。

未完成：无已知实现缺口；仍需由生产检索流量观察折叠效果。

## E6 批次参数与可观测性

提交：`2d7d9ec`

- 文件：`server.mjs`、`test/d6-steward.test.mjs`、`scripts/run-tests.mjs`、`scripts/generate-d15-e6-artifact.mjs`、`artifacts/d15-e6-scheduled-batch-15.json`、`artifacts/d15-e6-scheduled-batch-15-runtime.json`。
- 行为：`batchSize` 与 per-run limit 取较小值；batch 返回 candidate/valid/missing decision coverage；持久验收工件记录 batch metadata 和 runtime log。
- 产物：`artifacts/d15-e6-scheduled-batch-15.json`。
- runtime run_id：`run-d15-e6-scheduled-batch-15`。
- 产物值：`batch_size=15`、`input_count=15`、`processed=15`、`valid_decision_count=15`、`status=completed`。
- 验证：`node scripts/generate-d15-e6-artifact.mjs`；`node --test test/d6-steward.test.mjs`。

未完成：用户将运行 `node scripts/agent.mjs --agent steward --once --limit 15 --trigger d15-e6-recheck` 做独立生产数据复核。定时 steward 已取消，本地 scheduled artifact 只证明参数和观测接线，不表示生产定时任务仍启用。

## 文档与总体验证

文档提交：`bc2b95a`。

- `docs/openapi.yaml` 补齐 typed write routes 与 required `evidence_refs`。
- `docs/protocol.md` 更新 write-through/direct write 协议。
- `node scripts/run-tests.mjs`：ALL TEST FILES PASSED。
- 最终定向质量与 steward 测试：37/37 通过。
- `node --check`：关键 server/MCP/memory 模块通过。
- `git diff --check`：通过，仅有 Git 的 LF→CRLF 工作区提示。

## D15.1 / E3.6 接受修复

提交：`87a9a2e`（`fix: broaden D15 librarian inventory and retirement`）。

- 覆盖全库维护范围：`curated/shared`、`curated/agents`、`project-state`、`tools-memory`、`plans`、`profile`、`episodes` 与 `inbox`；历史文件缺失 `layer` 时按目录归属兼容扫描。
- 维护结果：librarian 返回 `merged`、`superseded`、`deprecated`、`staled`、`archived`，并返回 `inventory_before`、`inventory_after` 与 `compression`（input/retired/produced/visible_delta）；`/v1/health` 暴露最近一次维护结果。
- 不物理删除：低质量、低召回且超过保留期的条目移动到 `_legacy-YYYY-MM-DD`，保留可恢复文件真相；`walkFiles()` 不检索 `_legacy-*`。
- typed 层保护：tools/plans/profile 不写入错误的 generic semantic schema；保留 typed 代表文件格式，把重复源标记为 `deprecated`。semantic 层合并主体采用最长源正文，尚未做模型摘要。
- 合并审计：每个 merge family 记录 source IDs、target ID、相似度、阈值和 basis；归档也单独记录 source/target/reason/recallCount。审计字段保持非 merge 日志的兼容形状。
- 队列与权限：admin inbox 支持 `importance`、`steward_status`、`review_state` 过滤；profile confirm 要求 admin 及已绑定的 `evidence_refs`；capture/complete 与 MCP/REST 保持 partial/replay 语义一致；`--steward-schedule` 继续硬禁用。
- 修复的回归：旧 admin inbox 根路径契约、审计白名单、跨通道 capture replay。提交后全套测试通过：`node scripts/run-tests.mjs`，所有测试文件通过。
- 关键验证命令：`node --check src/admin.mjs; node --check src/consolidator.mjs; node --check src/archive-memory.mjs; node --check src/librarian-batch.mjs; node --check src/localhost-server.mjs; node --check mcp/mcp-server.mjs; git diff --check`。

artifact/run_id：复用 D15 E6 工件 `artifacts/d15-e6-scheduled-batch-15.json` / `run-d15-e6-scheduled-batch-15`；本次维护代码变更没有伪造新的生产 run_id。

仍未完成：尚未在重启后的生产服务连续观察 3–4 次手动/馆务批次；尚未获得完整 94 条生产积压文件的脱敏人工标注集；尚未对真实生产库执行本轮物理归档或提交新的生产维护 artifact。定时 steward 仍关闭，E3.6 维护仅能由手动/馆务路径触发。

## D15.2 馆员职责升级（进行中）

本轮已完成第一阶段代码切片：

- 新增 `src/cold-layer.mjs`：正式层 active → `_cold-YYYY-MM-DD`，写入 `status: cold`、`cold_since`、`cold_reason`、`cold_original_path`；文件保留可恢复，逐项审计；高召回旧条目进入 `refresh_candidates` 而不下沉。
- 新增 `src/maintenance-scheduler.mjs`：daily/monthly 独立触发、周期幂等、非重入、`runtime/maintenance/<run_id>.json` 报表持久化。
- librarian 已接入 recall pending 更新、cold 阶段、run_id/起止时间/耗时、借阅 Top N、零召回数、凭证缺失清单；server 已接入 admin `POST /v1/admin/maintenance/run` 和 daily 调度路径。
- 新增 `src/memory-version.mjs`：版本/同事实判断同时考虑相似度、evidence/source 计数、时间，并输出可审计的判定依据。
- 新增显式 cold refresh：恢复原逻辑路径，保留旧凭证并合并新 evidence/source，写入 `refreshed_at`/`refresh_reason`，逐项审计；admin 可通过 `POST /v1/admin/maintenance/refresh` 按 ID 触发。
- 删除政策已落地：馆员只下沉不删除；独立 `purge` 仅接受显式 cold ids，默认 dry-run，要求先预览、备份可用和 admin/librarian 身份，逐项记录删除审计。REST 与 MCP 入口统一为 `/v1/admin/maintenance/purge` / `admin_maintenance_purge`。
- 普通检索已排除 `status: cold`；cold-layer 和 maintenance 单测已覆盖下沉、恢复、翻新、高召回保护、双周期幂等。

本阶段验证：`node --test test/d15-2-cold-layer.test.mjs test/d15-2-maintenance.test.mjs test/d15-2-version.test.mjs test/d15-librarian.test.mjs test/admin.test.mjs`，通过。

仍未完成：daily/monthly 尚未在生产启动参数中启用；物理清理保持独立用户驱动且默认关闭。

## D15.3 / D15.4 P0 安全收口

日期：2026-09-29

- 自动合并从单链传递改为保守 clique：先取相似度连通分量，再计算分量内全部成对相似度；只要 `min_pairwise < threshold`，整簇不动并写入 `chained_clusters`。不会再只合并链中的一个小团。
- typed 层门槛为 0.95；已标注 genre 不同的文档/计划不混合。自动合并簇最多 5 条；超限簇、正文 >10,000 字、正文长度比 >2 倍均只报告不合并。
- 合并审计包含 `cluster_size`、`min_pairwise`、`max_pairwise`、`clustering=complete-link-clique` 与 `protection`。`runtime/maintenance/<run_id>.json` 持久化完整 `chained_clusters`、`oversized_clusters`。
- P0-6 已撤销：`borrowed_top` 的正式结构保持 `{ path, count }`，未改名。
- 时间读取统一到 `src/time-util.mjs`：`updatedAt` → `updated_at` → `createdAt` → `created_at` → `occurred_at` → `occurredAt` → mtime。cold、archive、decay、版本比较与维护排序复用该接口。
- cold 报表新增 `cold_skipped`：`not_expired`、`high_recall`、`unparsable_time`、`missing_id`。即使 `cold_added=0`，报表也能解释原因。
- 冷层取回走显式接口：`lib.get(id, { include_cold: true })`、REST `/v1/get` 或 MCP `memory_get` 的 `include_cold=true`；默认 `lib.search()` 返回数组且不扫描 `_cold-*`。取回 item 保留 `cold_since`、`cold_reason`、`cold_original_path`。
- 所有验证均使用 `os.tmpdir()` 隔离 fixture；未访问或运行 `I:\OpenClaw\memory-data\memory` 的维护任务。
