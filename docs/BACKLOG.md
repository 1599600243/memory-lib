# 待办清单（BACKLOG）

> 唯一清单，别再开第二份。按"有时间的排前面"排序。
> 建立于 2026-10-21，随收口更新。每条都要能回答：**为什么做、做了怎么算成功、谁验**。

## 1) VISIBILITY-UNKNOWN-1：`visibility=private` 的放行漏洞（潜在，非现行泄漏）

- **现象**：`principalAllowsContainer` 的 `private` 分支按 `p.user_id === user` 判；当**记忆自身**的 `user_id="unknown"`、且 principal 也带 `user_id="unknown"` 时会放行。
- **来源**：INDEX-1 验收岗追查 df 分母变化时挖到（与本单无关）。
- **现状**：生产 principal 是真实身份，**当前不漏**。
- **要不要做**：要。属权限模型，不能靠"现在没触发"活着。
- **成功判据**：`unknown` 不再作为可匹配身份；单测覆盖"记忆 user_id=unknown + principal user_id=unknown"必须拒绝；不改其他可见性语义。
- **注意**：这单会动权限判定，**必须由验收岗独立构造第三份用例**，不能只用开发自己的测试。

## 2) 短问句检索为空（两字关键词永不出结果）

- **现象**：问「8层」「验收」「提炼」这类**两字**问句，命中恒为 0（实测）。
- **根因**：`queryTokens` 对中文切二元组后只有一个 2 字 token，而 `scoreTokens.enough` 要求"命中 ≥2 个 token 或命中一个 ≥4 字词"⇒ 2 字单 token 天然不达标。
- **为什么重要**：用户最短的问法恰恰是最常见的（"验收呢""提炼呢"）。
- **成功判据**：两字键能命中（但不能放宽到返噪：要有"够格"的替代判据，例如结合近 N 天范围或称谓/名词表），且 20 条既有回归不退化。
- **风险**：容易变成"什么都返"，必须守住"宁可少给"。

## 3) 一条装饰性断言（测试抓不到回退被删）

- **现象**：`plugin-inject.test.mjs` 的「入队+落盘去重」那条，把去重分支改成 `if (false && …)` 仍然绿。
- **成功判据**：改成 `if (false && …)` 后该测试必须**变红**。
- **成本**：很小，攒到下一单顺手做。

## 4) 隔夜清空提炼积压没有被沉淀成记忆

- **现象**：问「提炼积压是怎么清空的？」→ 命中 0 条。
- **说明**：那次清空只有产品岗会话知道，没进库。属采集/提炼覆盖问题，不是注入 bug。
- **要不要做**：先观察——如果"操作类事实"普遍没被记住，才值得查提炼提示词。

## 5) harness：空 `justification` 应视为未传

- **现象**：gpt-5.6-sol 会给 `pwsh`/`write`/`edit` 填满所有可选字段，`justification:""` 被 `@deepseek-ai/dsh-sandbox` 的 `validateEscalationArgs` 拒（`invalid justification`），模型原地重试。
- **后果**：该模型在本机**无法写文件**，岗位卡只能用 deepseek。
- **改法**：`validateEscalationArgs` 里把空串当未传；或本会话已是 `danger-full-access` 时忽略 `sandbox_permissions`。
- **代价**：需重启 DSH；属改 harness，涉及全局，需用户点头。

## 6) DSH 压缩不能分块（换小窗模型必死）

- **现象**：超窗会话（开发岗8 41.6 万 token / 验收岗4 21.7 万 token）压缩时 `pi-ai detected context overflow` + `stream ended`，反复失败。
- **现状**：用户口径"以后升级就好了"。
- **规避**：换模型前先量 `messageTokens`，超过目标窗口就别切，直接开新卡。

## 7) 提炼没有定时任务

- **现象**：`schtasks` 需管理员，目前只在对话触发时跑（约每次 10 条，新优先）。
- **现状**：待办积压为 0，暂不痛。
- **触发条件**：有管理员权限时再加。

## 8) INDEX-1 的 1 万条 p95（461ms）偏高

- **现象**：1 万条规模 p50 125ms 很好，但 p95 461ms；高的那几条是**回退全量扫描**的问句。
- **现状**：现库 1445 条，p95 76ms，远未触线。
- **触发条件**：现库接近 5000 条时再看回退比例；若回退占比上升，再优化"2 字关键词"的粗筛（与第 2 条同源）。

