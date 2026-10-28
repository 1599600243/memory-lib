# SCENARIO-RECALL-CONTRACT — 「随口问」的接入方契约

> 面向**外部接入方**（管家 / 学习助手 / 任何接了记忆库的智能体）。
> 它回答一件事：**用户随口问「10/10 我们聊了什么」时，你该怎么接**。
>
> 平台只有两个零件，都是**纯规则、零模型**：把人话解析成范围（`/v1/date/resolve`），
> 再把那个范围里的条目**取全**（`/v1/search` 的空 query 枚举）。
> **最终措辞由你（或你的模型）做** —— 平台只负责把素材备齐、并如实告诉你取没取全。
>
> 配套可运行参考实现：`src/scenario-recall.mjs` + `scripts/scenario-recall.mjs`（可整段抄）。

---

## 0. 一句话

```text
用户原话 ──► /v1/date/resolve ──► 范围 ──► /v1/search（空 query，翻页取全） ──► 素材（时间 + 库里原文摘要）
```

**不要把用户原话直接丢进关键词检索。** 那正是"问 10/10 当天 0 条"的原因：
「10/10」会被当成关键词去匹配正文，而正文里根本没有它。

---

## 1. 必须：先 resolve，再检索

```http
POST /v1/date/resolve
{ "text": "10/10 我们聊了什么", "now": "2026-10-15T08:00:00.000Z", "timezone": "Asia/Shanghai" }
```

- **`now` 必须由你给**：平台**不允许**在底层猜"现在"（否则同一请求重放会得到不同范围、无法审计）。
- `timezone` 必填（IANA 名）；它同时决定 `calendarDate` 与**纯日期** `since/until` 的本地日解释。
- 用户说的"10/10"是**他所在地的本地日**，不要把它当 UTC 日去比时间戳。

拿到 `ok: true` 之后**才**去检索。

---

## 2. 失败与歧义：回问用户，**不许猜、不许合并**

`ok: false` 有三种，处理方式不同：

| `reason` | 意思 | 你该做什么 |
|---|---|---|
| `no-match` | 这句话里**没有时间表达**（如「随便聊聊」） | **明说"这句话里没有时间范围"**。**不许**自己挑一个日期、**不许**退化成"搜全库"。 |
| `ambiguous` | 时间表达有**两种合法读法**（如 locale 未知时的 `10/11`） | 把 `ambiguous.candidates` **列给用户确认**。**绝对不许**把两个候选并成一个查询（那会悄悄放大数据量、改变用户的问题）。 |
| `invalid-date` / `invalid-timezone` / `invalid-now` 等 | 参数本身不合法（如 `2/30`） | 如实回报；**不许**自己纠正成"看起来像"的日期。 |

> **判据**：失败时**一个检索请求都不该发**。参考实现里有测试卡住这一条
> （`test/scenario-recall.test.mjs`：失败/歧义场景断言 search 调用次数为 0）。

---

## 3. 范围语义：半开区间，两条入口等价

```text
真值 = 半开 [since, untilExclusive)
响应里的 resolvedRange 会把 since / until / untilExclusive 一起回显：
  until           = 闭口径（区间最后一毫秒），便于直接透给老接口
  untilExclusive  = 真值上界（不含）
  ⇒ 两者相差正好 1ms
```

- **纯日期**（`YYYY-MM-DD`）按 `calendarTimezone` 的**本地日**解释：
  `{since:"2026-10-10", until:"2026-10-10"}` 与 `{calendarDate:"2026-10-10", calendarTimezone:"Asia/Shanghai"}`
  **完全等价**（集合、顺序、生效窗口都一致）。
- **带时刻**的 `since`/`until` 是**瞬时**边界，**不做**按天扩张。
- 细节与变更点见 `docs/openapi.yaml` 的 `SearchRequest`；那是**权威**。

### 3.0 ⚠️ 省略时区时用的是「部署默认时区」——先问清它是什么

