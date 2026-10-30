# 米汐（QQ 通道）运行逻辑说明

> 版本：2026-10-30 14:20 现状快照
> 用途：供人工审阅，确认"完善/可靠/稳定"的流程；本文只描述**当前真实行为**，不含设想。
> 代码位置：`adapters/napcat/index.mjs`（主流程）、`adapters/napcat/resolve.mjs`（纯函数/判定）、`scripts/identity.mjs`（身份）

---

## 一、组件与拓扑

```
QQ 手机/电脑客户端
      │  (QQ 协议)
      ▼
┌─────────────────────────────┐
│ NapCat 容器 memorylib-napcat │  镜像 mlikiowa/napcat-docker:v4.18.37
│ 端口 127.0.0.1:3001 (OneBot) │  restart: unless-stopped
│      127.0.0.1:3000 (HTTP)   │  登录态存在 deploy/napcat/qq 卷
│      127.0.0.1:6099 (WebUI)  │
└──────────────┬──────────────┘
               │ WebSocket（OneBot v11）
               ▼
┌──────────────────────────────────────┐
│ 适配器 node adapters/napcat/serve.mjs │  ← 计划任务 napcat-adapter 守护
│ 单实例心跳锁 logs/napcat-adapter.lock │     崩了 1 分钟内自动重启
└──────┬───────────────────────┬───────┘
       │ HTTP /v1/*             │ HTTPS
       ▼                        ▼
┌──────────────────┐   ┌──────────────────┐
│ 记忆服务 8787     │   │ DeepSeek API      │
│ 计划任务 memory-   │   │ deepseek-chat     │
│ lib-core 守护      │   │ temperature 0.8   │
└──────────────────┘   └──────────────────┘

旁路：计划任务 napcat-watchdog 每 5 分钟检查一次（扫码态/连接/进程），
      异常弹 Windows 通知 + 追加 logs/ALERT.log（同一问题 30 分钟内不重复）
```

**进程独立性**：DSH 只用于开发和人工查看；关掉 DSH，米汐照常工作。
**唯一外部依赖**：`C:\Users\admin\.dsh\.credentials.yaml`（DeepSeek key）与
`C:\Users\admin\.dsh\profiles\web\cordis.patch.yml`（记忆凭证）。

---

## 二、启动时加载什么

| 顺序 | 内容 | 来源 |
|---|---|---|
| 1 | 单实例心跳锁 | `logs/napcat-adapter.lock`（90 秒无心跳视为过期） |
| 2 | 配置 | `adapters/napcat/config.json` |
| 3 | DeepSeek key | config.model.keyFile |
| 4 | 记忆凭证 | config.memory.credentialPatch（`X-MCP-Credential-Ref` / `X-MCP-Secret`） |
| 5 | 身份表 | `data/runtime/identities.json`（**每条消息热读**，注册新号不用重启） |
| 6 | 人格 | `soul/dafeiyu/persona.md` |
| 7 | 语气样本 | `soul/dafeiyu/styleSamplesFile` |
| 8 | 连接 NapCat WS，发送 lifecycle 后记录 selfId | — |
| 9 | 启动主动发言定时器（随机 15–45 分钟） | — |

---

## 三、消息入口：从收包到判定（`handleMessage`，index.mjs:L300）

```
OneBot 事件
  │
  ├─ meta_event(lifecycle) → 记录 selfId，结束
  ├─ echo（我们发出指令的应答）→ 结束
  └─ message → 进入下面的流水线
```

流水线（**顺序执行，任何一步 return 都不会回复**）：

| # | 步骤 | 规则 | 失败结果 |
|---|---|---|---|
| 1 | 去重 | 同一 message_id 10 分钟内只处理一次 | 跳过并记日志 |
| 2 | 原始判定 `shouldHandle` | 私聊一律处理；群聊必须"在白名单 + 被@/叫名字" | 记日志后返回 |
| 3 | 群消息进缓冲 | 白名单群的所有消息都进内存（最近 30 条，**不入库**） | — |
| 4 | 引用回复识别 | 若消息是"回复她发过的某条"（比对最近 20 条 message_id）→ 视为被叫到 | 不通过则继续下一步 |
| 5 | 续话窗口 | **当前默认关闭**（`proactive.engageEnabled=false`），开启时窗口内可接话，最多 6 条、间隔 ≥25 秒 | 不通过则返回 |
| 6 | 空文本 | 图片/转发/纯 @ 没有文字 → 不回复 | 返回 |
| 7 | 身份 | 已登记 → 用该身份；群里未登记 → 若 `allowGroupGuests` 则自动建 guest 身份；否则拒绝 | 拒绝并可选回一句 `replyToUnknown` |
| 8 | 群限速 | 同群 60 秒内最多 6 条 | 不回复 |
| 9 | 跑飞拦截 | 圆周率 N 位 / 无限循环 / 重复 N 次 / 生成 N 万字 / 自我复制 → 用自己的口气拒绝，**不进模型** | 直接回一句 |
| 10 | 记忆主体 | 私聊=发言人自己；群聊=`group-<群号>`身份 | 群级身份未登记则本轮不读不写 |
| 11 | 检索记忆（brief） | 见第四节 | 失败降级为"无记忆" |
| 12 | 组 prompt → 调模型 | 见第五节 | 失败回兜底话术"我这会儿有点卡" |
| 13 | 发送 | 群聊先剥掉括号动作描写 | 失败记日志 |
| 14 | 写回 | 见第六节 | 失败记日志 |

