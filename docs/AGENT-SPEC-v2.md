# AGENT-SPEC v2：通道接入规范

> 制定：2026-10-30。前置：`docs/AGENT-SPEC.md`（v1，管"有循环的 agent 怎么读写记忆"）。
> 本文只管**另一类接入**：本身没有对话循环的外部入口（QQ、微信、飞书、桌面宠物…）。
> 动机：大肥鱼（NapCat QQ）接入时，记忆库只占 2 个调用点，却写了 1,134 行 —— 因为"通道"没被规范覆盖，于是把循环、策略、人格全写进了适配器。

## 0. 两类接入，规则不同

| 类型 | 例子 | 已有规范 | 谁负责循环 |
|---|---|---|---|
| **A. 有循环的 agent** | DSH、OpenClaw、Codex | v1（三能力 + manifest + 四条自证） | 它自己 |
| **B. 无循环的通道** | QQ、微信、飞书、桌面宠物 | **本文（v2）** | **记忆库提供的循环** |

判定标准：**它会不会自己决定"该说话了"并组织一轮对话？**
- 会 → A 类，按 v1 接入
- 不会（只会把收到的消息交出来）→ B 类，按本文接入

## 1. 三层职责（每层只准做自己那摊事）

```
┌──────────────────────────────────────────────┐
│ ① 适配器        adapters/<通道>/             │  写代码，≤ 300 行
│   收消息 → 标准化；发消息 ← 回复文本          │
│   ❌ 不准调模型  ❌ 不准拼提示词  ❌ 不准读写记忆 │
├──────────────────────────────────────────────┤
│ ② 循环          memory-lib 提供              │  不写代码，调接口
│   记忆 brief → 组装上下文 → 调模型 → 写回      │
├──────────────────────────────────────────────┤
│ ③ 策略          config + persona 文件         │  写配置，不写代码
│   何时回、限流、群礼仪、主动插话、人格          │
└──────────────────────────────────────────────┘
```

**判定法**：适配器里出现 `fetch("https://api." 模型地址)`、`persona.md`、`groupMaxPerMinute` 这类东西，就是越界了。

## 2. 适配器契约

### 2.1 必须实现的两个动作

```js
// 收：通道原始事件 → 标准消息
toMessage(raw) => {
  channel: "napcat",          // 与 identities.json 的 channel 一致
  channelUid: "2782017190",   // 通道内唯一 ID（QQ 号 / openid / 群号）
  scope: "private" | "group",
  groupId?: "1000000",      // scope=group 时必填
  text: "……",
  atMe?: boolean,             // 是否 @ 了机器人（用于策略判断）
  replyToMe?: boolean,        // 是否引用回复了机器人
  messageId: "……",            // 用于幂等去重
  at: "2026-10-30T23:00:00+08:00"
}

// 发：回复文本 → 通道动作
send({ channelUid, scope, groupId, text, replyToMessageId }) => Promise<void>
```

### 2.2 每轮调用顺序（固定，不许交换）

```
1. 身份映射   resolveIdentity({ channel, channelUid })  → { agentId, userId, displayName }
                （唯一入口见 §3；解析失败 → 丢弃并记日志，不要猜）
2. 网关判断   policy.shouldHandle(message, identity)     → 不回就直接结束（0 次模型调用）
3. 读记忆     POST /v1/recall/brief（principal = 该身份，query = 当前消息）
4. 组装+调用  POST /v1/chat/turn（或共享包，见 §4）
5. 写回       POST /v1/conversations/capture（evidence，原文）
              可选：POST /v1/write（群回合等结构化落库）
6. 发送       send()；失败重试 ≤ 2 次，仍失败 → 计入告警
```

### 2.3 硬性要求

| 要求 | 判据 |
|---|---|
| **幂等** | 同一 `messageId` 重复投递，只处理一次（内存 TTL ≥ 10 分钟） |
| **单实例** | 同一通道只允许一个进程在跑（文件锁），否则重复回复 |
| **降级可见** | 读记忆失败/模型失败/写回失败**各打一条带原因的日志**，不许静默变空白回复 |
| **超时** | 读记忆 ≤ 3s、模型 ≤ 60s、写回 ≤ 10s；超时按失败处理并记录 |
| **不阻塞** | 写回失败不得让回复失败（记忆是可降级的），但必须留痕 |

