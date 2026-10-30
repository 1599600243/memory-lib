# memory-lib D8 开发报告

范围：D8.1-D8.5 修复令。模型保持 `gpt-5.6-sol`，steward scheduler 保持默认关闭。

## 提交

- D8.1 `2e4791b`、`391836d`：采集 adapter 部署同步到 `memory-capture/adapters/`，capture 使用相对 import；heartbeat 和失败退出码；VBS 经 `cmd /c` 等待并传播 node 退出码。
- D8.2 `8665fc0`、`2a73e12`：每条结果暴露 `{ tier, score, rankSource }`，按 `(tier asc, score desc)` 排序；ledger 中已存在但 hash 改变的文件重新进入 file-first 候选。
- D8.3 `a190949`：归档支持引号时间戳和 occurred/created/mtime 回退；缺失 recall counts 时拒绝 archive；输出 active/eligible/eligibilityRate；steward 批次先合并 recall hits。
- D8.4 `f7f4b62`、`9dcd712`、`8293316`、`50df200`：steward 批次接入同 scope top-10 近邻和四选一校验；UPDATE 原位合并内容与双方 evidence refs，低信息更新变 NOOP；DEPRECATE 将旧条置 superseded；日志包含理由、target_id、neighbor_ids。
- D8.5 `f7980a4`、`382e8c3`、`efb0bcc`：健康路由暴露 capacity；22 条标注样本校准三档阈值；补 relevance-only 稳定排序回归。

## D8.1 验证

执行了 adapter 同步、`node --check` 和真实部署路径 `node capture.mjs --dry-run --verbose`。最新输出：`DONE files=4 submitted=0 baselined=0 skipped=2 failed=0 summarized=0`。同步脚本把 adapter 写入 `memory-capture/adapters/session-snapshot.mjs` 并对源文件和部署副本做 SHA-256 校验。heartbeat 已实测包含 `lastRunAt`、`lastSuccessAt`、`lastError`、`consecutiveFailures`。

## D8.3 真实副本演练

从真实生产 `curated/` 创建副本后执行 archive 演练，副本结果：`active=69`、`eligible=0`、`archived=0`、`eligibilityRate=0`。没有为了制造归档清单而篡改生产时间；计数 sidecar 缺失时 archive 会拒绝运行。

## 限制与验收说明

- D8.1 已完成可恢复故障注入：临时移走部署 adapter 后运行 capture，退出码为 `1`，heartbeat 为 `status: failed`、`consecutiveFailures: 1`，`lastError` 包含缺失模块路径；随后恢复 adapter 并真实执行 `node capture.mjs --verbose`，heartbeat 回到 success、失败计数归零。adapter 改为 `main()` 内动态相对 import，确保启动期 import 错误也能写入 heartbeat。
- D8.4 的五类输入仍需在真实 `gpt-5.6-sol` 模型配置下做一次运行验收；代码层保证 target 必须来自同 scope bounded neighbors，非法动作/target fail closed 到 governed ADD。当前生产 `runtime/agents/config.json` 仍是旧协议且指定 `gemma3:4b`，本修复未修改或启用该 scheduler。
- D8.4 对旧测试中的 `promote`/`pending-human` 保留显式 legacy 适配；生产代码协议是四选一。
- D8.5 压缩样本条件已核实：生产 inbox 有 242 条，全部属于 `project:d-ai-deepseek-harness-agentgongz`，满足同主题 ≥50 条。但在不改模型且 scheduler 禁用的约束下，没有可用的 `gpt-5.6-sol` 本地批次配置；因此没有用旧 `gemma3:4b` 冒充验收结果，也没有修改生产 inbox。偏离原因是模型运行前置条件不满足，而非样本不足。

## 质量门顺序

确定性规则先过滤过程片段、寒暄、敏感-only 和无价值内容；剩余候选才计算 specificity、durability、uniqueness、confidence、accessibility 五维质量分。22 条独立标注样本覆盖 10 条无实体碎片、5 条具体但不完整事实、7 条含文件/命令/端点/版本/明确决定或约束的耐久事实；校准后分档为 `<0.5 low`、`0.5–0.7 review`、`≥0.7 promote`，22/22 与标注一致。“这条是硬约束。”因没有具体实体降到 low。
