# MEMORY-CONTRACT —— 一条记忆的数据契约

> 状态：D29 当前契约。持久化记忆由 `memory_write`/`POST /v1/write` 直接写入目标层；对话原文仅保存为 storage-only evidence。
> 旧的 episodic、inbox、candidate、review、promote 和 consolidator 设计不属于当前生产协议。

## 1. 通用字段（每一层都有的）

一条记忆 = 一个 Markdown 文件，frontmatter 携带结构化字段，正文携带可读内容。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定唯一键。形式 `episode-<sessionKey>` / `shared-<slug>-<uuid8>` 等，按层定。 |
| `layer` | enum | 所属层：`working` / `episodic` / `semantic` / `role` / `project` / `tool` / `plan`。 |
| `subject` | string | 主体：这条记忆是谁的事 / 关于什么。经历层 = 会话键或背景首句；语义层 = 事实主体。 |
| `project` | string\|null | 归属项目；无项目为 `null`。 |
| `occurred_at` | ISO-8601 | 发生时间（经历层 = 会话时间范围起点）。 |
| `captured_at` | ISO-8601 | 写入记忆库的时间。 |
| `source` | string | 来源标识（`dsh-session` / `user-persona` / `tool-note` / `<framework>:<agent>` 等）。 |
| `evidence_refs` | string[] | 指向原文（`evidence/conversations/<id>.md` 等），可回溯。 |
| `status` | enum | `active` / `superseded` / `archived`。 |
| `superseded_by` | string\|null | 被哪条取代（`status=superseded` 时指向新条 id）。 |
| `confidence` | enum | `low` / `medium` / `high`。 |
| `importance` | enum | `ordinary` / `important` / `critical`（critical 只由显式“记住/硬约束”校准）。 |
| `tags` | string[] | 检索标签，取值受白名单约束（见第 4 节落点表）。 |
| `event_hash` | string | 幂等键：同源事件重放时据此去重，不重复落盘。 |

> 补充（实现层，非契约必填）：`conversationId` / `sessionKey` / `workspace` / `occurred_until` 用于按会话、按工作区、按时间范围召回。

## 2. 7 层各自的取值与落点

| layer | 取值 | 落点 | 写入方式 |
|---|---|---|---|
| `working` | 临时/工作记忆 | **不落盘**（会话内，客户端本地） | 自动，会话结束即消失 |
| `episodic` | 短期/经历 | `episodes/<YYYY-MM-DD>/<sessionKey>.md` | 自动，**会话级**（一个会话一份） |
| `semantic` | 长期/语义 | `curated/shared/`、`project-state/<项目>/` | 巩固后写入（D3 巩固器） |
| `role` | 角色记忆 | `curated/agents/<agent_id>/` | agent 自写 |
| `project` | 项目记忆 | `project-state/<项目>/` | 摘要器 + 人工确认 |
| `tool` | 工具记忆 | `tools-memory/<tool>.md` | agent 自写 |
| `plan` | 计划记忆 | `plans/<主题>.md` | agent 草案 + 人工确认 |

### 经历层（episodic）契约细节（D1 实现对齐）

- **一份会话一份**：`sessionKey = sanitize(conversationId)`；重放同一会话覆盖同一文件（幂等）。
- **正文必须四段**（缺一段判不合格）：
  1. `## 背景与目标`
  2. `## 经过与结论`
  3. `## 未决与下一步`
  4. `## 重要事实`
- **正文只允许且必须恰好四个 `## ` 标题**；D6.1 快写分片不生成模型摘要，管家批次负责后续语义归并。
- 快写路由阶段只按会话与活动日机械分片，不调用模型、不改写原文；正文保留脱敏后的消息片段，`evidence_refs` 指向完整原文。管家批量沉淀时才可生成语义摘要。
- **长度上限**：`经过与结论` ≤1200 字、`重要事实` ≤600 字、`背景与目标` ≤600 字、`未决与下一步` ≤400 字；按句边界截断，不产生半句。
- **摘要模型**：D6.1 快写路由不调用模型；后续由管家批量沉淀时使用其独立模型配置，模型失败不影响 evidence 原文。
- **降级**：纯寒暄 / 过小会话（有内容的用户轮次不足 2 且总字数不足阈值）不产出经历，避免碎片。
- **隔离**：`evidence/conversations`、archives、runtime 和 live tools 不参与默认检索；learning assets 由独立学习助手管理。

