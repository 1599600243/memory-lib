# memory-lib D14 开发报告

日期：2026-09-28

## 目标

修复 D13 在 production Ollama/qwen3:4b 上因 thinking 耗尽输出预算导致的空决策批次，并确保空决策不会伪装成 completed pending。`num_ctx` 不是本次主因，但继续显式配置以容纳批次输入。

## D14.1

- steward 默认批次限制为 5，可由 `batchSize` 配置；CLI 默认从 steward 配置读取。
- 近邻检索和发送 payload 均限制为 top-3。
- 候选与近邻正文均截断为 300 字符。
- steward 提示词改为短中文关系分类说明和一个示例。
- Ollama 使用原生 `/api/chat` bridge，将 `numCtx` 转为 `options.num_ctx`，将 `maxOutputTokens` 转为 `options.num_predict`。OpenAI-compatible endpoint 在本机 Ollama 0.33.2 上实际保持 4096 context，不能作为预算设置通道。
- 默认 production 配置：`numCtx=8192`、`maxOutputTokens=6144`、`batchSize=5`、`contentChars=300`、`neighborTopK=3`。
- 运行记录和 batch 结果记录 `prompt_chars`、token 估算、实际 input/output tokens、finish reason、预算和有限 output preview。
- batch 结果保留 `quality.score`，并增加字面 `quality_score`。

## D14.2

- 非空候选批次收到零条有效 relation 时，只进行一次纠正请求。
- 第二次仍为空则抛出 `model returned empty decisions (batch of N)`，runtime 与 batch 都返回 failed 语义和 runtime ID。
- 部分输出仍按 D13 规则保留有效项，缺失单项可 pending；只有整批零有效决策 fail-closed。

## D14.3 验收

- 五案例真实 qwen3:4b relation 最终验证：5/5，单次调用；run ID `run-a5668ca4-79cd-4177-8a6c-85ce812a7c9c`。
- 三候选 production batch：`status=completed`、`processed=3`、`promoted=1`、`pendingHuman=2`。两条 pending 是既有 quality gate，三条均有 `relation=neither`，不是模型缺失结论。run ID `run-b012b46e-959d-4de9-8746-24ec8f350c95`。
- 该批 telemetry：`batch_size=3`、`model_calls=2`、`prompt_chars=3688`、`prompt_token_estimate=1230`、`actual_input_tokens=1232`、`num_ctx=8192`、`max_output_tokens=6144`。
- `ollama ps` 在 native bridge 请求期间显示 qwen3:4b 实际 CONTEXT=8192。
- 两次连续完整 `npm test` 均输出 `ALL TEST FILES PASSED`。
- 对 `curated/shared`、`project-state`、`tools-memory`、`plans`、`profile`、`evidence/conversations` 共 1194 个文件按 root 独立做前后快照；health/search/get 后结果为 `ZERO_WRITE_OK`。
- 全 workspace 的辅助检查观察到并发 Gateway 写 `runtime/audit/access.jsonl`；该 runtime 审计写入不属于 search 业务树，独立业务树复验无变化。
- 调度器 `OpenClaw Agent Memory Reconciler` 保持 Disabled。
- DSH 默认模型保持 `gpt-5.6-sol`。
- 没有新增 cloud key，也没有重启 DSH。

## D14 补充验收

- 移除 system prompt 和 final user message 中的 `/no_think`；不依赖 `think:false`，保留 qwen3 正常 thinking。
- Ollama native bridge 现在转发 OpenAI-compatible tools schema，并将 native `message.tool_calls` 转回 AI SDK 可识别的工具调用；steward production 配置启用 `toolCalling:true`。
- tool choice 使用 `auto`，避免 AI SDK 的 required-tool 校验遮蔽原生 `done_reason=length`；业务层仍只接受 `submit_decisions`，空结果仍只纠正一次并 fail-closed。
- 空决策错误现在包含 `finish_reason`，runtime 与 batch 的成功/失败结果及日志都记录 `actual_output_tokens` 和 `finish_reason`。
- 对照失败证据：同一 5 条真实候选走纯文本路径时，`num_ctx=8192`、`num_predict=6144` 仍耗尽 6144 output tokens，`finish_reason=length`、0 决策；run ID `run-b280e84f-f12b-4074-88e5-17a0ad5814c3`。
- 原生工具探针确认本机 qwen3:4b 返回 `message.tool_calls` 且 native `done_reason=stop`。
- 最终 5 条真实候选：`processed=5`、decisions/results=5、`promoted=3`、`quarantined=2`、`failed=0`；每条都携带 3 个真实 `neighbor_ids`、字面 `quality_score` 和嵌套 `quality.score`。run ID `run-f99903cf-7245-44d4-afc0-335b1946f270`。
- 最终批次 telemetry：`prompt_chars=3523`、`prompt_token_estimate=1175`、`actual_input_tokens=1623`、`actual_output_tokens=6115`、`num_ctx=8192`、`num_predict/max_output_tokens=6144`、AI SDK `finish_reason=tool-calls`（对应 Ollama native `done_reason=stop`）。该批先纠正一次后提交唯一一次 `submit_decisions`，故 `model_calls=2`、工具调用数=1。
- native tools 路径五案例判别为 5/5，单次模型调用；run ID `run-7d81cd2f-9fa2-497f-89df-6c39fd04160f`。
- 补充变更后两次连续完整 `npm test` 均输出 `ALL TEST FILES PASSED`。
- 补充零写检查覆盖 1201 个 production 业务文件，health/search/get 前后为 `ZERO_WRITE_OK`。

