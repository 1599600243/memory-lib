# 交接单：米汐跨通道主体（方案 B，零迁移）

日期：2026-11-01
记忆库侧已生效，QQ 侧仍需改两处。**不改任何现有记忆。**

## 0. 一句话

`agent_id=qq-bot`、`user_id=u-owner` 是**规范主体**（不改名、不迁移）。
其他通道（console/desktop/web）通过**别名表**解析到这一对 id，claim 用同一对角色，写出来的记忆与 QQ 完全一致。

## 1. 记忆库侧已经做完的事（不用你们改）

| 项 | 现状 |
|---|---|
| `claim_allowlist` | 已从 `null` 收紧为 `["admin-01/librarian-admin","pilot-01/*","home-circle/*","work-circle/*","qq-*/chat-*"]`，39 个已注册组合全覆盖 |
| 未覆盖的 claim | 403 `CLAIM_NOT_ALLOWED`（已实测：临时去掉 qq 规则后请求被拒，恢复后放行） |
| `qq-*` 角色 | `chat-reader(search,get)` / `chat-writer(propose)`，带 `group_id="qq"`、`user_id="u-owner"`、`scopes=["memory/user"]` |
| 外部来源守卫 | `napcat-*`/`qq-*` 源禁止写 `shared`/`platform`；人线是 `visibility=user`，不受影响 |
| 检查脚本 | `node scripts/check-claim-allowlist.mjs` → 退出码 0 表示清单覆盖完整（以后加 agent 忘加清单会红） |

## 2. 你们要改的：`data/runtime/identities.json` 加别名

在**主人那条**记录上加 `aliases`（其他字段一个都别动）：

```json
{
  "channel": "napcat",
  "channel_uid": "your-org",
  "agent_id": "qq-bot",
  "user_id": "u-owner",
  "display_name": "主人",
  "role": "owner",
  "created_at": "2026-10-30T02:35:46.055Z",
  "aliases": [
    { "channel": "console", "channel_uid": "owner" },
    { "channel": "desktop", "channel_uid": "owner" },
    { "channel": "web",     "channel_uid": "owner" }
  ]
}
```

规则：
- 别名只是"同一主体的另一张嘴"，**不新增身份记录**（加了 alias 记录也不要写 agent_id/user_id，否则会出现两个主体）
- 以后加通道就在 `aliases` 里加一行，不用改代码

## 3. 你们要改的：`adapters/napcat/resolve.mjs` 增加别名解析
现有 `resolveIdentity(identities, {channel, uid})` 只做精确匹配。增加一层：

```js
export function resolveSubject(identities, { channel, uid }) {
  const direct = resolveIdentity(identities, { channel, uid });
  if (direct) return direct;
  const list = Array.isArray(identities?.identities) ? identities.identities : [];
  const canonical = list.find((x) =>
    Array.isArray(x.aliases) && x.aliases.some((a) => a && a.channel === channel && String(a.channel_uid) === uid)
  );
  return canonical ?? null;   // 找不到=默认拒绝，不要 fallback 到新建身份
}
```

`principalFor(identity, {read})` 不用改——它本来就只用 `identity.agent_id`。

console 适配器调用顺序：

```js
const identity = resolveSubject(identities, { channel: "console", uid: "owner" });
if (!identity) return reject("unknown-subject");        // 不给临时身份
const principal = principalFor(identity, { read: false }); // 写用 chat-writer
// 写入请求里只带 principal {agent_id, role_id}；
// 绝对不要传 user_id/group_id —— 由身份注册表里的角色决定
```

## 4. 验收（记忆库侧可复跑）

### 4.1 正例：console 身份能 claim

```bash
curl -s -X POST http://127.0.0.1:8787/v1/roles/list \
  -H "content-type: application/json" \
  -d '{"credential_ref":"memory-lib/deepseek-harness","secret":"<见 cordis.patch.yml>",
       "principal":{"agent_id":"qq-bot","role_id":"chat-reader"}}'
# 期望：HTTP 200，principal.agent=qq-bot
```

### 4.2 负例：未授权 claim 被拒

```bash
# 期望：HTTP 403 {"code":"CLAIM_NOT_ALLOWED"}（临时把 allowlist 收成只剩 admin-01 时可复现）
```

### 4.3 三条验收的落点

