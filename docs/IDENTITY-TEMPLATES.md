# 身份与角色模板（2026-10-30）

> 目的：新增身份时**只填关键字符**，不复制权限配置、不写代码。
> 权限与隔离在服务端强制执行（`authorizeAction` + `principalAuthorizesPath`），
> 模板只决定"这个身份被授予哪些动作与范围"。

## 一条命令加一个身份

```powershell
node scripts\identity.mjs add --channel napcat --uid 2782017190 --name 小号 --template chat-guest --dry-run
```

去掉 `--dry-run` 才落盘。命令做两件事：

1. 在 `data/runtime/identity.json` 里按模板建 agent + 角色（自动填 `user_id`）
2. 在 `data/runtime/identities.json` 里写"渠道 UID → agent/user" 映射

## 可用模板（`node scripts\identity.mjs templates` 查看）

| 模板 | 适用 | 动作 |
|---|---|---|
| `chat-guest` | 群友、小号（默认，最严格） | `search,get` + `propose` |
| `chat-owner` | 通道主人（米汐） | 同上 + 群级写入 |
| `reader` | 纯读 | `search,get` |
| `writer` | 只提候选 | `propose` |
| `researcher` | 读 + 提候选（含知识库/项目） | `search,get,propose` |
| `steward` | 管家（审核/晋升/废弃） | + `review,promote,deprecate` |
| `admin` | 管理员（唯一可跨身份读） | 全部 + `admin` |
| `learner` | 学习助手 | `learning` |
| `pet` | 宠物 | `search,get,learning,pet` |

## 模板文件在哪

```
config/role-templates.json              ← 仓库里的唯一真相（可提交、可评审）
data/runtime/role-templates.json        ← 可选运行时覆盖（私有，改了优先生效）
```

**改模板 = 改 JSON，不改代码。** 只要不新增"动作种类"，权限调整全部是数据变更。

## 落盘前自动校验（`validateRoles`）

| 校验 | 失败表现 |
|---|---|
| 动作必须在词表内 | `未知动作 "export"（role xxx）；词表: search, get, …` |
| 含 `memory/user` scope 必须有 `user_id` | `role chat-reader 含 memory/user scope 但缺少 user_id` |
| 同一模板内 `role_id` 不可重复 | `模板内 role_id 重复` |
| 未知模板名 | 列出所有可用模板 |
| 不同 agent 共用 `user_id` | 拒绝，需显式 `--allow-share`（2026-10-30 串记忆事故的防线） |

## 什么情况必须改代码（模板无法覆盖）

- 新增**动作**（如"导出""批量删除"）
- 新增**可见性取值**（如 `team`）——判定逻辑目前散在 6 个文件
- 新增**隔离维度**（如按项目）——需要服务端检索层改造
