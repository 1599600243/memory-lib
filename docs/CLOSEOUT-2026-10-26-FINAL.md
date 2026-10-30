# 项目收尾 · 记忆库 + DSH 管家（2026-10-26）

> 本文件是**交接/运维手册**，不是进度汇报。目标：任何一个人（或下一个 agent）拿到这台机器，
> 照本文就能判断"它现在好不好、坏了怎么修、钱花在哪"。
> 建立于 2026-10-26 收尾时；历史过程见 `docs/CLOSEOUT-2026-10-22-memory-mainline.md`。

---

## 一、这套东西是什么

一个**本地多租户记忆平台**（`D:\MemoryLib`）+ 一个 **DSH 插件**把记忆注入到对话里。
一句话验收标准：**同一件事不再被问第二遍** —— 你问「记忆库几层」，它答得出八层的名字，而不是猜。

- 服务：`8787`（memory-lib HTTP API，本机）+ `3080`（DSH Web GUI）
- 插件：`dsh-memory-capture`（捕获对话 → 提炼 → 每轮注入相关记忆）
- 数据：`D:\MemoryLib\data\memory`（curated 记忆 + evidence 原文）
- 备份：`D:\MemoryArchive\live` → GitHub（`Memory-Archive-Daily` 计划任务，每天 04:00）

## 二、收尾时的确定状态（可核）

| 项 | 值 |
|---|---|
| 记忆服务 | PID 7540，`8787` 监听，代码 = `app@a7b5fc1` |
| DSH | `0.2.1-rc.2`，`3080` 监听，计划任务 `DSHWebAutoStart`（稳定入口） |
| 插件 | 已加载，注入/捕获/提炼触发正常 |
| 库 | curated **1497** 条 / evidence **1924** 条 |
| app 仓库 | `a7b5fc1`，工作树干净 |
| 顶层仓库 | `79daaac`，工作树干净 |
| 备份仓库 | `8ca4f16`，待推 0，stamp 已更新 |
| 磁盘 | D: 可用 ≈124GB |
| 看门狗 | `handoff-watch` 仍在跑（只在有 handoff 文件时动作；收尾期无派单 ⇒ 空闲） |

## 三、日常怎么用（人话）

- **正常对话就行**：插件每轮自动把相关记忆注入到系统提示里（≤600 字），不需要手动操作。
- **想看记忆里有什么**：问「记忆库几层」「上次验收的结论是什么」「最近三天有哪些注入改动」。
- **短问句也能用**（2026-10-23 起的改动）：`验收`、`8层`、`排序` 这类两字词现在**有结果**。

## 四、运维手册（出问题先看这里）

### 4.1 三个服务的起停

| 服务 | 起 | 停 |
|---|---|---|
| 记忆 8787 | 计划任务 `memory-lib-core`（`app\memory-lib\autostart.cmd`） | 停任务，或 `Stop-Process` 对应 pid |
| DSH 3080 | 计划任务 `DSHWebAutoStart` | 停任务 |
| 备份 | 计划任务 `Memory-Archive-Daily`（每天 04:00） | 停任务 |

**⚠️ 绝对不要从 DSH 会话内部重启 DSH 自己**（脚本会被 Windows Job 连带杀死，已发生过一次 27 分钟宕机）。
正确做法：建一次性计划任务跑重启脚本，或从 GUI 外部执行。

### 4.2 快速健康检查（3 条命令）

```powershell
# 服务在不在
Get-NetTCPConnection -LocalPort 8787,3080 -State Listen

# 记忆答不答得出八层
node D:\MemoryLib\scripts\verify-after-deploy.mjs

# 备份是否新鲜（看 .last-push.json 的 at）
Get-Content D:\MemoryArchive\live\.last-push.json
```

### 4.3 回滚锚点

| 想回到 | 命令 |
|---|---|
| 记忆库上个版本（两字问句之前） | `git -C D:\MemoryLib\app reset --hard 504277a` 然后重启 8787 |
| 注入改用索引之前（纯全量扫描） | `git -C D:\MemoryLib\app reset --hard 621b08f` 然后重启 8787 |
| 备份脚本改重试之前 | `git -C D:\MemoryArchive\live reset --hard 0c13b24~1` |

### 4.4 部署顺序（硬约束）

线上索引库若没有 `recall_df_docs / recall_df_bigrams / recall_df_fts` 三张表，
切新代码会**先变慢**（全部回退全量扫描）。正确顺序：

```
停 8787 → node -e "import('./memory-lib/src/index-store.mjs').then(m=>m.indexMemoryRoot({dataRoot:'D:\\MemoryLib\\data\\memory'}))"
        → 起 8787 → 验 candidate_source 是否 fts
```

## 五、踩过的坑（每条都真疼过）

