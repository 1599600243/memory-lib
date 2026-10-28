# Memory-lib D12 开发报告

日期：2026-09-27

范围：D12.1–D12.5 steward 模型能力、工具输入协议、单次提交、长期晋升与失败运行审计。

## 实现

- D12.1：steward 默认模型改为 `ollama/qwen3:4b`；能力声明为 `toolCalling:true`、`structuredOutput:false`、`jsonMode:true`。DSH 主模型路由保持 `gpt-5.6-sol`，scheduler 保持 Disabled。
- D12.2：AI SDK v7 工具调用读取 `toolCalls[i].input`，保留工具执行结果作为兼容 fallback；增加严格 bounded map、`candidate_id`、compact decision lines 归一化，并保留普通 runtime 的 fail-closed contract。
- D12.3：steward 使用 `stepCountIs(1)`，每次 runtime 首次提交最多一个 tool step；协议失败时在同一模型实例上进行有限 JSON-only 文本恢复。
- D12.4：普通、非 critical、非 persona 且 `qualityScore >= 0.7` 的 `ADD` 继续经过既有 `review(approve) -> promote` 链路；新增相似度、极性、模糊候选和主题补召回治理，防止明显重复/矛盾候选误入 ADD。
- D12.5：成功与失败均返回 `model_calls`、`runtime_run_id`、`log_path`；失败日志保留脱敏后的 runtime 链接和实际调用次数。

## 模型能力矩阵

| 模型 | tool calling | structured schema | JSON mode | 观测耗时 |
|---|---:|---:|---:|---:|
| qwen3:4b | yes | no | yes | ~65.7s |
| qwen3-vl:4b | yes | no | yes | ~66.3s |
| qwen3:latest | yes | no | yes | ~73.4s |
| qwen3-vl:8b | yes | no | yes | ~113.1s |
| gemma3:4b | no | no | yes | immediate tool rejection |
| deepseek-r1:8b | no | no | yes | ~83.7s |

## 验收证据

- 用户五类真实 harness 最终通过 `5/5`：ADD、UPDATE、NOOP、DEPRECATE、NOOP；最近一次成功为 `processed=5`、`model_calls=1`。
- 生产 `node scripts/agent.mjs --agent steward --once --limit 10` 成功返回 `processed=10`、`failed=0`、`runtime_run_id` 非空、`model_calls=4`；该批次前十条为 critical conversation-extract，按治理 gate 正确保持 `promoted=0`，未绕过 critical 禁止晋升规则。
- 隔离真实 data-root 使用同一生产 CLI、qwen 配置和 memory facade 跑 `--once --limit 10`：`processed=1`、`promoted=1`、`failed=0`、`model_calls=1`、`runtime_run_id=run-51a33240-f11b-47f6-bbcd-84e2747775ce`。候选经过既有 `review -> promote`，落到 `curated/shared/d12-real-promote.md`；search 返回 `itemId=d12-real-promote`。
- 定向测试覆盖高质量 ordinary `ADD` 的真实 `review -> promote` 及 searchable 结果；生产 critical 候选不会绕过 gate 晋升。
- D12 定向回归：22/22 通过，覆盖 tool input、单步调用、fallback、bounded target、五类动作、晋升和失败链接。

## 不变量

- 未修改 DSH `gpt-5.6-sol` 路由。
- steward scheduler 保持 Disabled。
- 搜索保持零写入；所有写操作仍通过既有 memory facade、scope 与 steward principal。
- 未扩大 steward 权限；target 补全仅使用候选自身 bounded neighbors。