---

# 更新（2026-10-22 记忆库主链路收口后）

| # | 项 | 状态变化 |
|---|---|---|
| — | RANK-1 / IN-PLUGIN-3 / IN-PLUGIN-4 / INDEX-1 / INDEX-2 | **已全部上线并通过真机验证**，详见 `docs/CLOSEOUT-2026-10-22-memory-mainline.md` |
| 1 | `VISIBILITY-UNKNOWN-1` | **仍未做**。属权限模型，唯一涉及权限的遗留，建议下一单优先 |
| 2 | 两字问句检索恒空 | 仍未做。INDEX-2 引入了两字 LIKE 补候选，但 `scoreTokens.enough` 门槛未动 ⇒ 「验收」「8层」仍命中 0 |
| 3 | 装饰性断言（入队+落盘去重） | 仍未做 |
| 4 | 隔夜清空积压未沉淀成记忆 | 观察到一次；仍观察 |
| 5 | harness 空 justification 补丁 | **已打并生效**（`index.js.bak-patch-20261022-031659`）；⚠️ **DSH 升级会覆盖**，升级后需重评 |
| 6 | DSH 压缩不能分块 | 未变（等升级） |
| 7 | 提炼无定时任务 | 未变（待办已清零，不痛） |
| 8 | INDEX 系 1 万条 p95 | INDEX-2 实测 176 问 p95 110ms；5k/10k 仍有较多 full 回退，量级上升时再看 |
| **新 9** | **DSH 升级到 0.2.1-rc.2** | 用户口径已满足（记忆库主链路收口）⇒ **可启动**。步骤：快照 node_modules/配置 → 读 breaking change → 升级 → 按验证清单确认插件/注入/MCP/模型 → 不行回滚。**注意第 5 条补丁会被覆盖** |
| **新 10** | 异地备份重试策略 | 2026-10-22 04:00 GitHub 连接失败导致断推一次（10:02 手动补推成功）。建议改 3–5 次指数退避 + 连续失败告警 |

---

# 更新（2026-10-26 23:4x）：两单已收

| # | 项 | 结果 |
|---|---|---|
| 3 | 装饰性断言（入队+落盘去重） | ✅ **已修**。`plugin-inject.test.mjs` 的「同一轮只注入一次」原本清不掉 receipt 就分不清是谁挡的；现改为：先 `resetReceipt()` 再断言第二次 assemble 为空 **且 brief 次数不增**。判据已验证：把 `if (st.served)` 改成 `if (false && st.served)` ⇒ **2 条测试变红**（正常时 17/17 全绿，恢复后仍 17/17）。 |
| 10 | 异地备份重试策略 | ✅ **已改**。`D:\MemoryArchive\live\snapshot.ps1`：push 重试 1 次/15s → **5 次指数退避**（15/30/60/120s），并加**连续失败计数**（`snapshot-consecutive-failures.txt`，≥2 次写 `ALERT`），成功即清零。已实跑验证：`attempt 1/5` 成功，推上 `8ca4f16`，`origin 领先 0`，stamp 已更新（补上了 10-23～10-26 三天的空档）。 |

**剩余未做**：`VISIBILITY`/两字问句已上线；`隔夜清空积压未沉淀成记忆`（观察中）、`DSH 压缩不能分块`、`提炼无定时任务`、`1 万条 p95`（量级未到）。

---

# 更新（2026-10-27）：CONSOLE-1 期间发现的既有红灯

**`inject1-brief-memories.test.mjs` 的「≤600 字上限 + 超了要打 truncated」一直失败**，且**不是任何近期单引入的**：

```
在 504277a（SHORT-Q-1 之前）       pass 5 / fail 1   ← 同样失败
在 44ec808（SHORT-Q-1 之后）       pass 5 / fail 1
在 a7b5fc1（CONSOLE-1 之前）       pass 5 / fail 1
```

⇒ 早于 SHORT-Q-1 就红了，只是之前的验收只看 176 问对撞、没跑全量。

**待办**：查这条测试为何红（断言"撑爆预算时必须打 truncated 标记"，实际没打）。可能原因：`boundBrief` 的 truncated 标记只在某种路径下写，或测试构造的超长记忆被 RANK-1 的整句打包/丢弃策略先一步处理掉了。修之前**不许改判据**（不许把断言放宽成"要么截断要么丢弃"）。

