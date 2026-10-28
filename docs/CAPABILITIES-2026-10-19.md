# 当前系统能力清单 · 2026-10-19

> 由今日 38 份报告合并。**每条结论后面的括注就是它的来源文件**，没有"据说"。
> 读法：① 只收**验收通过**的；② 是明确的边界；③ 是**报告自己写的"没覆盖"，原样搬来、不美化**；④ 是还没解决的。
> 贯穿全文的一条前提（**归纳**，依据是 4 份验收报告里各自写的"没部署"原话，不是我逐单核对 8787 的 sha）：
> **多数单"没部署"** —— 代码/脚本已改好并验收，但生产 8787 上跑的是更旧的构建。
> 所以「能做」= 在仓库代码 / 副本实例 / 已部署到的那一版上能做，不等于此刻线上立即生效。

## ① 现在能做什么（仅验收通过）

1. **按天取回对话**（**本单实测**，生产 8787，`2026-10-19T03:43:54Z`；口径 = `POST /v1/search`、**空 query** + `calendarDate`，取 `total_count`）：
   问 2026-10-04 → **`total_count=37`**（返回页 10 条、逐条日期都落在 10-04）；问 2026-10-10 → **`total_count=1`**。
   命令与原始输出见 `reports/DOC-1-REJECT1-dev-report.md` §来源核对。
   ⚠️ 同一天还有 **9 条**的读数（`DAYRECALL-2-acceptance-report.md`，**副本 + 当时旧代码、证据口径**）——
   **这两个数不是同一个测量**，我没把它们对上，见附录 C。
2. **分档取时间**：同一批数据，修前 965 条越界 → 修后 317 条；开发报 964→316，差 1 是验收期间新进 1 条捕获。
   （`REFINE-LOOP-2-acceptance-report.md`）
3. **按天检索三入口一致**：库级 timeline、`/v1/search`、MCP `memory_search` 的按天谓词一致；10-10 **默认 hybrid → 3 条**、越界 0；当天字面含「游戏」1/1。
   （`DAYRECALL-2-acceptance-report.md`；口径＝默认 hybrid + evidence 配额，**与 ①.1 的空 query 枚举口径不同**，别混用）
4. **提炼落点单一**：巡检报告只写一处（`runtime/` 那份不再生成），可配置、标记 `deprecated/private`。
   （`REFINE-LOOP-1-REJECT1C-acceptance-report.md`）
5. **自动提炼能自己触发**：3 轮对话经代理 → 代理自落 3 条证据 → 无人手动跑脚本 → worker 真调模型 → 经 `/v1/write` 真写 1 条记忆（另 2 条哈希去重）。
   （`MAINPATH-2-acceptance-report.md`）
6. **排除类记忆不被重复提炼**：4~6 条规模上验了收敛与"新老两头同时推进"。 （`REFINE-LOOP-3-acceptance-report.md`）
7. **对话时自动注入相关记忆**：`/v1/recall/brief` 返回 `sections["近期记忆"]` 490 字、含"8 层"、`included` 6 条带 `{id, calendarDate}`。
   （`INJECT-1-acceptance-report.md`）
8. **写授权的五条旁路已关闭**：非 admin 自报 `visibility=private` 写 tools/note ⇒ 403 且零写入；platform 记录非 admin 不能 supersede；`tools/refresh` 需 admin；跨身份自报 ⇒ 403；API-key 不再平添 `propose`。
   （`WRITE-DENY-1-REJECT2-acceptance-report.md`，四道门全 ✅）
9. **`deprecate` 可用**：`/v1/memory/deprecate` 200，落盘 `status=deprecated`；`/v1/get` 仍可读（deprecated ≠ 删除），**默认检索不再返回**。
   （`MAINT10-acceptance-report.md`）
10. **4 条已移除的路由给明确回答**：`steward/run`、`admin/maintenance/run`、`admin/inbox`、`admin/inbox/read` → `410 GONE` + 说明，不再 500。
    （`MAINT11-acceptance-report.md`）

## ② 不能做什么（明确边界）

