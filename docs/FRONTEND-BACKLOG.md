# 前端 / 检索口径 待办（2026-10-30 凌晨记录）

> 状态：**暂停**。用户决定先把米汐（大肥鱼 QQ 通道）调试稳定，再启动前端计划。
> 本文只记录已核实的证据与修复方案，未做任何代码改动。

## 一、前端有 3 个"假功能"（点了永远空）

`app/memory-lib/web/console.html`（97KB，2026-10-27 最后修改）调用了服务端**不存在**的路由：

| 前端调用 | 服务端 | 影响 |
|---|---|---|
| `/v1/episodes/list` | ❌ 无此路由 | "会话"标签页永远空 |
| `/v1/episodes/get` | ❌ 无此路由 | 同上 |
| `/v1/knowledge/get` | ❌ 无此路由 | "知识库"标签页永远空 |
| `/v1/graph/dump` | ❌ 无此路由 | 图谱导出永远失败 |

核实方式：`Select-String -Path src/localhost-server.mjs` 对照 `web/console.html` 里的调用清单。
服务端真实存在的相关路由只有 `/v1/memory/list`、`/v1/search`、`/v1/evidence/list` 等。

## 二、"记忆列表看不到东西"是真 bug（数字对不上）

2026-10-30 01:5x 实测：

```
库里实际:
  curated/shared      1728 条（visibility=user 1725、private 3）
  evidence            2068 条
  索引文件            3798 个

接口表现（同一个库、同一把凭证）:
  memory/list  pilot-01/reader              → 100 条（被 limit 截断）
  memory/list  qq-134c7898c9/chat-reader    → 0 条
  brief        qq-134c7898c9                → 3 条
  brief        qq-2b53219729（小号）        → 0 条   ← 隔离正确
```

**同一身份：`memory/list` 说 0 条，`brief` 说 3 条** ⇒ 两条路用了不同的读取口径：

- `brief` 走索引（索引行里有 user_id，能匹配）
- `memory/list` 走文件扫描 + 另一套 scope 解析（匹配不上 `visibility=user` 的文件）

## 三、身份与 scope 的现状（不是猜的）

- 服务端注册表 `data/runtime/identity.json`（数组结构：`frameworks[].agents[].roles[].scopes[]`）
- QQ 身份**已注册**，scope 为 `{layer:"memory", visibility:"user"}`，带正确 `user_id`
  - `qq-134c7898c9` → user_id `user-owner`
  - `qq-2b53219729` → user_id `u_2b53219729`
  - `qq-ca61563f09` → user_id `u_group_478901737`
- 但 `pilot-01/reader` 的 scope 是 `shared` + `episodic` ⇒ 它**本来就看不到 user 层**

结论：前端登录的账号看到的世界，和 QQ 身份看到的世界是两套。这是"感觉东西很少"的直接原因。

## 四、修复方案（按依赖顺序）

1. **统一读取口径**（根）
   让 `memory/list`、`/v1/search`、`/v1/recall/brief` 共用同一份 scope 解析 + 同一份索引，
   不再"一个扫文件、一个查索引"。验收判据：同一身份三个接口对同一 query 的可见集合一致。
2. **修前端 3 个死标签**
   要么接真实接口（用 `memory/list` + `search` 重写"会话/知识库"），要么删除，不留假按钮。
3. **加"全库概览"页**
   各层实际条数 / 可检索条数 / 当前身份可见条数，三者差异可见。

工作量估计：①半天 ②半天 ③2 小时。

## 五、启动前的前置条件

- 米汐 QQ 通道先验收稳定：群里 @ 能回、能主动插话且内容与群聊相关、私聊问她能捞到群线、无重复回复/跑题
- 验收证据落盘到 `reports/` 后再动前端，避免两件事互相干扰
