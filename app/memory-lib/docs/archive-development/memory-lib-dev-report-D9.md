# memory-lib D9 开发报告

范围：D9.1-D9.3 修复令。DSH 主模型保持 `gpt-5.6-sol`；steward scheduler 保持关闭，运行中的 `server.mjs` 未带 `--steward-schedule`。

## 提交

- D9.1 `a895351`：仓库 poller 成为唯一真源；同步脚本部署 poller 与 session adapter 并逐文件校验 SHA-256；改用 `POST /v1/conversations/summarize` 和 `conversation_id`；heartbeat 暴露 `summarized`、`summarySkipped`、`summaryErrors`、`lastSummaryError`，摘要失败令本轮 status 为 failed；扫描同时覆盖 `session-UUID` 与 DSH 后台 agent 使用的裸 UUID 目录。
- D9.2 `9ea6e85`：单结果也进入 tier 标注；具名 canonical 状态文件稳定优先于仅因新近而得分较高的普通文件。
- D9.3 `0fd1224`：同 tier 内以查询 token coverage 为主导，relevance/recency/importance 用于细排；仅对已有词面命中的待索引新晋升文件施加有上限的 freshness bonus；结果暴露 owned JSON `scoreParts`。

## D9.1 端到端验收

最终同步结果：

- `capture.mjs` SHA-256：`a401ea57a014a4f8b28613e7e948f14b02a696f82de307bbf1bf20f261aabf33`
- `session-snapshot.mjs` SHA-256：`6f09ca8b6a76e10a0bb1b7bb98788574cf41d9ad86150c989ad98a8cb63ce9e1`
- 两个部署文件均与仓库源文件逐字节一致。

以真实 DSH 只读审阅子会话 `81e76196-f571-45c3-8646-e60638c7d582` 执行定向 backfill。该轮输出：

```text
OK 81e76196-f571-45c3-8646-e60638c7d582#turn-1 evidence=conversation-e0a39cb5d0ba760e321bb5d1 candidates=0
SUMMARY 81e76196-f571-45c3-8646-e60638c7d582 path=I:\OpenClaw\memory-data\memory\episodes\2026-09-27\81e76196-f571-45c3-8646-e60638c7d582.md
DONE files=1 submitted=1 baselined=0 skipped=0 failed=0 summarized=1 summarySkipped=0 summaryErrors=0
```

episode 文件数由 444 增至 445。新文件 front matter 包含 `source: dsh-session`、`evidence_refs: [conversation-e0a39cb5d0ba760e321bb5d1]` 和对应 conversationId。heartbeat 为 `status=success`、`summarized=1`、`summaryErrors=0`。

## D9.2 验收

生产查询 `记忆核心`：`project-state/memory-lib/current-state.md` 为 #1，`tier=1`、`rankSource=canonical`。

四条未复用验收原文的意图改写均将目标排为 #1：

| 查询 | 名次 |
|---|---:|
| `memory-lib 当前进展是什么` | 1 |
| `记忆系统下一步工作` | 1 |
| `memory-lib 有哪些阻塞项` | 1 |
| `记忆库规范状态` | 1 |

结果为 4/4 前 3，超过要求的至少 3/4。

## D9.3 打分诊断与验收

查询 `解析器 单对象 格式不匹配` 的目标由修复前 #5 升至 #2。最终逐项结果：

| 文件 | 名次 | score | relevance | recency | importance | lexicalCount | matchedTokens | tokenCoverage | freshFile |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `project-state/r17/sem-8abeb5a7f1f5d5e9.md` | 1 | 0.501837 | 0 | 0.793162 | 0.33 | 0 | 6 | 0.545455 | 0 |
| `curated/shared/sem-4350e1c9477cb1be.md` | 2 | 0.501837 | 0.510884 | 0.793162 | 0.33 | 0 | 6 | 0.545455 | 0 |
| `curated/shared/sem-608632306b63df81.md` | 3 | 0.332892 | 0.482488 | 0.717682 | 0.33 | 0 | 3 | 0.272727 | 0 |
| `curated/shared/2026-08-30T07-28-31-482Z-shared-9924e085.md` | 4 | 0.248813 | 0.558290 | 0.742974 | 0.33 | 0 | 1 | 0.090909 | 0 |

修复前公式只给 token coverage 5% 权重；目标 6/11 token 命中仅贡献约 0.027，因而被较高向量 relevance 的零词面命中条目压过。新公式让 token coverage 贡献 55%，并以 `max(vector relevance, token coverage)` 进入 35% 的加权分，recency/importance 不再盖过直接词面命中。`lexicalCount=0` 表示这些最终候选来自未保留 matchCount 的 vector lane；`matchedTokens/tokenCoverage` 从最终文件内容重新计算，不依赖 lane。对尚未刷新索引的刚晋升文件，额外项限定为 `freshFile * lexical * 0.3`：必须已有词面命中且仅在同 tier 分数内生效，避免任意新文件仅靠时间压过直接命中。

本次以仓库实现直接读取生产数据复验；运行中的 MCP 服务尚未重载 D9 代码，因此不作为候选版本验收入口。唯一排在目标前的是 `project-state/r17/sem-8abeb5a7f1f5d5e9.md`，与目标具有相同 token coverage 和复合分；目标满足前 3 要求。

回归查询：

- `白名单准入 提炼门槛`：目标 `sem-8f460d195b925462.md` #1。
- `DBX`：`tools-memory/dbx.md` #1，`tier=0`、`rankSource=exact-id`。
- 所有结果继续按 `(tier asc, score desc)` 单调排序。

## 验证与运行约束

定向测试覆盖部署哈希、摘要契约、失败可见性、canonical 优先级、lexical-first 和既有混合检索回归。生产数据未删除，既有 episode 未覆盖；定向 backfill 使用真实新会话。D9 diff 未修改模型或 scheduler 配置；`OpenClaw Agent Memory Reconciler` 计划任务仍为 Disabled，memory-lib 服务命令行无 `--steward-schedule`。