## 3. 身份映射：唯一入口，禁止自解析

```
唯一允许的方式：scripts/identity.mjs（读 data/runtime/identities.json + identity.json）
唯一允许的落库方式：node scripts/identity.mjs add --channel <ch> --uid <uid> --template <模板>
```

**禁止**适配器自己拼 `user_id`、自己猜 agent、自己复制角色。

> 事故记录：2026-10-30，米汐的 agent 与开发会话共用 `user_id=user-owner`，导致她读到我全部开发记忆。根因就是身份由适配器自己决定，而不是走注册表。

新身份一律用模板（`config/role-templates.json`，见 `docs/IDENTITY-TEMPLATES.md`），落盘前自动校验。

## 4. 循环：两个方案（待拍板）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | memory-lib 暴露 `POST /v1/chat/turn` | 所有通道共享同一循环；升级只改一处 | 记忆库承担模型调用，进程内压力变大 |
| B | 抽成独立 npm 包，适配器 import | 部署解耦 | 版本同步、依赖管理成本 |

接口形状（A 方案）：

```
POST /v1/chat/turn
{
  credential_ref, secret,
  principal: { agent_id, role_id },
  channel, channel_uid, scope, group_id,
  messages: [{ role, content }],     // 最近 N 轮（适配器提供）
  current: "当前消息",
  memory: { query, memories: 5 },    // 读记忆的参数
  persona_ref: "soul/dafeiyu"        // 人格包路径（服务端读）
}
→ { reply, used_memories: [...], model, elapsed_ms, degraded?: [...] }
```

**推荐 A**：大肥鱼 1,134 行里约 700 行是循环与提示词组装，A 方案能直接砍掉。

## 5. 策略配置（不写代码）

```json
{
  "channel": "napcat",
  "groupAllow": ["1000000"],
  "trigger": { "requireAtOrName": true, "requireReplyToMe": true, "engageEnabled": false },
  "limits": { "maxPerMinute": 6, "minGapSeconds": 25, "maxPerDay": 0 },
  "proactive": { "enabled": false, "minMinutes": 15, "maxMinutes": 45, "probability": 0.45, "quietHours": [2, 9] },
  "context": { "transcriptLines": 20, "bufferSize": 30 },
  "persona": { "ref": "soul/dafeiyu", "stripActionsInGroup": true }
}
```

字段语义必须与 `NAPCAT-RUNTIME.md` 对齐；新通道复制一份改值即可。

## 6. 验收（通道版四条自证）

| 自证 | 怎么证明 |
|---|---|
| **C1 身份正确** | 私聊发一条 → 该条记忆的 `user_id` 等于注册表里该通道 UID 的 `user_id` |
| **C2 隔离成立** | 用 A 的身份查 B 的记忆 → 0 条；控制台按身份查询能看到各自的 |
| **C3 降级可见** | 停掉 8787 → 给机器人发消息 → 日志出现"读记忆失败"且仍能回复（或明确不回），不是静默空白 |
| **C4 限流生效** | 1 分钟内连发 20 条 → 实际回复数 ≤ `limits.maxPerMinute` |

## 7. 迁移路径（大肥鱼瘦身）

```
现状  1134 行（index.mjs 765 + resolve.mjs 349）
目标  ≤ 400 行：协议收发 + 身份映射 + 策略钩子
砍掉  循环与提示词组装 → 交给 /v1/chat/turn
保留  触发判断、限流、群缓冲、去重（这些是"策略"，但当前写在代码里）
后续  策略再逐步搬进 policy.json
```

**顺序**：先加 `/v1/chat/turn`（服务端）→ 适配器切过去 → 差分验证（同一批消息，新旧回复行为一致）→ 删旧代码。

## 8. 未决事项（需拍板）

1. 循环方案 A 还是 B（§4）
2. 适配器是否允许直接调模型（当前建议：禁止）
3. 策略配置放 `config/channels/<ch>.json` 还是 `adapters/<ch>/policy.json`
4. 桌面宠物这类"常驻、主动"的通道，是否复用同一套 proactive 策略