1. **`reasoningEffort` 不能配**：`mainpath-proxy` 走 `openai-completions`，不支持该参数；配了会**新建即死**（当时死了开发 9 个、验收 3 个会话）。已从 `settings.yaml` 整行删除。
   （`CHANGE-2026-10-19-reasoningEffort-removal.md`）
2. **"有词 + 按天"不保证只回词面命中**：hybrid 模式 evidence 配额写死 `Math.min(3, finalLimit)`；要取全那一天得显式 `searchMode:"evidence" + rawQuota`。
   （`DAYRECALL-2-acceptance-report.md` §未覆盖 2）
3. **`daily` 类条目（只有 `date:` 无时间戳）不参与按天查询**——这是既有口径，不是缺陷，但要知道。（同上 §B.7-4）
4. **工具记忆只能是 platform**：要求 `private` 现在**显式 403**（`WRITE_SPACE_UNSUPPORTED`），不会静默降级——所以"私有的工具笔记"这个能力不存在。
   （`WRITE-DENY-1-REJECT2-acceptance-report.md`）
5. **body 里自报的身份必须与认证身份一致**，否则 403 `IDENTITY_MISMATCH`（旧行为是"忽略、用服务端身份"）。
   （同上）
6. **4 条路由已被移除**：`steward/run`、`admin/maintenance/run`、`admin/inbox`、`admin/inbox/read`（D29 决策，不重建）。（`MAINT11-acceptance-report.md`）
7. **注入段 600 字上限是按"记忆正文"口径**；若按整段算，最坏实测 ~661。（`INJECT-1-acceptance-report.md` 点名 2）

## ③ 已知局限 / 未覆盖（照报告原文汇总，不美化）

1. **生产部署态普遍落后**：`DAYRECALL-2`、`REFINE-LOOP-2`、`MAINT11`、`WRITE-DENY-1-REJECT2` 的验收都明写"没部署、没重启 8787，读数来自仓库代码 + 副本实例"。
2. **真模型基本没被独立验证**：`REFINE-LOOP-1` / `-2` / `-3`、`INJECT-1`、`MAINPATH-2` 的验收都用**假模型 / 假上游**；"模型判断力"只能采信开发报告。
3. **MCP stdio 通道验不了**：沙箱禁 spawn pipes（`spawn EPERM`），验收只能用进程内 handler 或 `/mcp` HTTP 近似。（多份验收一致）
4. **性能只有粗略读数，别当成"没有性能影响"**：`DAYRECALL-2` 给的是"同一实例、快照、3 次取中位"（按天 208ms / 10-10 414ms / 10-19 507ms），生产规模与冷缓存没测。
5. **`INJECT-1` 的延迟两份报告不一致**：开发 +159ms（6 次 145/160/155/142/181/156），验收 183/188/210ms，差异来源未定位；方向一致（百毫秒级）。
6. **`MAINPATH-1-REJECT1` 结构上做不了基线对照**：交付物 `scripts/*` 不在任何 git 仓内，也没有改前备份；旧 16 条断言验收未跑。
7. **`MAINPATH-2` / `REFINE-LOOP-3` 的交付物不在任何 git 仓库里**（验收 §1 明写）。
8. **存量脏数据没清**：`MAINPATH-1-REJECT1` 窗口内 112 条占位证据 + 4 组跨来源双写仍在库里（data 只读，未删未改）。
9. **4 条"调用未定义函数"的死路径只列清单、没修**，也没逐个打请求验证必 500。（`MAINT10-acceptance-report.md` §未覆盖 4）
10. **`REFINE-LOOP-1` 有 17 条实验残留**仍在库；522 条里 **217 条引文出自助手侧**（非 `## 用户`），是否需要产品口径裁决待定。
11. **契约变更的客户端影响没核对**：`WRITE-DENY-1-REJECT2` 会让"body 带不匹配身份"的调用方拿到 403，开发与验收**都没去 grep 真实调用方**。
12. **巡检报告的写入者没定位到**：`project-state/memory-system/refinement-inspection.md` 仍在被定时重写，全仓搜不到那个写入点。（`REFINE-LOOP-1-REJECT1-acceptance-report.md`）
13. **巡检报告曾可跨组读（200）**：改后只标注 + 给开关，`REJECT1b` 明写"没能消除"。