---

# FIX-ROT-1 收口（2026-10-27）

**那条长期红灯的真因：测试 fixture 的日历腐烂，不是产品缺陷。**

`inject1-brief-memories.test.mjs` 把 20 条记忆的 `calendarDate` 写死为 `2026-10-01…2026-10-20`，
而 `recallBrief()` 默认只取**最近 7 天**；到 10-27 时那批记忆几乎全部过期 ⇒ 候选只剩 1 条 ⇒ `dropped=0` ⇒ `truncated=false`。

实测（同 fixture，只改窗口）：`days=7` ⇒ included=1/dropped=0/truncated=false；`days=30` ⇒ included=4/dropped=16/truncated=true。
⇒ **断言的期望是对的，是 fixture 过期了。**

修复（`0822ae6`）：日期改成相对今天；**原断言一字未改**；新增 `assertFixtureInsideDefaultWindow()` 防复发
（fixture 日期必须覆盖默认窗口的 7 个日历日，否则当场红）；并加了 `anchorOffsetDays` 的 +30 天对照。

复验：

```
R1  inject1-brief-memories.test.mjs   6/6
R2  窗口自检 + anchorOffsetDays 对照   均在
R4  diff 只有 fixture 行（9 行删除全是旧日期/旧常量），断言未动
R5  干净 worktree（0822ae6）与活目录   都 6/6
R3  全量 runner → ALL TEST FILES PASSED（退出码 0）  ← 全仓第一次真全绿
```

**教训**：凡是依赖"最近/近 7 天/按天"的测试，**不许写死绝对日期**；否则到某一天会自己变红，且看起来像代码回归。

---

# 接入工具链冻结（2026-10-28）

**V1–V3 复验通过，接入工具链（agent-discover / agent-scaffold / capture-tail）冻结**：

```
V1 validate 只读：两次连跑 exit=0，sha256 235700C04696 三次一致   ✅
V2 --write 仍写 configPathVerified（openclaw 实测 False）        ✅
V3 全量 runner：ALL TEST FILES PASSED, exit 0                    ✅
```

**冻结含义**：不再给这条链加能力、不再改渲染、不再改探测表。只接受**缺陷修复**（安全/正确性），
且必须能过 V1（只读校验）与全量 runner。

**为什么冻结**：产品方向已定 —— 1-2-3 通用（服务 + MCP/HTTP + 侧车），4 逐家适配（注入插件）。
真正缺的已从"接入工具链"转移到**可部署性**（install/doctor/README）与**注入契约**。

---

# 挂起（PARKED）：QQ / 群聊机器人试点 —— 等主线规范完善后再开始

**用户决定（2026-10-28）**：「等我们这个主线规范完善结束后开始吧」

## 为什么值得做

用真实群里说话的 agent 压测记忆库，能验到我们自己测不出的东西：24/7 侧车稳定性、真实口吻的召回质量、重启韧性、多身份隔离、审计可追。

## 但先要满足的前提（不做完不启动）

1. **DEPLOY-1 收口**（别人能装起来，否则试点只能在你这台机器上）；
2. **INJECT-SPEC（4 的注入契约）** 落地 —— 否则机器人只能"自己想起来调 brief"，质量不稳；
3. 规范 v2 定稿（三能力 + 四自证 + apply 三形态 + 健康三形状）。

## 启动时的红线（先写下来，免得以后心软）

- 机器人身份**永远** `reader`（只读 curated/shared）+ 单独的 `capture-ingest`（只写 evidence），**绝不给 `librarian-admin`**；
- **不自动发言**（不碰 B 站评论、不刷屏）——那是平台风控的雷；
- 群聊写回默认**只捕获 @ 机器人 的对话**，不把别人的闲聊入库；
- 试点先用**临时数据根**（`--data-root` 指到别处），确认稳了再接生产；
- 判据：跨身份零泄漏（负样本全拒）、p95 检索 < 300ms、72h 0 重复 0 漏采、重启 3 次幂等。

## 阶梯

```
Phase 1 单机器人 + reader + 单人测试群
Phase 2 72h 高频压测 + 重启 3 次
Phase 3 多 agent 共库（DSH + 机器人 + OpenClaw）→ 看 Agents 视图能否分别归因
Phase 4 才有资格谈"超级枢纽"（配额/租户/计费）
```