## 3. 索引与检索通道

memory-lib 使用自建 SQLite 索引覆盖 `curated/shared/**`、`curated/agents/**`、`project-state/**`、`tools-memory/**`、`plans/**`、`profile/**` 与 `evidence/documents/**`。`evidence/conversations/**`、learning、archives、runtime 和 live tools 不进入索引，也不进入普通检索结果。

索引以相对 data root 的 POSIX 路径和文件 SHA-256 做增量判断；未变化文件跳过，文件消失标记为 `deleted` 而不物理删除。重建命令为：

```powershell
node scripts/index.mjs --data-root I:\OpenClaw\memory-data\memory
```

检索先使用新索引的 FTS5 与 Ollama 向量通道，再按调用身份的授权根重新过滤候选；索引不是权限来源，越权候选直接丢弃。新索引无结果时才允许只读回落到 legacy `openclaw-memory-ledger.sqlite`，legacy 账本不会被索引或检索过程写入。`/v1/health` 的向量状态报告新索引的 active embedding 数量和最后索引时间。

## 4. 四条验收问句的期望输出

| 问句 | 期望输出（“答得出”=） | 依赖层 |
|---|---|---|
| 「昨天做了什么」 | 至少 3 条**带 `occurred_at` 时间与 `evidence_refs` 出处**的条目，能读出前因后果；可按 `since`/`until` 或日期路径过滤命中 | episodic |
| 「上周那个设计怎么演变的」 | 能给出**多轮变化与取代关系**（`superseded_by` 链 / 时间线） | semantic + project |
| 「新会话不交代背景」 | 能取回**项目约定与当前项目状态** | project + semantic |
| 「上次那个 bug」 | 能**定位到具体条目**并带出当时上下文（根因、改法、出处） | episodic + tool |

> 本轮（D0–D1）只实现 episodic 层与「昨天做了什么」链路；其余 3 问依赖 D2 起的其余 6 类写入者与 D3 巩固器，不在本轮范围。

## 5. 角色记忆契约（D4.1）

- 落点 `curated/agents/<agent_id>/`，`layer: role`；frontmatter 12 字段：`id` / `layer` / `agent_id` / `role_id` / `kind`(lesson|capability|boundary|preference) / `confidence` / `status` / `superseded_by` / `occurred_at` / `updated_at` / `tags` / `evidence_refs`。
- 正文三段必须非空：`## 经验`（≥15 字可独立读懂）、`## 适用场景`、`## 边界`。
- `agent_id` / `role_id` 由**连接身份**自动带入，不信任调用方自报。
- 拒绝：含凭证/密钥（`containsSensitiveText`）；正文是用户偏好类内容（命中 `用户偏好|用户要求|用户喜欢|…`，应写入画像层）；缺段。
- 合并：同 `agent_id` + 同 `kind` 近重复（bigram Dice ≥0.72）→ 合并 `evidence_refs`，不新增；结论推翻 → 旧条 `status=superseded` + `superseded_by`。

## 6. 主动召回与开场注入（D3.3 / D4.2）

- 接口：MCP `memory_recall_brief` 与 REST `POST /v1/recall/brief`，入参 `project` / `days`(默认 7) / `limit_chars`(默认 2000) / `format`(默认 `markdown`，可选 `prompt`)。
- 板块：当前项目状态 / 活跃计划 / 相关工具记忆 / 近期经历 / 未决与风险，另加第六板块「我的经验」（当前身份有角色记忆时出现，最多 3 条）。
- `format=prompt`：返回可直接放进系统提示的开场简报，≤1500 字、以 `## 记忆简报` 开头、六板块齐、空板块写「（明确的无）」、无凭证/绝对路径、纯文本无表格无 emoji。

### 调用时机（约定）

**会话开始时调用一次** `memory_recall_brief`（`format=prompt`），把返回内容注入系统提示作为开场背景；会话进行中如需项目/经历细节，再用 `search` / `memory_get` 按需取回。不要把召回简报在每一轮重复注入。