| 验收 | 怎么做 | 期望 |
|---|---|---|
| console 写一条，QQ brief 能读到 | console 用 `chat-writer` 写一条 → QQ 用 `chat-reader` 跑 `memory_recall_brief` | 同一条记忆出现（`user_id=u-owner`、`visibility=user`） |
| 审计只出现一个 agent | 查 `data/runtime/audit/access.jsonl` 里这两次写的 `agent` 字段 | 都是 `qq-bot` |
| 旧记忆一条不动 | 对比前后 `data/memory/curated/shared` 文件数与某条旧记忆 sha | 完全不变 |

## 4.5 外部通道 agent 的写入范围（2026-11-01 新增，记忆库侧已生效）

`qq-*` / `napcat-*` 身份的写请求：

| 目标 visibility | 结果 |
|---|---|
| `user`（人线）/ `private` / `agent` / `role` | 允许 |
| `shared` / `platform` | 403 `WRITE_SCOPE_DENIED`，detail=`EXTERNAL_AGENT_VISIBILITY_DENIED` |

原因：`shared`/`platform` 会把她的记忆放大到 qq 组/全员可见。
**所以 console 写"她自己的记忆"必须显式 `visibility:"user"`**——不传时 `curated-shared` 的默认是 `shared`，会被拒。

审计：写请求现在会记录目标 `container` 与 `visibility`（拒绝路径也记），可从 `access.jsonl` 直接查。

### 4.5.1 两条新增硬要求（2026-11-01 夜，记忆库侧已生效）

1. **必须传 `source`**（`"console"` / `"desktop"` / `"web"` / `"napcat-c2c"` …）
   —— 会落进记忆 frontmatter，用来区分"哪张嘴"；不传就分不清是 QQ 还是 console 写的。

2. **`evidence_refs` 必须指向真实证据**
   - `qq-*` / `napcat-*` 身份的写入会校验：引用不存在 ⇒ `400 EVIDENCE_REFS_NOT_FOUND`
   - 正确顺序：先 `POST /v1/conversations/capture` 拿 `evidenceId`，再用它写记忆
   - 合成 id（例如 `being:self-time:2026-...`）会被拒

> 历史遗留已补正（2026-11-01 02:07 起）：`mixi-self-bc6b22a4c6a292d1` 原先引用合成 id，
> 现在 **两条证据并存**：
> 1. `conversation-055e953b31628e5a056704f5`（`source: being-self-time`，数据面补的 capture，主证据）
> 2. `evidence/documents/recovered-mixi-self-bc6b22a4c6a292d1.md`（从记忆正文回收的文档，标注 self-reported，只记录"原始 capture 曾缺失"这件事）
> `evidence_refs` 同时列了两条；tags 有 `recovered-evidence`。原文件备份为
> `*.bak-recovered-20261101-020744`。

## 4.6 分工（2026-11-01 定，防再撞）

| 面 | 归谁 | 具体 |
|---|---|---|
| **数据面** | QQ/being 线 | `data/memory/**` 里的**历史条目补正**（证据回填、frontmatter 修正、去重合并） |
| **接口面** | 记忆库线（我们） | 写入校验、可见性/证据规则、`capture`/`write` 接口、审计字段、测试 |
| **新写入** | QQ/being 线发起 | 只走 `capture → write`，`source` 必填、`evidence_refs` 必须真实 |

约定：**记忆库线不再修改任何已存在的历史条目**；发现历史数据问题时只出检查结果/建议，由数据面动手。
（本次补正属于越界操作，已记录：只动了这一条，且有备份与恢复文档。）

## 5. 边界（别越界）

- 不改可见性语义：`role` 私有仍绝对私有；人线仍是 `visibility=user`
- 不动 `data/memory/**`（本次零迁移）
- 群线 `u_group_1000000` 先不管（群是 QQ 概念，没做别名）
- 不要给未知通道自动注册身份（解析不到就拒绝，这是防劈成两半的关键）

## 6. 回滚

| 改动 | 回滚 |
|---|---|
| `identity.json` 的 allowlist | 恢复 `data/runtime/identity.json.bak-allowlist-20261101-003121` 后重启 `memory-lib-core` |
| QQ 侧 `identities.json` / `resolve.mjs` | 恢复 git 上一版；别名字段是纯增量，删掉即回到原行为 |
