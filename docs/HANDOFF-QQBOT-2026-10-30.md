# 交接单：QQ 机器人（米汐 / NapCat 通道）

> 交接时间：2026-10-30 19:05
> 交接原因：会话上下文过长，QQ 通道的后续调试交给**独立会话**；本会话继续记忆库（memory-lib）升级维护。
> 接手方必读：先读 `docs/NAPCAT-RUNTIME.md`（249 行，完整运行逻辑），本文只讲"接手要做什么、边界在哪"。

---

## 一、现状快照（交接时刻实测）

```
适配器      node adapters/napcat/serve.mjs   PID 18132   计划任务 napcat-adapter = Running
NapCat      docker 容器 memorylib-napcat     Up 31 小时  restart: unless-stopped
记忆服务    http://127.0.0.1:8787            healthy，indexed≈3866，failed=0
看门狗      计划任务 napcat-watchdog         每 5 分钟，异常弹窗 + logs/ALERT.log
身份表      data/runtime/identities.json     14 条（主人 1 / 小号 1 / 群线 1 / 群友 11）
她的记忆    curated/shared 里 user_id=u_napcat_owner        99 条
群线记忆    curated/shared 里 user_id=u_group_478901737     33 条
测试        node --test adapters/napcat/test/  → 50/50 通过
最新提交    21126f0（docs: 运行逻辑说明）
```

---

## 二、接手方要处理的事（按优先级）

### P0 稳定性：账号每天被踢 1–2 次

- 事实：10-30 两次掉线（10:00、15:36），都需重新扫码；看门狗两次都准确告警
- 判断：腾讯风控判的是**行为特征**（非官方客户端 + 常驻 + 主动插话），实名认证只解决一道门
- 待决策（用户尚未拍板）：
  - A. 关掉主动插话（`proactive.enabled=false`），只被动回复
  - B. 主动插话降到 2–4 小时一次、概率 0.2、每天 2 条
  - C. 保持现状（15–45 分钟、45%、每天 6 条）
  - 建议 B
- 注意：**每次扫码都会增加"新设备登录"记录，可能加剧风控**，不要频繁重启容器

### P1 未定位异常

```
处理失败: Cannot read properties of undefined (reading 'length')   ← 出现过 8 次（10-30 04:52~05:09）
```
已将日志改成带栈（`index.mjs` receive 的 catch），下次复现可直接看到行号。

### P2 体验/设计待定（用户已列 8 条，见 NAPCAT-RUNTIME.md 第十二节）

群聊触发强度、主动插话频率、群记忆粒度、群友档案、私聊问群事上限、动作描写策略、模型选择、人格重复感。

---

## 三、接手方的操作手册

### 改配置（不需要改代码）

```
D:\MemoryLib\adapters\napcat\config.json
```

改完必须重启任务才生效：

```powershell
Stop-ScheduledTask -TaskName 'napcat-adapter'; Start-Sleep 3; Start-ScheduledTask -TaskName 'napcat-adapter'
```

### 看她在想什么

```powershell
node D:\MemoryLib\scripts\show-turns.mjs            # 最近 10 轮
node D:\MemoryLib\scripts\show-turns.mjs --last     # 最近一轮完整上下文（system/记忆/群记录/回答/耗时）
Get-Content D:\MemoryLib\logs\napcat-service.log -Tail 50
Get-Content D:\MemoryLib\logs\ALERT.log -Tail 20
docker logs memorylib-napcat --since 30m
```

### 掉线了怎么办

```powershell
# 1) 确认是否要扫码
docker logs memorylib-napcat --tail 30 | Select-String '二维码'
# 2) 打开 WebUI（二维码是活的）
#    http://127.0.0.1:6099/webui   token 在 deploy\napcat\data\webui.json
# 3) 扫码后等 10 秒，重启适配器重新握手
```

### 加群 / 加人

```powershell
# 群白名单：config.json → bot.groupAllow
# 群级身份（群线记忆主体）
node D:\MemoryLib\scripts\identity.mjs add --channel napcat --uid group-<群号> --name <群名> --role guest --user-id u_group_<群号>
# 群友不用手动加：allowGroupGuests=true 时首次说话自动登记
```

### 改人格

```
soul/dafeiyu/persona.md        人格（50–2000 字）
soul/dafeiyu/style-samples.md  语气样本（few-shot）
```
改完重启任务生效。

---

## 四、硬边界（不要碰）

| 边界 | 原因 |
|---|---|
| 不要改 `data/memory/**` 里的文件 | 那是记忆库的数据面，属本会话（记忆库）维护范围 |
| 不要用 `--user-id` 复用别人的 user_id | 会造成跨主体串记忆（10-30 已发生过一次事故） |
| 不要手工 `node adapters/napcat/index.mjs` 启动 | 会被单实例锁拒绝；用计划任务 |
| 不要频繁重启容器 | 每次登录都算新设备，加剧风控 |
| 不要把 token / QQ 号 / 凭证写进 git | `config.json`、`.env`、`deploy/napcat/qq` 均已 gitignore |
| 群聊记忆不能读私聊层 | 防泄漏；代码里已硬编码 |

---

## 五、两个会话的分工

