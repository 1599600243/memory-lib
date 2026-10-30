# Memory-lib D11.1 开发报告

日期：2026-09-27

范围：修复 steward 在真实 `--once --limit 10` 中返回分析文本、无法解析 JSON、缺失 runtime run ID，以及长批次复制候选/neighbor ID 不稳定的问题。DSH 主模型保持 `gpt-5.6-sol`；steward 默认模型保持本地 `ollama/gemma3:4b`；`OpenClaw Agent Memory Reconciler` 保持 Disabled。

## 实现

- 优先使用强制 `submit_decisions` tool call；schema 覆盖 `ADD / UPDATE / NOOP / DEPRECATE / pending-human`、非空 reason 与可选 target。
- 显式声明 `structuredOutput`、`toolCalling`、`jsonMode` 能力。当前 `gemma3:4b` 实测无 tool calling/structured schema 能力，使用 Ollama OpenAI-compatible JSON object mode；未修改模型路由。
- 三种能力路径统一校验：必须恰好覆盖本批全部 candidate ID，无重复或陌生 ID；`UPDATE / NOOP / DEPRECATE` 的 target 必须属于该 candidate 自己的 bounded neighbors；`ADD / pending-human` target 必须为空。
- 首次输出解析或契约失败时纠正一次，第二次仍失败则 fail closed。失败 runtime 记录保留截断后的模型输出用于诊断。
- 复用 `conversation-memory.mjs` 的 `extractJson` / `extractJsonValues`，支持 fenced JSON 和前后分析文本；没有复制 JSON 提取实现。
- steward batch 向模型发送有界投影：10 个 candidate ID 全保留，候选正文最多 1,200 字符，每条最多 3 个 neighbor，neighbor 正文最多 600 字符。模型边界使用 `c1/c1n1` 短别名，字符串或对象结果均先经共享提取器解析，再确定性恢复真实 ID；治理应用继续使用完整内存对象。
- agent prompt 不再静默截断批次 JSON；有界投影决定输入上限，因此模型看到的内容与 runtime 校验的 candidate contract 一致。
- runtime 与 steward batch 失败日志均保存真实 `runtime_run_id` 和实际 model call 数；batch 的成功日志也链接对应 `runtime/agents/steward/run-*.json`。持久化的模型输出使用现有敏感文本 redaction。
- CLI memory facade 保留 runtime principal；配置的 scope 语义保持不变。

## 验收证据

生产命令：`node scripts/agent.mjs --agent steward --once --limit 10`

- 状态：completed
- processed：10
- failed：0
- model_calls：1；runtime 每次 run 只执行一次 `modelFor(config)`，纠正重试复用同一模型对象。
- 所有结果均有非空 reason，action 均属于治理枚举。
- runtime_run_id：`run-4e8a278e-4c76-4d7f-bf4d-ccca8e0847fb`
- steward log：`I:\OpenClaw\memory-data\memory\runtime\steward\2026-09-27T17-12-24-947Z-193799cd.json`
- runtime record：`I:\OpenClaw\memory-data\memory\runtime\agents\steward\run-4e8a278e-4c76-4d7f-bf4d-ccca8e0847fb.json`

真实 `gemma3:4b` 五类隔离验收在一次模型调用内通过：

- new -> ADD
- detail -> UPDATE (`mem-tests`)
- vague -> NOOP (`mem-release`)
- conflict -> DEPRECATE (`mem-retention`)
- duplicate -> NOOP (`mem-rollback`)
- runtime_run_id：`run-669d7495-c053-46be-b857-f03c9a15d33e`

定向测试覆盖 forced tool call、JSON mode、一次纠正、第二次失败关闭、候选 ID 完整性、每候选 target 归属、上下文边界、prose/fenced JSON、失败 run ID 链接和五类治理动作。

## 不变量

- 未修改 DSH `gpt-5.6-sol` 路由。
- 未修改 steward 默认模型 `gemma3:4b` 或 Ollama endpoint。
- steward scheduler 保持 Disabled。
- 搜索仍通过既有只读 API；D11 没有新增搜索写路径。
- 写操作仍经既有 memory facade、scope 与 steward principal 执行；未扩大权限。
