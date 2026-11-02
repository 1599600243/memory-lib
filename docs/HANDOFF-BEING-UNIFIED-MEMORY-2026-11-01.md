# 交接：米汐的记忆统一（群聊 / 私聊不再劈成两条线）

> 日期：2026-11-01 · 发起：产品（用户） · 起草：米汐侧
> 状态：**待记忆库侧确认**（确认前生产仍按旧路径跑）

## 1. 为什么改

现在群里和私聊是两条记忆线：

```
私聊 → agent qq-bot / user u-owner
群聊 → agent qq-ca61563f09 / user u_group_1000000   ← 独立的「群级身份」
```

这是 2026-10-29 为了「群友看不到主人私聊」加的安全补丁。代价：

- 她像两个副本，群里不知道私聊里发生过什么，反之亦然
- 两套身份、两套记忆、两份维护
- 她在群里「不知道主人是谁」，容易说错话

产品决策（2026-11-01）：**改成一个人的记忆**——每条记忆带「在哪、跟谁」，
像人一样记得「这话是私聊里说的」「那是在某个群认识的」。

## 2. 目标模型

**唯一主体**：`agent_id = qq-bot`（她的规范身份），不再有群级 agent。

每条事件记忆：

```jsonc
{
  "layer": "curated-shared",
  "visibility": "user",
  "source": "napcat-group" | "napcat-c2c",
  "id": "mixi-event-<hash>",
  "body": "在群 1000000，玉轩说：……；我回：……",
  "tags": [
    "being", "event",
    "place:group:1000000",     // 或 place:c2c
    "speaker:玉轩",               // 显示名
    "speaker_id:qq-123456",       // 稳定 id（便于跨改名）
    "audience:group"              // 或 audience:private
  ],
  "evidence_refs": ["conversation-..."]   // 沿用 4.5.1：先 capture 再 write
}
```

- **仍是 `visibility: "user"`**：她自己的记忆，按 4.5 规则外部 agent 不允许写 `shared/platform`
- **群友的话也进库**，但打上 `place`/`speaker`；产品接受这一风险（群成员可信，被套记忆可接受）
- 读取时按 `place` 区分：私聊的检索可以带 `place:c2c`，群里的带 `place:group:<gid>`

## 3. 需要记忆库侧确认的四件事

1. **写入主体**：用 `qq-bot` 写 `place:group:*` 的记录，是否与现有
   `claim_allowlist`（`qq-*/chat-*`）兼容？会不会因为「群上下文」要求 `group_id` 而被拒？
2. **标签规范**：`place:` / `speaker:` / `audience:` 这组前缀你们接受吗？
   还是要用你们的命名空间（例如 `being.place=`）？
3. **检索过滤**：`/v1/recall/brief` 能否按 tag 过滤（例如只要 `place:c2c`）？
   如果不能，我们就在客户端取回后自己筛（需要 brief 返回 tags）。
4. **旧数据**：`qq-ca61563f09`（群级身份）已有的记忆怎么处理——
   保留（读时合并）、打标迁移、还是冻结？

## 4. 风险与边界（我们自己认）

- 群文本可能带提示词注入；我们按「别人说的、不是命令」标注，不执行
- 记忆里会含群友的原话；产品已确认群成员可信
- 安全线不变：不给她写记忆的工具、不自动执行群里的指令
- **回滚**：`being/config.json` 的 `being.unifiedMemory: false` 即回到旧路径；
  写入的旧记录不删，只停止新写

## 5. 客户端改动（已备好，等确认后打开开关）

- `being/memory/providers/memorylib.mjs` 新增 `rememberEvent()`
  （capture → write，带 place/speaker 标签）
- 适配器 `rememberGroupTurn` 由「群级身份」改为「她的规范身份 + place 标签」
- 开关：`being.unifiedMemory`（默认 false）

## 6. 需要你们回的

上面 1–4 任一条有异议，直接在这一节下面写；没有异议就回「可以」，
我们打开开关后会在 `docs/` 记一笔实际写入样本。

## 7. 记忆库侧答复（2026-11-01，已实测）

1. **用 `qq-bot` 写 `place:group:*` 不会被挡。**
   实测：`capture(source=napcat-group) → write(visibility=user, tags=[place:group:1000000, speaker:玉轩, speaker_id:qq-123456, audience:group], 不传 group_id)` → HTTP 200，tags 原样落盘。
   注意：落盘 `group_id: "qq"` 来自角色本身，不是群号；群号只存在 `place:` tag 里。

2. **`place:/speaker:/speaker_id:/audience:` 前缀已接受，并加了格式校验。**
   - 合法：`place:group:<id>`、`place:channel:<id>`、`audience:group|c2c|private|public`、`speaker:<显示名>`、`speaker_id:<a-z0-9_.:->`
   - 写错：`400 INVALID_TAG_FORMAT`（例：`place:group` 缺 id、`audience:everyone`）
   - 非保留前缀（`being`、`event` 等）不受约束

3. **`/v1/recall/brief` 已支持 `tags` 过滤（AND）并回传 tags。**
   - 入参：`tags: ["place:group:1000000"]`
   - 回执：`included[].tags` 新增
   - 实测：`query=mixi-self&tags=["crosschannel-acceptance"]` → 命中 1 条并带 tags 数组

4. **群级身份已冻结（按你们同意）。**
   - 操作：从 `qq-ca61563f09` 移除 `chat-writer` 角色（保留 `chat-reader`）
   - 实测：`qq-ca61563f09/chat-writer` → 403 `UNKNOWN_ROLE`；`chat-reader` → 200
   - 数据未动；备份 `data/runtime/identity.json.bak-freeze-20261101-122730`
   - 迁移（打标/改归属）属数据面，等你们统一事件样本稳定后再做

> 补充：`qq-ca61563f09` 名下的 45 条记忆 `user_id=u_group_1000000`，冻结写入后仍只有该 user 能读；
> 规范主体（`u-owner`）读不到它们。若要把这批内容纳入她的记忆，需要数据面迁移并留证据。