| 范围 | 归属 |
|---|---|
| `adapters/napcat/**`（适配器代码、配置、人格、群聊策略、风控行为） | **QQ 会话** |
| `deploy/napcat/**`（容器、登录态、WebUI） | **QQ 会话** |
| `app/memory-lib/**`（记忆服务、检索、前端 console、权限/隔离） | **本会话（记忆库）** |
| `data/memory/**`（记忆数据面） | 本会话 |
| `scripts/identity.mjs` | 共享：改了要在交接单里写一句 |

**冲突处理**：若 QQ 会话需要改 memory-lib 的接口行为（例如新增群聊专用检索），先在交接单里记一条，由记忆库会话实施。

---

## 六、当前已知的"没验证过"（别当已验证）

- 72 小时连续运行（最长约 8 小时，中间因风控掉线）
- 主动插话在真实活跃群里的表现（样本只有 2–3 次）
- 群友自动登记后的记忆归因质量（已登记 11 人，但沉淀的群线记忆仅 33 条）
- `length` 异常的触发条件
- 重启后群缓冲清空（设计如此，但"前 15 分钟没有上下文"的体验未评估）

---

## 七、接手会话更新（2026-10-30 20:10）

> 以下为接手后实测，覆盖上文对应条目的状态。

### P1 已定位（不是"等复现"，已有确定根因）

- 根因：续话（engage）分支里 `verdict.text` 从未被赋值。`shouldHandle` 对 `not-addressed` 只返回
  `{ok:false, reason:"not-addressed"}`，而 engage 分支只补了 `scope/groupId/uid`，漏了 `text`；
  随后 `log(\`... chars=${verdict.text.length}\`)` 在 undefined 上取 `.length` → 抛 TypeError，
  被 `receive` 的 catch 记成「处理失败」。
- 证据：8 次报错全部紧跟「群 478901737 连续对话窗口内，未@也接话」（`logs/napcat-service.log`
  L5033/5035/5067/5069/5071/5073/5076/5092），且时间都在 04:52–05:09Z（=12:52–13:09），
  即 `03276e2`（13:12）之前的旧代码；那版还没有带栈日志，所以 8 条都没有栈。
- 修复：`03276e2` 先做安全访问兜底；`643c286`（13:19）真正修好——补 `verdict.text = extractText(...)`，
  空文本（图片/转发）直接不接。重启后 13:13–13:15 的三次续话均正常（chars=7/41/2/16），
  之后 6305 行日志里再未出现该报错。
- 现状：续话窗口自 `cf4576b`（14:17）起默认关闭（`engageEnabled=false`），该路径当前不执行；
  重新开启也已安全。

### P0 复核（推翻了一个假设，请据此拍板）

用 `docker logs memorylib-napcat` 拿到容器侧一手记录（本地时间）：

| 时间 | 事件 | 当时活动 |
|---|---|---|
| 10-30 07:57:23 | 账号状态变更为离线（无 KickedOffLine） | 上一次发言是 03:04，≈5 小时静默 |
| 08:00–10:08 | 每 2 分钟一次 `Login Error ErrType:1 ErrCode:3` + 重新出二维码，≈65 次 | 无人扫码 |
| 10:09:36 | 扫码成功 | — |
| 10-30 15:36:31 | `[KickedOffLine] [下线通知] 你的账号当前登录已失效` | 上一次发言 14:45，≈51 分钟静默 |
| 15:46:17 | 扫码成功 | — |

- 今天主动插话**只发出 3 条**（13:36、14:44、17:26），其中 17:26 那条与 16:35 的回复文本完全重复。
- 今天唯一的「刷屏时段」是 13:36–13:53（13:50、13:51 各 5 条/分钟），成因是
  **主动插话 → 开续话窗口 → 续话自己接着刷**；这个组合已随 `engageEnabled=false` 消失。
- 结论：**两次掉线都不紧跟发言高峰**（07:57 静默 5 小时、15:36 静默 51 分钟），
  「主动插话频率 → 掉线」目前**没有可证的因果链**；A/B 不能保证解决 P0。
  外部资料里 NapCat 被风控踢下线是已知问题（[NapCatQQ #1728](https://github.com/NapNeko/NapCatQQ/issues/1728)），
  但本机没有绑定账号级证据。
- 新发现的两个「自己放大风控面」的点：
  1. 被踢后 NapCat 每 2 分钟自动重试登录并生成新二维码，2 小时≈65 次（默认行为，未找到配置项）；
  2. 适配器原来每 5 秒硬重连，15 分钟的风暴期刷了 200+ 次「连接/断开」。

### 本次已做的改动

| 改动 | 文件 | 验证 |
|---|---|---|
| WS 重连改指数退避 5s→10s→20s→40s→60s 封顶，连上重置 | `adapters/napcat/index.mjs` | 新增 4 个单元测试，`resolve+transport` 52/52 通过 |
| 新增 `transport.test.mjs` | `adapters/napcat/test/transport.test.mjs` | 同上 |

已 `Stop-ScheduledTask/Start-ScheduledTask napcat-adapter` 重启生效（20:04:05 已连接）；
**未动容器**（容器 uptime 35 小时，RestartCount=0）。