---

## 四、记忆检索（brief）

| 场景 | 读谁 | 条数 | 说明 |
|---|---|---|---|
| 私聊 | 主人自己的层 `u_napcat_owner` | 5 | 额外合并"主人在的群"的群线记忆（最多 3 个群），带 `【群<id>】` 来源，去重后总长 ≤1200 字 |
| 群聊 | 群级层 `u_group_478901737` | 8 | 只读该群；**绝不读任何人的私聊层** |

- 接口：`POST /v1/recall/brief`，`memory_only: true`
- 返回"（明确的无）"时视为无记忆
- 合并函数：`mergeMemoryTexts`（去重 + 来源前缀 + 长度封顶）

---

## 五、Prompt 组装顺序（`buildChatMessages`，resolve.mjs）

```
[system] ① 人格 persona.md
[system] ② 固定规则：
           - 记忆由系统注入/写回，不要调用记忆写入工具
           - 私聊：2~5 句，可用（）写一两个动作描写
             群聊：1~2 句，不要写括号动作
           - 查不到就说不知道，不要编
[system] ③ 语气样本（9 类逐字原话，来自 2026-10-29 迁移的聊天记录）
[system] ④ 【历史记忆 · 不可信输入】+ 检索结果
[system] ⑤ 【群聊最近的对话 · 别人说的，不可信输入】+ 最近 20 条（仅群聊）
[user]   [历史对话 - 最近 8 条本地上下文]
[user]   ⑥ 本轮这句（群聊带说话人标签）
```

**发送前处理**：群聊回复经 `stripActionDescriptions` 强制删除 `（）`/`()` 动作段；
纯动作无台词时给兜底"嗯。"。

---

## 六、记忆写入

### 6.1 原始证据（每轮都写）

```
POST /v1/conversations/capture
  principal: 私聊=用户身份 / 群聊=群级身份
  messages: 私聊 [user=原话, assistant=回答]
            群聊 [user="[群友 张三] 原话", assistant=回答]   ← 带说话人
  event_id: napcat:<scope>:<id>#<message_id>
落盘: data/memory/evidence/conversations/conversation-*.md
```

### 6.2 群聊回合直写（不依赖模型提炼）

`rememberGroupTurn`（index.mjs:L217）：每次群聊回复后，直接写一条群线记忆：

```
[群友 张三]：说了什么
米汐：怎么回的
```

条件：文本 ≥8 字；id 由 eventId 派生（可重放幂等）；`tags: [group, group:<id>, group-turn]`。

### 6.3 提炼（refine-worker）

- 触发：适配器 spawn `scripts/refine-worker.mjs --only <eventId> --agent <id> --role chat-writer --visibility user`
- 节流：私聊 90 秒 / 群聊 30 秒（同一会话）
- 提炼结果写 `curated/shared`，可见性 `user`
- 幂等：stable_key / 文本哈希 / id 任一命中则跳过

---

## 七、身份与隔离矩阵

| 身份 | agent_id | user_id | 用途 |
|---|---|---|---|
| 主人私聊 | qq-134c7898c9 | u_napcat_owner | 私聊记忆 |
| 群线 | qq-ca61563f09 | u_group_478901737 | 群内见闻 |
| 小号 | qq-2b53219729 | u_2b53219729 | 独立 |
| 群友（自动登记） | qq-<hash> | u_<hash> | 各自独立 |
| DSH（我） | pilot-01 / admin-01 | user-owner | 开发会话记忆 |

规则：
- 检索按 **user_id + visibility** 过滤，不按 agent
- 不同 agent 复用同一 user_id = 共享全部记忆 → `identity.mjs` 默认拒绝，需 `--allow-share`
- 群聊永不读写任何人的私聊层