**这一条最容易踩坑，请先读。** 只要你在请求里**不给**时区，平台就按**部署默认时区**解释那条裸日期：

| 你给了什么 | 平台用什么时区 |
|---|---|
| `calendarTimezone: "Asia/Shanghai"` | 就用这个（**永远显式最安全**） |
| `calendarDate` + 不给 `calendarTimezone` | 部署默认时区 |
| `since`/`until` 是纯日期（`2026-10-07`）+ 不给 `calendarTimezone` | 部署默认时区 |
| `/v1/date/resolve` 不给 `timezone` | 部署默认时区 |

**部署默认时区由运维在启动时用 `--calendar-timezone <IANA>` 设定**（环境变量
`MEMORY_LIB_CALENDAR_TIMEZONE` 等效）。**没有配置时就是 `UTC`。**

```text
# 配置了 Asia/Shanghai（本部署的生产配置，见 autostart.cmd）：
{ "since": "2026-10-07", "until": "2026-10-07" }        ⇒ 上海本地 10-07 = [10-06T16:00Z, 10-07T16:00Z)
# 没配置（默认 UTC）：
{ "since": "2026-10-07", "until": "2026-10-07" }        ⇒ UTC 10-07    = [10-07T00:00Z, 10-08T00:00Z)
```

**后果很实在**：同一个「10-07」在两种配置下相差 8 小时，条数可以差很多
（本库实测：UTC 口径 **146** 条 vs 上海口径 **177** 条）。

**部署默认时区对「所有入口」生效，且只有一个真相源。**
REST（`/v1/search`、`/v1/date/resolve`）、MCP over HTTP（`POST /mcp`）、MCP over stdio
四条通道**省略时区时拿到的是同一个默认值、同一个窗口**。这条有接线门用例钉住
（`test/entry-timezone-parity.test.mjs`：同一实例/同一数据/同一身份，逐入口比对
**具体窗口字符串与条数**）。

> 唯一真相源在哪里：**`server.mjs` 启动时解析一次**（`--calendar-timezone` / `MEMORY_LIB_CALENDAR_TIMEZONE`），
> 交给 `createLocalhostServer`，由它注入 REST 三条路由、进程内 MCP 的工具处理器、
> 以及每个 `createMemoryLib` 实例（`lib.calendarTimezone`）。
> `mcp-server.mjs` **不读 flag/env、也不自己兜底 `UTC`** —— 它缺省值时必须拿到宿主注入的值，
> 拿不到就直接报错，以防再长出第二个默认值来源。

所以：

- ✅ **最稳的做法**：自己带上 `calendarTimezone`，或者用 `/v1/date/resolve` 拿到 `range` 再原样透传。
- ✅ 想知道这个部署到底用哪个时区，看 `/v1/search` 回显的 `resolvedRange.calendarTimezone`
  （它永远是你这次查询**实际**用的时区）。
- ❌ **不要**假设"省略 = 我的本地时区"。省略 = **部署**的时区，它可能不是你的。
- ❌ **不要**把两种口径的数混着比。同一句话换时区就是换了一个集合。
- 非法时区值会让服务**启动即失败**（不会静默退回 UTC）——那是**故意的**，
  免得把"运维配错了"伪装成"数据本来就这些"。

### 3.1 `total_count` 是**相对这个身份**的数，不是全局数

**同一天、同一份库，换一个认证身份，`total_count` 可以不同。** 这不是 bug，是准入规则的正常结果：

- 角色记忆（`curated/agents/<agent>/`，即容器/可见性为 `role` 的条目）**只对 `role_id` 相同的 principal 可见**
  （判据在 `container-policy.mjs`：`scope.visibility === "role" || scope.container === "role"`
  ⇒ `Boolean(role && p.role_id === role)`）。它**不看** `agent_id`：同一个 agent 换个 `role_id` 就读不到了。
- 证据层（`evidence/conversations`）的准入由 **`group_id` + `user_id`** 决定，与 `role_id` 无关。