## D14b 第二轮追加验收

### 五候选稳定策略

- production 治理批次保持 `batchSize=5`，新增 `decisionChunkSize=3`；runtime 将五候选内部拆为 3+2 两次 qwen3:4b 分类，再合并为一个父 run。未使用 `/no_think`、`think:false`，也未降低 batch size。
- 每个分片独立执行原有一次纠正上限；任一分片两次空/无效会令父 run failed，只有所有候选都有合法决策才 completed。
- 父 run 累加 token、model/tool calls，记录 child run IDs 和每片 telemetry；全部 native 分片成功时父 `finish_reason=stop`。
- CLI 新增 `--trigger`，复现命令：`node scripts/agent.mjs --agent steward --once --limit 5 --trigger d14b-five-candidates`。

### 身份与关系治理

- `promote()` 在任何长期存储写入前校验 `framework_id`、`agent_id/agentId`、`role_id`、`proposedBy`、`ownerId`；缺失、空白或包含 unknown 时抛出 `INVALID_CANDIDATE_IDENTITY`，原候选留在 inbox。
- steward 在 review/promote 前执行同样预检，返回 `pending-human / identity-invalid` 和显式原因，不把无效身份先改为 reviewed。
- batch 只处理 pending 候选，ordinary/important/critical 按治理风险排序，同级保持稳定顺序；已 rejected/quarantined 不重复送模。
- 输出继续保留字面 `quality_score`、`quality.score`、`quality.band`；关系只接受 `duplicate|contradict|neither`，neither 的 target 必须 null，其他 target 必须来自该候选 neighbors。

### 验收污染清理

- 正式层盘点并 deprecated 5 条，原文件均保留：`shared-1dc442ae`（D13）、`project-d-ai-deepseek-harness-agentgongz-d413fb5c`（D14）、`shared-26998bae` 与 `shared-6a812420`（D5 acceptance probe）、`project-pilot-dca8d276`（Slice 1-3 验收闭环）。
- inbox 中 `source=d13-production-acceptance` 1 条、`source=d14-production-acceptance` 2 条移入 `I:\OpenClaw\memory-data\memory\inbox\_legacy-d14b-20260928`，无文件删除。
- semantic index 对上述 5 个正式 ID 为 0；graph 增量构建修正为排除 deprecated/superseded，并清理旧残留节点、边和 file_index，目标残留为 0。
- normal search 对 D13、D14、D5 probe、Slice 验收查询均无上述 ID 命中。

### 唯一真实模型批次

- 命令：`node scripts/agent.mjs --agent steward --once --limit 5 --trigger d14b-five-candidates`。
- 父 run：`run-b120f3f9-b465-4c51-9225-72eedd7de105`；`input_count=5`、`output_count=5`、`model_calls=2`、`finish_reason=stop`、`promoted=1`、`failed=0`。
- 两个 child run：`run-65bd9570-60c1-4dd4-bc48-5f60b3874bc7`（3 条）和 `run-248abfce-03dd-4056-8a00-9b40d7621332`（2 条），均一次 native tool submission。
- 父 artifact：`I:\OpenClaw\memory-data\memory\runtime\agents\steward\run-b120f3f9-b465-4c51-9225-72eedd7de105.json`。
- batch artifact：`I:\OpenClaw\memory-data\memory\runtime\steward\2026-09-28T15-45-07-780Z-304f239b.json`。
- 程序化断言确认 5 decisions、至少 1 promoted、关系枚举、target membership、neither-null 和两种 quality 表示全部通过。

### 最终验证

- 修正 fixtures 后连续两次完整 `npm test` 均输出 `ALL TEST FILES PASSED`，两轮之间无代码修改。
- strict production zero-write：对 `curated`、`project-state`、`tools-memory`、`plans`、`profile`、`evidence/conversations`、`inbox` 共 7 roots / 2595 文件执行 health/search/get 前后 SHA-256 对比，0 changes，`ZERO_WRITE_OK`。
- `OpenClaw Agent Memory Reconciler` 保持 Disabled；`C:\Users\admin\.dsh\settings.yaml` 默认模型保持 `gpt-5.6-sol`；未修改 identity、端口、DSH 或用户验收脚本，未重启 DSH。

## 环境记录

此前 CUDA OOM 来自 ToDesk 消耗系统 commit；退出 ToDesk 后系统 commit 恢复，模型可正常加载。本次没有修改该环境问题。

## 提交

- `0a38131 D14.1: bound steward context and model budgets`
- `386c5fa D14.2: fail closed on empty steward decisions`
- `757768f D14.3: harden Ollama steward production path`
- `565a50a D14.4: preserve Ollama tool decisions and diagnostics`
- D14b 第二轮追加验收提交：五候选 3+2 分片、身份 fail-closed、inactive graph 清理、验收污染清理与 production artifacts。