## ④ 待办与未决

1. **待提炼积压**：**来源＝订单**（`orders/DOC-1-consolidate-capabilities.md`），口径"约 900 条，自动消化中"。
   ⚠️ **我在今日报告里找不到对应读数，未复核**；今日报告可核到的相邻读数是 `REFINE-LOOP-2` dry-run 扫到 651 条记忆、能定位证据 647 条（**口径不同，不能直接相等**）。
2. **`--newest-first` / `--old-quota` 只在 worker CLI**，代理不传（生产用默认 `0.2`）。待定：代理要不要传。（`REFINE-LOOP-3-acceptance-report.md`）
3. **注入回执 `includedIds` 只在日志里，没有界面**。（`OPS-2026-10-19-architecture.md`）
4. **`REFINE-LOOP-1-REJECT1` 的告警未达成**：`已关联 525` / `精炼率 0.3321`，但 16 条 backlog 没消化；补它需要跑 `refine-worker.mjs --limit 20`（会写生产记忆，需授权）。
5. **`MAINPATH-2` 当时先派后补**：范围单 `orders\MAINPATH-2-refine-inside-proxy.md`（3,110 B，10:09:33）在验收当时缺失、**现已存在**；本清单下线时它已落盘。
6. **`DAYRECALL-2`：`resolvedRange` 在带 query 的检索入口不回显（`null`）**，只在空 query 时回显。（验收 §B.9 补测）
7. **巡检报告跨组可读**：要彻底解决需给报告 frontmatter 填身份，或把落点挪出检索根——都是产品级选择。（`REFINE-LOOP-1-REJECT1b-dev-report.md` §3）
8. **`data/` 里存量垃圾（112 条占位证据 + 4 组双写 + 17 条实验残留）** 需要一次性清理方案 + 执行人。

## 附：今日两处**报告自相矛盾**（不挑一个，两个都摆出来）

### A. `REFINE-LOOP-1` 两份验收结论不一致（同一份文件内并存）

磁盘上现在只有 **42,772 B** 的 `REFINE-LOOP-1-acceptance-report.md`，它开头自述"本文件含两份独立验收"。
下单人提到的另一份 **20,816 B** 版本**已不在磁盘上**（全库按大小与文件名搜索均未找到），无法逐字比对，只能按现存文件的自我说明记录：

| | 时间 | 口径 | 结论 |
|---|---|---|---|
| 第一份 | 06:02:33 | 5 判据 | **通过（有条件）** |
| 第二份 | 06:11–06:35 | `ACCEPTANCE.md §5` 四道门 | **部分通过**（产品门 ✅ / 接线门 ✅ / 工程门 ✅ / **回归门 ❌**） |

⇒ **本清单不把 `REFINE-LOOP-1` 列为"验收通过"**（因为有一份判部分通过）。差异点集中在**回归门**。

### B. `DAYRECALL-2` 也是两份验收，但**结论一致**

同一份文件里两份独立验收都判 **通过**；第二份额外补了 4 个第一份没覆盖的读数（含"`resolvedRange` 在带 query 时不回显"、"生产 8787 仍是旧代码"）。
⇒ 这处**不是矛盾**，列在这里是为了避免把"两份文件"误读成"两次不一致"。（`DAYRECALL-2-acceptance-report.md` L2-L5）

### C. 同一天（2026-10-10）两个**不可比**的读数

| 读数 | 来源类型 | 环境 | 口径 |
|---|---|---|---|
| **1 条** | 本单实测（`DOC-1-REJECT1-dev-report.md` §来源核对，2026-10-19T03:43:54Z） | 生产 8787 现网 | `POST /v1/search` 空 query + `calendarDate`，`total_count` |
| **9 条** | `DAYRECALL-2-acceptance-report.md` L122/L130/L357 | 副本 + 当时旧代码 | 证据口径（真值 `\|A\|=9`） |

⇒ 相差 9 倍。**我没有把这两个数对上**，也没能力判断谁"对"：环境不同（现网 vs 副本/旧构建）、口径不同（时间线枚举 vs 证据真值）。
写在这里是为了避免任何人把它们当成同一个指标来引用。