**所以**：`2026-09-24` 用 `pilot-01/researcher` 量到 **106**，用 `pilot-01/reader` 量到 **105** ——
差的正是 `curated/agents/pilot-01/role-7c963da877417294.md` 那条**属于 `researcher` 这个角色**的经验，
`reader` 本来就不该看见它。

**接入方必须知道的推论**：`total_count` **只在同一个身份内部**可以跟别的数字比。
**不要**把「A 身份看到 106」当成「B 身份应该也看到 106」，也**不要**把它当成"取全失败了"。
`total_count` 的用法只有一个：**同一个身份、同一次问询里，取回条数 == `total_count` 才算取全**。

---

## 4. 取全：翻页 + 核对 `total_count`

```text
① 第一次：query="" + calendarDate（或 since/until）+ limit
② 拿到 nextCursor → 下一轮原样回传
③ 重复直到 nextCursor 为 null
④ **核对**：取回条数 == total_count 才算"取全"
```

- **用 `nextCursor`（keyset），不要用 `offset`**：`offset` 是位次语义，
  翻页期间有新写入会**重复或漏行**（已在 `openapi.yaml` 标 deprecated）。
- **`limit` 只决定每页大小，不决定"给多少"**。取回条数少于 `total_count` ⇒
  **如实说"没取全"**，不许把它讲成"那天就这些"。
- 排序契约固定 `capturedAt ASC, id ASC`。

---

## 5. ⚠️ 「取全」≠「一次塞给模型」

**一天可能有上百条**：本机用**检索口径**实测 `2026-10-07` 的本地日 = **177 条**
（另有把文件按本地日数出来的 **175** —— 两个数字的差别来自 `2026-10-07` 那条侧栏命中；
**取全一律以 `/v1/search` 的 `total_count` 为准**，也就是 **177**）。
平台负责"**给全 + 给总数**"，**不负责替你压缩**。所以接入方要自己决定怎么喂给模型：

| 做法 | 说明 |
|---|---|
| **用平台给的分批** | `recallScenario` 直接返回 `chunks`，见下一节（**推荐**） |
| 按会话分组 | 同一 `conversationId` 的轮次合起来再喂，比逐条喂有意义得多（块内条目带 `path`，拿到块后自己做） |
| 先让用户缩小范围 | "那天大概几点聊的？" ⇒ 用 `/v1/date/resolve` 解析出更窄的范围 |
| 只取摘要 | 素材里的 `excerpt` 已经是截断过的；不要为了省事丢掉 `total_count` |

**不要把"平台给了 175 条"理解成"你应该一次发 175 条"**；也不要因为塞不下就
**只发前 10 条然后声称"那天就聊了这些"** —— 那两种错法方向相反，但都属于"没说清"。

---

## 5.1 大日子的分批（附**实测**参数）

平台**直接给你分批好的素材**：`recallScenario({ …, chunkChars })` 的返回值里带 `chunks`。
分批**只做切分**，不摘要、不改写、不生成 —— 摘要仍由外部做。

### 切块依据

**按累计字符数贪心装填**，预算由 `chunkChars` 显式给出（默认 **8000**）。

- 为什么不用"按会话分组"：条目级枚举结果里**没有**可靠的会话字段
  （`conversationId` 只在 `/v1/get` 的 frontmatter 上），按会话分组会变成 N 次额外往返。
- 为什么用字符数：**"塞不塞得进上下文"最直接的量纲就是字符数**。
- 会话归组请你在拿到块之后自己做（块内条目带 `path`/`id`/`capturedAt`/`excerpt`）。

### 每块带什么

```json
{ "items": [ { "id", "path", "capturedAt", "excerpt" } ],
  "count": 18, "chars": 7200, "since": "…", "until": "…" }
```

- **`oversized: true`**（只在这种块上出现）：**单条本身就超过预算** ⇒ 它**单独成块**并标注。
  **原文摘要不会被截断** —— 由你决定是丢弃、单独喂、还是把预算调大。
