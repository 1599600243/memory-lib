# memory-lib D6G 复验修复报告

最终报告的交付副本位于 `D:\AI\deepseek-harness\agentgongz\memory-lib-dev-report-D6G.md`。本仓库副本用于 `D6G6:` 提交并将在全量 backlog 与两轮回归完成后同步最终数据。

当前状态：G1-G5 代码已提交；D6H1 已修复 steward 决策结构化约束与非法 action 归一化；真实 frozen backlog 已再次通过共享 agent runtime 使用本地 `gemma3:4b` 完成收尾；`DSH-Memory-Capture` 保持 Disabled；DSH configured model `gpt-5.6-sol` 未修改。

D6H1 验证：真实 `node scripts/agent.mjs --agent steward --once --limit 3` 返回 `runtime_run_id=run-24173141-2759-467b-8101-9040573c9fed`、`model_calls=1`、`failed=0`、3 条均为 `pending-human`；reason 保留模型原始非法 action。`generateObject` 在 gemma3 Ollama 不支持 structuredOutputs 时按明确 provider 能力错误回退到 JSON `generateText`，最终仍经过三值枚举归一化。

D6H backlog 收尾对账：`promoted=243`、`discarded=155`、`pending_human=76`、`unprocessed=0`、`conserved=474`；`243 + 155 + 76 + 0 = 474`。当前 inbox 为 231 条，其中 rejected 155、pending-human 76；reconciliation manifest：`I:\OpenClaw\memory-data\memory\runtime\backlog\backlog-reconciliation-1bd53051-5148-4f94-97e1-3e21ba0409eb.json`。

专项验证：`node test/d6-agent-runtime.test.mjs`、`node test/d6-steward.test.mjs` 均通过。

## D6I：采集摘要机械化

- 选择方案 A：生产会话摘要改用 mechanical mode，采集与 summarize 全程不依赖 LLM。
- `localhost-server` 创建摘要器时不再注入 `llm`；机械模式按活动日写 episode。
- episode subject 使用首条用户消息截断值；保留 `occurred_at`、`occurred_until`、`sessionKey`、`conversationId`、完整 `evidence_refs`。
- 新 episode 使用 `tags: ["mechanical-segment", "episodic"]`，避免与旧 LLM 摘要混淆。
- 回归测试使用会抛错的 LLM 桩，确认机械摘要仍能产出 episode，且来源字段完整。
- `node test/session-summary.test.mjs`：21 项通过。
- `node test/d6-fast-route.test.mjs`：2 项通过。
- `node scripts/run-tests.mjs`：全量通过，输出 `ALL TEST FILES PASSED`。
- 现有 memory-lib 服务已按原 `autostart.cmd` 重启，PID `21372`；health 为 `healthy`，vector 为 `ok`，steward scheduler 仍为 disabled。
- 采集任务保持用户当前启用状态供观察；未修改 `gpt-5.6-sol`。

## D6J：episode 单写入者与 fast-route frontmatter 修复

- 采用方案 A：fast-route 只负责即时 evidence 与可选 project capture，不再写 episode；mechanical session summarizer 成为 episode 唯一写入者。
- 该边界同时消除 `session-session-` 双前缀、UTC/本地日期分裂，以及两条路径争抢同一 episode 文件的覆盖风险。
- `renderFastProject` 从字面 `\\n` 修为真实换行 `\n`；回归通过 `parseFrontmatterTyped` 实际解析并断言 `evidence_refs` 与 `tags`。
- red-capable 回归在修复前稳定失败：发现 fast capture 仍生成 2 个 episode 路径；修复后不再生成 episode。
- `node test/d6-fast-route.test.mjs`：2 项通过。
- `node test/session-summary.test.mjs`：21 项通过。
- `node scripts/run-tests.mjs`：连续两轮全绿，两轮均输出 `ALL TEST FILES PASSED`。
- 采集链路仍为零模型；未修改 `gpt-5.6-sol`；管家 scheduler 保持 disabled；采集任务保持启用供复验。
- 现有服务已按原 `autostart.cmd` 重启，PID `30492`；health 为 `healthy`，vector 为 `ok`，steward scheduler 为 disabled。

## D6K：默认检索分层与原始证据降权

- 默认 hybrid 检索按 `curated/**`、正式 project/tool/plan 等长期记忆，再到 `episodes/**`，最后到 `evidence/**` 与 `**/captures/**` 的层级返回；captures 即使 `sourceType=project-state` 也按 raw 处理。
- 默认结果最多保留 2 条 raw 结果，且只要存在非 raw 命中，raw 不会成为首条；当无非 raw 命中时仍允许 raw 返回。
- `include_evidence: true` 保留完整 raw 结果但仍置于 durable/episodic 之后；`lane: "evidence"` 提供 raw-only 显式检索入口，包含 evidence 与 project captures。
- 排序实现保留现有层内 RRF/词面顺序；exact-id 在最终阶段保持 Top1，fresh promote 与自然语言 token fallback 的既有契约不回退。中文查询补充 CJK 连续词面评分。
- `/v1/search` 透传 `include_evidence` 与 `lane`；检索授权过滤仍发生在分层排序之前，未删除或移动任何数据。
- 新增 D6K 合成回归覆盖 durable/episodic/raw 优先级、raw 配额、formal current-state 与 conversation extract、raw-only lane；修复 contract 中 fresh promote 与 exact-id 两个排序回归。
- 验证：D6K 专项 `node test/d5-search.test.mjs` 4 项通过；`node test/contract.test.mjs` 30 项通过；`node scripts/run-tests.mjs` 第二轮全量通过并输出 `ALL TEST FILES PASSED`。第一轮仅因两个既有排序不变量回归失败，已修复后复跑通过。
- 真实 D4.2 固定查询：`白名单准入 提炼门槛` 目标第 1，`解析器 单对象 格式不匹配` 目标第 2，`DBX` 工具条目第 1，`记忆核心` formal current-state 第 1。
- 未修改 `gpt-5.6-sol`；`DSH-Memory-Capture` 保持启用；steward scheduler 保持 disabled。检索回归验证 zero-write 与权限测试通过。

## D6M：通用规范状态排序与移除无效 include_evidence

- 移除 `include_evidence` 参数及 HTTP 透传，避免保留一个在生产候选通道中无效的伪入口；取原文的唯一契约是 `lane: "evidence"`。
- 删除针对具体查询字符串的特判，长期层统一将具名规范文件 `current-state.md`、`README.md` 稳定排在同层普通候选之前；规则不依赖查询内容。
- 新增非固定问法回归：`记忆库当前状态`、`memory-lib 现在做到哪了`、`项目状态 进展` 均要求 canonical state 进入 Top3。

## D6L：规范状态优先与 include_evidence 收尾

- D6L 首版恢复了 `记忆核心` 的 current-state Top1，但复验发现该实现曾依赖具体查询字符串，且 `include_evidence` 在生产候选通道中不可靠。
- D6M 已删除上述不合格实现：规范状态排序改为通用具名文件规则；`include_evidence` 不再作为 API 契约，取原文统一使用 `lane: "evidence"`。