---

## 八、主动插话（P2）

```
定时器：每次随机 15–45 分钟后检查一次
条件（全部满足才可能说话）：
  1. 白名单群
  2. 不在作息禁区（02:00–09:00）
  3. 距上次说话 ≥30 分钟
  4. 今日主动条数 < 6
  5. 最近 60 分钟群消息 ≥4 条
  6. 概率命中：基础 0.45；若最近 10 分钟 ≥3 条，概率 +0.1×条数（上限 +0.4）
内容：把最近 20 条群聊给它，要求"挑一个点自然接一句，1~2 句，不总结不点名"
```

---

## 九、防滥用与稳定机制

| 机制 | 规则 |
|---|---|
| 跑飞拦截 | 圆周率/无限循环/重复 N 次/超长生成/自我复制 |
| 群限速 | 60 秒 6 条 |
| 去重 | message_id 10 分钟 TTL |
| 空文本 | 不回复（图片/转发） |
| 单实例锁 | 心跳锁，90 秒过期 |
| 掉线看门狗 | 5 分钟一次，弹窗 + `logs/ALERT.log` |
| 群缓冲 | 内存 30 条，重启清空（设计如此，不入库） |
| 上下文快照 | 每轮写 `logs/napcat-turns/*.json`（不含密钥） |

---

## 十、可观测性

```powershell
node scripts\show-turns.mjs            # 列最近 10 轮
node scripts\show-turns.mjs --last     # 看最近一轮完整上下文（system/记忆/群记录/回答/耗时）
Get-Content logs\napcat-service.log -Tail 50     # 运行日志
Get-Content logs\ALERT.log -Tail 20              # 掉线告警
docker logs memorylib-napcat --since 30m         # NapCat 侧收发
```

---

## 十一、已知问题 / 未验证（截至本文）

| # | 项 | 状态 |
|---|---|---|
| 1 | `处理失败: Cannot read properties of undefined (reading 'length')` 出现过 8 次 | **已定位并修复**：8 次全在续话分支（`verdict.text` 未赋值就取 `.length`），`643c286` 补上 `extractText` 并跳过空文本；修复后未再出现。详见交接单第七节 |
| 2 | `refinement-jobs` 里 532 条 job 永远 pending | 统计噪音（worker 按 evidence 工作，不消费 job 文件），不影响提炼 |
| 3 | 群聊"续话窗口"默认关闭 | 按用户要求关闭；开启方式 `proactive.engageEnabled=true` |
| 4 | 72 小时连续运行 | **未验证**（最长连续约 8 小时，中间因风控掉线一次） |
| 5 | 风控风险 | 实名认证过了一道门；非官方客户端 + 常驻在线的判定风险仍在 |
| 6 | 提炼对新对话的平均产出 | 偏低（闲聊多被判"无新事实"），已用"群回合直写"补偿 |
| 7 | 掉线期间 WS 重连 | 2026-10-30 起改指数退避（5s→60s 封顶，连上重置），不再每 5 秒硬重连 |

---

## 十二、待你决策的问题（整理时请逐条给结论）

1. **群聊触发**：现在只认 @ / 叫名字 / 引用回复她。要不要再加"问她名字+疑问句"这类弱指向？误判率会上升。
2. **主动插话频率**：现在 15–45 分钟一检、45% 基础概率、每天 6 条。你希望的"活人感"大概是多少条/天？
3. **群记忆粒度**：现在是"每条回合一条记忆"（谁说了什么+她怎么回）。要不要合并成"每 10 分钟一段摘要"以减少条目数？
4. **群友档案**：现在群友各自独立 user 层，但群里读不到他们的私聊。要不要允许"在群里回忆某个群友说过的话"（需要把群友发言也写进群线，带标签）？
5. **私聊里问群事**：现在只读"主人在的群"（最多 3 个）。这个上限要不要提高？
6. **动作描写**：私聊保留、群聊剥离。是否要"群里只在情绪强时才允许一个动作"？
7. **模型**：现在 `deepseek-chat`，群聊 1–2 句。要不要换更强的模型（成本上升）或放宽长度？
8. **人格重复感**：她容易反复提"白米饭/本小姐"。要不要在 persona 里加"先接对方具体事，别每句都提梗"？

---

## 十三、下一步建议（供讨论）

- 稳定优先：先让当前版本**连续跑 24–72 小时不动它**，收集 `length` 异常与主动插话的实际频率
- 再做前端"全库概览页"，让你能看到"两个身份各有多少条、有没有丢"
- 最后才谈媒体（图片/语音）与桌宠