- **并集保证**：所有块的条目**并集 == 当天取全的集合**（顺序一致、不重复）。
  这条有测试卡住（`test/scenario-chunking.test.mjs`）。
- 空的一天返回 **`chunks: []`**（不是"一个空块"）。

### 实测数字（真实库、只读）

**先看量它的形状** —— 这些数**只对下面这一套形状成立**，换身份或换装配都会变：

| 项 | 取值 |
|---|---|
| 数据 | 真实库**只读副本**（照生产 `autostart.cmd` 布局） |
| 身份 | **`pilot-01` / `researcher`**（`agent_id` / `role_id`） |
| 装配 | **`src/server-wiring.mjs` 的 libFactory**（= `server.mjs` 跑生产用的同一套） |
| 入口 | HTTP：`/v1/date/resolve` + `/v1/search`（经 `recallScenario`） |
| 时区 | `Asia/Shanghai` |
| 参数 | `limit`（每页）**100** · `chunkChars` **8000** |

| 本地日 | 条数 | 取回/总数 | 页数 | excerpt 字符合计 | `chunkChars=8000` 块数 |
|---|---|---|---|---|---|
| `2026-10-07` | 177 | 177 / 177 ✅ | 2 | **70,397** | **9** |
| `2026-10-05` | 112 | 112 / 112 ✅ | 2 | 43,967 | 6 |
| `2026-09-24` | 106 | 106 / 106 ✅ | 2 | **41,085** | 6 |

> **`2026-09-24` 这一行的来历（两个坑叠在一起，都踩过）**
>
> 它曾经写成 **105 条 / 40,944 字符**。那个数是**两件事同时不足**量出来的：
> 1. **装配**漏传 `agentId` —— D4F1 self-root 靠它把 `curated/agents/<认证 agent>` 追加进检索根；
> 2. **身份**用的是 `reader`，而这条经验属于 `researcher` 角色，`reader` 本来就不该看见它（§3.1）。
>
> 实测（同一份副本、同一套生产装配、HTTP 口径）：
>
> | 身份 | 装配 | `2026-09-24` |
> |---|---|---|
> | `researcher` | `agentId` 在位（生产） | **106 / 41,085** |
> | `researcher` | **漏传 `agentId`** | 105 / 40,944 |
> | `reader` | `agentId` 在位 | 105 / 40,944 |
> | `reader` | 漏传 `agentId` | 105 / 40,944 |
>
> 也就是说：**单单把 `agentId` 加回来还不够**（`reader` 仍是 105），
> **单单换成 `researcher` 也不够**（漏参仍是 105）—— 两者都要在位才是 106。
> 表里另外两行在这四种形状下都相同，所以只有 `09-24` 会随形状动。
>
> 这张表由 **`test/contract-table-guard.test.mjs`** 逐列钉住：
> 一条拿真实副本 + 生产装配去比表，另一条把 `agentId` 从装配里拿掉、证明前一条**会红**。

> ⚠️ **换身份读同一天会得到不同的数，这不是缺陷**：见 §3.1。
> 上表是 **`researcher`** 这一行的数；换成 `reader`，只有 `09-24` 变成 105 / 40,944。


同一天（177 条 / 70,397 字符）换 `chunkChars` 得到的块数：

| `chunkChars` | 2,000 | 4,000 | **8,000（默认）** | 16,000 | 32,000 |
|---|---|---|---|---|---|
| 块数 | 36 | 18 | **9** | 5 | 3 |

**怎么选**：单条 excerpt 上限 **400 字符** ⇒ `8000` ≈ **20 条/块**。
想要"每次只喂一点的增量式对话"⇒ 2,000–4,000；想要"少几次往返、上下文够大"⇒ 16,000–32,000。
**一天 177 条在默认下是 9 块**，不是 177 次请求，也不会是一块。
**平台不替你决定块大小** —— 那是"上下文预算 vs 往返次数"的取舍，取决于你的模型窗口。

### 取全的耗时（另一条取舍）

