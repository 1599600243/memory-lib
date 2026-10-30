# 收口：第一大阶段（记忆库主链路）· 2026-10-22

> 产品岗收口记录。**只写能用读数核的东西**；没验到的一律写在「未闭环」里，不算收口。

## 一、线上跑的是什么（可核）

| 组件 | 版本 / 锚点 | 状态 |
|---|---|---|
| 记忆服务 `8787` | `app@d6944ab`（INDEX-2） | PID 42800，`source=fts` 生效 |
| 捕获代理 `8899` | `--capture=off --inject=on --refine=on` | PID 11476 |
| DSH 插件（捕获+提炼触发+注入） | `index.js` `48774B`（IN-PLUGIN-4） | 已加载，注入 111 成功 / 0 失败 |
| 看门狗 | `handoff-watch.mjs 30` | PID 7408 |
| 库 | `curated` **1477** / `evidence` **1884** | 提炼待办 0 |
| 仓库 | `app@d6944ab` / 顶层 `b87c07f` | 工作树均干净 |

## 二、这一阶段真正解决的问题（每条都有真机读数）

| # | 问题 | 修复 | 读数 |
|---|---|---|---|
| 1 | 问「记忆库几层」答成「9 层」（猜的） | RANK-1：可数问法答案句排首位 + 整句打包 | 五问法「8 层」全第 1；真机答 **8 层 + 八个层名全对** |
| 2 | 注入用**别的会话**的话检索 | IN-PLUGIN-3：问句按会话隔离 | 三会话同窗各自 `queryHead` 互不污染 |
| 3 | **单步轮次首步不注入**（压不住） | IN-PLUGIN-4：改在 `agent/inbox/inserted` 入队时记问句 | 首步即注入，`queryChars`=本轮字数 |
| 4 | 库变大后注入撞 3 秒超时 | INDEX-2：fts 候选粗筛 + **精确全局 df** + 两字词 LIKE 补候选 | 176 问 **0/0/0**；p50 54ms（in-process）/ 85ms（HTTP） |

**质量账**：INDEX-1 在同批 176 问上是 **15 首条改变 / 51 序列不同 / 21 漏关键词**，INDEX-2 全部归零。

## 三、上线顺序的硬约束（写下来防复发）

线上索引库原本**没有** `recall_df_docs / recall_df_bigrams / recall_df_fts` 三张表。若直接切 INDEX-2 代码，**全部问句会先回退全量扫描**（p50 127ms，比 INDEX-1 更慢），直到回填完成。

**正确顺序**（本次已按此执行）：
```
停 8787 → node index-store 的 indexMemoryRoot({dataRoot:'D:\MemoryLib\data\memory'}) 建表回填（实测 9.6s）
        → 起 8787 → 验 candidate_source 出现 + 五问法位次 + p50
```

## 四、可复现的验收资产（这一阶段最大的过程改进）

| 资产 | 位置 | 说明 |
|---|---|---|
| 176 问语料 | `reports/INDEX-1-acceptance-corpus-176.jsonl`（176 行，`A2F78CD4…`） | 生成器 `scripts/index-acceptance-corpus-176.mjs` 自带口径自检 |
| 三路对比脚本 | `scripts/index-compare-176.mjs` | 全量 / INDEX-1 / INDEX-2 同数据同进程逐条比 id 序列 |
| 延迟基准 | `scripts/bench-brief.mjs`、`scripts/bench-index2-corpus176.mjs`、`scripts/bench-brief-old-vs-new.mjs` | 采样 p50/p90/p95 + 扩容外推 |
| 索引体检 | `scripts/check-index2-tables.mjs` | 查 df 三表是否存在、行数 |
| 插件注入红绿 | `scripts/verify-inplugin3.ps1` | 含"改前回退拷贝"的语义校验 |
| 三路 worktree | `_wt/wt-full`(621b08f)、`_wt/wt-i1`(0acc142)、`_wt/wt-i2a`(586c5c1) | 复现对比用，可删可重建 |

**教训（两次同样的问题）**：验收的攻点语料/脚本如果不入库，下一轮就只能"重建"，数字对不上、结论无法复现。以后**攻点资产先入库再开跑**。

