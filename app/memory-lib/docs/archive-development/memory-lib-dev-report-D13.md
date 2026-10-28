# Memory-lib D13 开发报告

范围：D13.1-D13.5。管家模型只判断 `duplicate|contradict|neither`；所有治理动作由确定性规则决定。DSH 主模型保持 `gpt-5.6-sol`，steward scheduler 保持关闭。

## 交付提交

- `35d5754 D13.1: narrow steward output to relations`
- `0e2cb6a D13.2: apply deterministic steward governance`
- `7af731f D13.3: backfill deterministic inbox quality`
- `786c9dd D13.4: record reproducible steward decisions`
- `8388750 D13.5: enforce one-call relation batches`
- `3a56f72 D13.5: harden local relation batch output`
- `77ee2bf D13.5: isolate malformed batch decisions`
- `74b81a8 D13.2: keep missing relations pending`
- `ac2126a D13.2: remove legacy action decision seam`

## 规则与审计

- `duplicate`：`review(reject, "duplicate of <target>")`，候选保留在 inbox，动作 `NOOP`。
- `contradict`：先 `supersede(target,candidate)`；候选继续走质量规则，高质量候选晋升。
- `neither`：`score>=0.7` 晋升；`0.5<=score<0.7` 保持 pending；`score<0.5` quarantine。
- critical、persona 或敏感信息始终 quarantine。
- relation 缺失、非法或 target 不在候选邻居中时保持 pending；没有 `ADD` fallback。
- 每条日志包含 `id/relation/target_id/quality.score/rule/action/reason/runtime_run_id`；runtime 失败日志保留逐候选 `runtime-failure` 行和 `model_calls`。

## D13.3 离线补算

命令：`node scripts/backfill-inbox-quality.mjs --root I:\OpenClaw\memory-data\memory\inbox --write`

- 扫描：254
- 补算：242
- 已有评分：12
- 错误/跳过：0/0
- `<0.5`：84
- `0.5-0.7`：101
- `>=0.7`：57
- 二次 dry-run：`backfilled=0, already_scored=254`

抽查三条：

- `project-d-ai-deepseek-harness-agentgongz-853931eb`：0.5665/review
- `project-d-ai-deepseek-harness-agentgongz-7bb54b06`：0.592/review
- `project-d-ai-deepseek-harness-agentgongz-0c409e8f`：0.5413/review

三条正文保持原内容；只追加 `quality_score/quality_band/quality_dimensions`，既有 rejected 状态未改变。

## 真实模型验收

`node scripts/validate-steward-relations.mjs` 使用本地 `ollama/qwen3:4b`，五类为同字重复、同义重复、直接矛盾、约束矛盾、无关：

- 正确：5/5
- 模型调用：1
- 耗时：50,260 ms
- runtime run：`run-d81893f2-7eba-4c9e-b345-d0c6a0ce3edf`

本地 qwen 默认能力为 `toolCalling:false/jsonMode:false`，仍是单次模型调用；云模型可通过配置启用 tool calling/structured output，不需要或写入任何云 key。

## 生产批次与检索

真实普通 inbox 批次：

- N=5，耗时 74,078 ms，`model_calls=1`，`failed=0`
- 3 条 critical 按 `critical-quarantine` 隔离
- 2 条模型缺项按 `missing-or-invalid-relation` 保持 pending
- runtime run：`run-49f3a301-a289-4bea-8f16-f618f308b5f4`

真实高质量候选批次：

- 候选 `shared-1dc442ae`，系统评分 0.925/promote，ordinary、非 persona、非敏感
- N=1，耗时 66,374 ms，`model_calls=1`，`promoted=1`，`failed=0`
- relation=`neither`，rule=`quality-promote`，action=`PROMOTE`
- runtime run：`run-a4def3dc-d2e7-42c5-bf47-449834d0adf4`
- curated：`I:\OpenClaw\memory-data\memory\curated\shared\2026-09-28T03-08-20-993Z-shared-1dc442ae.md`
- `createMemoryLib().search({query:"D13-RELATION-GOVERNANCE-ACCEPTANCE-20260928"})` 命中该 curated 文件。

默认 `batchSize=50` 保持不变。实测本地 4B 在较大批次可能遗漏条目；逐项解析保留有效输出，缺失/非法条目确定性 pending，整个批次仍恰好一次模型调用且不会静默 ADD。

## 测试与不变量

- 定向 D13/runtime/backlog/D8 steward 回归：12/12 通过。
- 第一轮预检发现并迁移了 `d6-backlog` 的旧 action 终态；修复后定向通过。
- 最终全量第 1 轮：`node scripts/run-tests.mjs`，exit 0，`ALL TEST FILES PASSED`。
- 最终全量第 2 轮：`node scripts/run-tests.mjs`，exit 0，`ALL TEST FILES PASSED`。
- search zero-write：`contract.test.mjs` 通过。
- bounded identity permission：`slice2.test.mjs`、`governance.test.mjs`、`channel-equivalence.test.mjs` 通过。
- `OpenClaw Agent Memory Reconciler`：Disabled。
- 运行中 memory-lib `server.mjs` 命令行不含 `--steward-schedule`。
- production steward：`ollama/qwen3:4b`；没有云 key 依赖。