同一天（177 条）用不同 `limit` 实测：**每次 `/v1/search` 请求约 700ms，与这一页返回多少条无关**
（`limit=10 / 25 / 50` 都是 ~700ms）。所以

```text
总耗时 ≈ 70ms（resolve）+ 700ms × ceil(条数 / limit) + 50ms（收尾）
```

- `limit=100`（服务端上限）⇒ 177 条 = **2 次往返 ≈ 1.5 秒**；
- `limit=10` ⇒ 18 次往返 ≈ **12 秒**。

⇒ **取全时把 `limit` 开满**。`limit` 只影响**往返次数**，**不影响取回多少**；
要牺牲就牺牲延迟，**别牺牲完整性** —— 完整性由 `total_count` 核对判出来。

---

## 6. 可见性：拿不到就说拿不到

检索结果**只包含认证 principal 有权看到的内容**（按组 / 用户 / 角色过滤）。
它返回 **0 条**时有**两种完全不同的含义**：

1. 那天**确实没有**属于你的对话；
2. 那天有对话，但**不在你的可见范围内**。

平台**不会**告诉你是哪一种（那本身就是存在性泄露）。所以接入方**必须**如实措辞：

- ✅ 「按我能看到的范围，那段时间**找不到**内容。」
- ❌ 「那天你们**什么都没聊**。」 ← **把"我看不到"说成了"没发生"**

这条与 `PRODUCT.md` §1.2 段③的判据同源：**不允许用"不知道"冒充"没有"。**

---

## 7. 端到端示例（零模型，可直接抄）

```js
import { recallScenario } from "memory-lib/src/scenario-recall.mjs";

const answer = await recallScenario({
  text: "10/10 我们聊了什么",          // 用户原话，不用你先抽关键词
  now: new Date().toISOString(),       // 必填：平台不猜"现在"
  timezone: "Asia/Shanghai",
  baseUrl: "http://127.0.0.1:8787",
  credentials: { credential_ref: "...", secret: "..." },
  pageSize: 50,
});

if (answer.kind === "answer") {
  // answer.count === answer.totalCount ⇒ 取全；否则 answer.complete === false
  // answer.items: [{ capturedAt, excerpt, id, path }]  ← 全是库里已有的内容
  // 拿这些素材去组织措辞（这一步是**你**做的，平台不调模型）
} else if (answer.kind === "ambiguous") {
  // answer.candidates → 问用户"是 10 月 11 日还是 11 月 10 日？"
} else {
  // kind === "no-time-range" | "error" → 明说"这句话里没有时间范围"
}
```

一条命令看它跑：

```powershell
node scripts/scenario-recall.mjs --base-url http://127.0.0.1:8787 `
     --credential-ref <ref> --secret-file <path>
```

输出会打印每个场景的「取回条数 / total_count / 页数 / 是否取全」，并对取全断言给出 PASS/FAIL。

---

## 8. 接入方自查清单

- [ ] 我**先 resolve 再检索**，没有把用户原话当关键词。
- [ ] `now` 与 `timezone` 是我**显式**给的，不是让平台猜的。
- [ ] 我**知道这个部署的默认时区**是什么（或干脆每次显式带 `calendarTimezone`），
      没有把"省略时区"当成"我的本地时区"（见 §3.0）。
- [ ] `no-match` 时我**明说没有时间范围**，没有瞎猜日期、没有退化成全库检索。
- [ ] `ambiguous` 时我**列候选问用户**，没有把两天合并。
- [ ] 我**翻到 `nextCursor` 为 null**，并**核对了取回条数 == `total_count`**。
- [ ] 我用的是 `cursor` 而不是 `offset`。
- [ ] 我没有把"一次塞给模型"和"取全"当成一回事。
- [ ] 0 条时我说的是"**我看不到**"，不是"**没发生**"。
- [ ] 我把 `total_count` 当**这个身份**的数用（只在同身份内比、只用来判取全），
      没有拿它跟别的身份/别的天去比（见 §3.1）。
- [ ] 我的措辞里**只出现库里有的内容**，没有替库"补写"事实。
