# memory-lib D10 开发报告

范围：D10.1 排序键契约修复。DSH 主模型保持 `gpt-5.6-sol`；steward scheduler 保持关闭。

## 方案选择

采用方案 B：`score` 保持 `0..1` 的同 tier 综合相关性分，新增 `rankKey` 作为权威公开排序键。

理由：exact-id、canonical 与记忆层级属于检索策略，不是相关性。把这些策略奖励折入 `score` 会让相关性诊断失真；独立 `rankKey` 可以同时保留可解释的相关性分和可验证的最终顺序。

## 字段契约

- `score`：同 tier 综合相关性，包含 token coverage、配置权重下的 relevance/recency/importance、lexical signal，以及仅对已有词面命中的待索引新晋升文件生效的 freshness bonus。
- `tier`：`0=exact-id`、`1=canonical`、`2=long-term`、`3=episodic`、`4=raw`。
- `rankKey = (4 - tier) * 2 + score`：最终排序键，结果按其单调不增。
- `rankSource`：主要排序来源；`scoreParts`：相关性诊断分量。

`score` 被限定为 `0..1`，每个 tier 使用宽度为 2 的独立 rankKey 区间，因此不同 tier 不重叠；同 tier 内 `rankKey` 与 `score` 严格同向。稳定同分仅保留输入顺序，不引入未声明的业务排序键。

## 回归测试

公共 seam 为 `createMemoryLib().search()` 的最终结果数组。测试断言：

- 每条结果公开有限数值 `rankKey`、`score` 和整数 `tier`；
- 所有结果按 `rankKey` 单调不增；
- 同 tier 内 `score` 与 `rankKey` 同向；
- canonical 可以在 `score` 较低时因 tier 策略排在普通结果前，且该顺序由 `rankKey` 显式表达；
- 重复查询顺序稳定。

定向套件 `d8-ranking-score + d5-search + contract` 共 37 项通过，包括 605 文件 common-word fresh-promote 回归、exact-id、canonical、lexical-first 与 raw quota。

## 生产只读验收

使用仓库实现直接读取生产数据，`indexRefresh=false`，不重启运行中服务、不写生产记忆。用户报告的逆序查询均按 `rankKey` 单调：

| 查询 | 前五项 rankKey |
|---|---|
| `记忆核心` | `6.748100 > 4.790614 > 4.457510 > 4.405722 > 4.392004` |
| `DBX` | `8.748100 > 4.865614 > 4.842452 > 4.183183 > 4.180560` |
| `记忆库当前状态` | `6.230243 > 6.023100 = 6.023100 = 6.023100 = 6.023100` |

D4.2 基线保持：

- `白名单准入 提炼门槛`：目标 #1。
- `解析器 单对象 格式不匹配`：目标 #2。
- `DBX`：`tools-memory/dbx.md` #1。
- `记忆核心`：`project-state/memory-lib/current-state.md` #1。

四条未见查询均将 `current-state.md` 排为 #1，结果为 4/4 前 3。

## 运行约束

D10 不修改模型、服务启动参数、scheduler 或生产数据。最终验收需连续两轮 `node scripts/run-tests.mjs` 通过，并确认工作树干净。