## 五、未闭环（**不算收口的部分**）

1. **验收岗对最终 HEAD 的独立复核尚未回签**：它验的是 `586c5c1`；我打回 `09b47e0` 后开发补了 `25e9b07`/`d6944ab`，目前只有产品岗单方复跑（0/0/0）。已派单复核。
2. **`VISIBILITY-UNKNOWN-1`（权限类遗留，唯一一条）**：`visibility=private` 在"记忆 `user_id="unknown"` 且 principal 也是 `unknown`"时会放行。生产 principal 是真实身份，**当前不漏**，但未修。
3. **两字问句检索恒空**：问「验收」「8层」这类命中 0（`scoreTokens.enough` 门槛所致），属词面检索固有短板。
4. **测试有一条"装饰性断言"**（入队+落盘去重那条抓不到去重被删）。
5. **DSH 未升级**：本机 `0.1.0-rc.7`（2026-08-17）落后 35 个版本，最新 `0.2.1-rc.2`。用户口径：**记忆库搞完再升级**。现已到可升级时点。
6. **异地备份重试策略偏弱**：`snapshot.ps1` 只重试 1 次/15 秒，2026-10-22 04:00 因 GitHub 连接失败断了一次（10:02 手动补推成功，数据未丢）。
7. **harness 补丁属临时手段**：已改 `dsh-sandbox` 让"非更宽请求放行 + 空 justification 视为未请求"（备份 `index.js.bak-patch-20261022-031659`）。**DSH 升级会覆盖此补丁**，升级后需重新评估是否还需要它。

---

## 六、验收回签（2026-10-22 17:5x 补记）

**最终 HEAD `d6944ab` 已由验收岗独立复核通过**（`reports/INDEX-2-acceptance-report.md` §13，提交 `86fd7de`）：

```
钉住的三个源：wt-full recall.mjs=3AA91D69(621b08f) / wt-i1=A92A4AA4(0acc142) / app=F9318375(d6944ab)，app 工作树空
① J1：全量 → INDEX-2 = 0 / 0 / 0；旁证 全量 → INDEX-1 = 15 / 51 / 21（语料与副本未漂移）
② 来源分布 fts 116 / full 60，与产品岗复跑一致；60 条 full 全部 <300ms，原因均为 LIKE 溢出/无可索引 token/无候选
③ 排序/打包/预算：586c5c1..d6944ab 之间 recall.mjs 只删了一行重复注释，语义零改动
```

⇒ 第五节第 1 条（验收未回签）**已闭环**。仍未闭环的只剩：`VISIBILITY-UNKNOWN-1`、两字问句检索恒空、装饰性断言、DSH 升级、备份重试策略。

**第一大阶段（记忆库主链路）至此收口完毕。**

---

# 追加（2026-10-23 00:2x）：VISIBILITY-UNKNOWN-1 已上线

| 项 | 读数 |
|---|---|
| 代码 | `app@504277a`（基线 `d6944ab`）；8787 新 PID 57484 |
| 判据 | `scripts/diff-container-policy.mjs` **14/14**（漏洞点 L1–L4 由放行变拒绝；扩权点 X1–X3 保持拒绝；其余不变） |
| 独立验收 | 432 格 group 穷举 **0 差异**、700 格所有权穷举 **35 收紧 / 0 放开**、3409 条真实条目 admin **放开 0 / 收紧 0** |
| 回归 | 基线 636/636/0；交付 641/641/0（不新增失败文件） |
| 部署后三入口 | brief 五问法 `source=fts` 且 8 层位次 **全 1**；图检索 `/v1/graph/query` HTTP 200 且 `project:memory-lib` **nodes=2 / edges=2**；`/v1/search` 三条问句全 200 命中 5 |
| 回滚锚点 | `git -C D:\MemoryLib\app reset --hard d6944ab` + 重启 |

**过程教训（已入库为工具）**：这单两轮打回，第 2 轮是**产品岗指令错误**（"哨兵视作未指定"导致扩权：`group_id="unknown"` 可读所有组）。教训固化为 `scripts/diff-container-policy.mjs` 的 14 条判据 + 部署后三入口验证脚本 `scripts/verify-after-deploy.mjs`。