1. **从会话里重启 DSH = 自杀**：脚本是 DSH 子进程，被杀在半路，服务不会回来。用一次性计划任务。
2. **升级 DSH 前先看计划任务入口**：若指向 `@deepseek-ai+dsh@<版本>_<哈希>` 这种易失路径，升级必挂。
3. **pnpm store 路径**：本机 `node_modules` 用 `D:\AI\.pnpm-store\v10` 装的，pnpm 默认找 `D:\.pnpm-store\v10`；
   不显式 `--store-dir` 就一定失败（且不改动任何东西）。
4. **DSH 0.2.1 的 `/api`**：需要浏览器 Cookie；路径是 `/api/<域>/<动作>`；payload 是 `{args:{...}}`；
   `session/prompt` 必须带 `requestId`（缺了只报 "boundary validation"，不告诉你缺什么）。
   Cookie 提取脚本：`scripts/dsh-control/get-dsh-cookie.ps1`（VSS 影子副本 + DPAPI）。
5. **旧会话要迁移**：0.2.1 之前格式的会话 `agentAvailable=false`，在 GUI 里点开一次即迁移（生成 `session.v4.jsonl.zstd`）。
6. **`/health` 带 401 不等于服务挂了**：那是认证栅栏。用带凭证的脚本判断。
7. **`/v1/search`、`/v1/graph/query` 的认证在 body 里**（`credential_ref + secret + principal`），头部 `X-MCP-*` 会 401。
8. **`invoke-node --test` 在受限会话里会 `spawn EPERM`**：用 `node <file>.test.mjs` 在进程内跑。
9. **in-process 探针不可信**：`recallBrief()` 直接调用可能返回 `included: []`（基线也一样），
   判断检索行为**必须起真 HTTP 服务**（`node server.mjs --port 8797 --data-root <副本>`）。
10. **验收资产必须入库**：语料、比对脚本、生产快照都要留。历史上两次"用完就删"导致整轮结论无法复现。

## 六、遗留（按优先级）

| # | 项 | 说明 / 判据 |
|---|---|---|
| 1 | **长问句 LIKE 溢出粒度** | 长问句若 trigram 未命中会走两字 LIKE，超 200 行 ⇒ 回退全量（`source=full/reason=like-candidate-overflow`）。基线也如此，不算回归，但"不该因为两字词溢出就退全量"仍值得修。测试已钉住现状并注明待办。 |
| 2 | 隔夜清空积压未沉淀成记忆 | 观察到一次，未复现；继续观察 |
| 3 | DSH 压缩不能分块 | 等上游版本 |
| 4 | 提炼无定时任务 | 对话驱动；待办常为 0，不痛 |
| 5 | 1 万条规模 p95 | 现在 1497 条；量级到了再测 |
| 6 | `VISIBILITY-UNKNOWN-1` | **已修并上线**（哨兵身份不可匹配），保留此条仅为索引 |
| 7 | 两字问句 | **已修并上线**（`验收`/`8层` 有结果），保留此条仅为索引 |

## 七、钱花在哪（重要）

- **本机服务（8787 / 插件 / 备份）不产生 API 费用** —— 全是本地进程与本地磁盘。
- **唯一烧钱的是"派单"**：DSH 里的岗位卡（开发岗/验收岗，`gpt-5.6-sol`）每对话一轮都记 API 费用。
  收尾状态下它们 `running=false`，**不调用就不花钱**。
- 想彻底省钱：不派单、不让看门狗自动交接（看门狗只在有 handoff 文件时动作）。
- 收尾后我做的验证尽量用本机脚本（`scripts/`），不拉模型。

## 八、资产索引

| 用途 | 路径 |
|---|---|
| 检索行为对撞（176 问） | `scripts/index-compare-176.mjs` + `reports/INDEX-1-acceptance-corpus-176.jsonl` |
| 短问句验证 | `scripts/verify-shortq-http.mjs` |
| 基线对撞 | `scripts/diff-baseline-vs-new-176.mjs` |
| 容器策略判据（权限） | `scripts/diff-container-policy.mjs`（14 条） |
| 部署后验证 | `scripts/verify-after-deploy.mjs` |
| 索引体检 | `scripts/check-index2-tables.mjs` |
| DSH 控制面 | `scripts/dsh-control/`（cookie + API 客户端 + 派单） |
| 插件红绿 | `scripts/verify-inplugin3.ps1`、`scripts/dsh-memory-capture/plugin-inject.test.mjs` |
| 事故记录 | `docs/INCIDENT-2026-10-23-dsh-upgrade.md` |
| 阶段收口 | `docs/CLOSEOUT-2026-10-22-memory-mainline.md` |
| 待办 | `docs/BACKLOG.md` |
