# 宿主适配器（Adapter 参考实现）

本目录存放**各宿主接入 memory-lib 自动记忆捕获的薄适配器**。

目的：**新宿主照抄这里，不要重写协议层。** capture 的原文证据、episodes、幂等、partial 替换、脱敏和重试都在 memory-lib 服务端；适配器只做一件事：把宿主的对话消息按统一事件契约搬运出去。

## 统一约定（最重要，防重复与分叉）

**同一宿主只允许一个提交者**——宿主侧的自动通道（实时插件或轮询器）。
其余参与者（agent、人工脚本、临时工具）需要「马上入库」时，**触发该通道**（例如运行捕获器的单次模式），**不要自己构造 capture 事件、不要另定 `event_id`**。

理由：
- 服务端按 `event_id` 幂等，只有「同一提交者 + 同一命名规则」才能让重放安全生效；
- 两个提交者对同一段对话各造一个 event_id，会产出两份重复 evidence（幂等失效）；
- 提交策略（抓哪些消息、如何聚合、何时推进水位）只应有一处实现。

`event_id` 命名规则（各宿主适配器统一沿用）：`<conversation_id>#turn-<N>`。

## 契约（唯一权威来源，不得各自发明）

- 事件格式、行为规则：`skills/automatic-memory-capture/SKILL.md`
- 接口规范：`docs/protocol.md`（`POST /v1/conversations/capture`）
- 接入步骤与三通道等价说明：`docs/onboarding.md`

**统一事件形状**（三通道共用）：

```json
{
  "source": "<宿主标识>",
  "conversation_id": "<稳定会话标识>",
  "event_id": "<稳定事件标识>",
  "session_id": "<可选>",
  "workspace": "<可选稳定工作区标识>",
  "tags": ["<可选标签>"],
  "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
}
```

## 现有适配器

| 宿主 | 目录 | 形态 | 说明 |
|---|---|---|---|
| DeepSeek Harness（DSH） | [`dsh/`](./dsh/) | Cordis 实时插件 + 轮询兜底 | 实时插件监听 `ctx.on('session/event')`；轮询器解析会话日志，供 DSH 未运行/插件未生效时兜底 |

## 新增宿主适配器的最小步骤

1. 复制最近似宿主目录的骨架（推荐 DSH，含「实时 + 兜底」双形态）；
2. 只改四处：**事件来源**（宿主消息 API/日志）、`source` 标识、从宿主可信上下文读取 `workspace`、凭证读取方式；
3. 保持「只搬运、不提炼」——不得在适配器里实现去重、合并、冲突判断或治理；
4. 提交失败要有重试且不阻塞宿主主流程；
5. 在 README 与代码注释中标注**协议归属**：通用（MCP/HTTP/transcript 目录/SKILL.md）还是宿主专属（如 OpenClaw hook），专属协议必须同时给出通用替代路径；
6. 事件内容不得包含凭证 / secret / token。

## 一致性自检（提交适配器前跑一遍）

- [ ] 只调用正式端点（`/v1/conversations/capture` 或其等价 MCP 工具），未新增私有接口；
- [ ] 事件字段名与 protocol.md 完全一致（`source` / `conversation_id` / `event_id` / `session_id?` / `workspace?` / `tags?` / `messages`），没有私有扩展字段；
- [ ] `workspace` 来自宿主可信工作区上下文，不由对话文本或 agent 自行声明；
- [ ] `event_id` 稳定且可重放（服务端按 event_id 幂等，重放不产生重复 evidence）；
- [ ] 一台宿主只有一个提交者（实时插件或轮询器二选一）；其余参与者只触发该通道，不自造事件或 `event_id`；
- [ ] 只提交真人消息与助手正文（过滤系统注入、运行时上下文、thinking/reasoning）；
- [x] 自动 capture 通道只搬运事件到 `evidence/conversations`；长期记忆由模型通过 `memory_write` / `POST /v1/write` 直接提交；
- [ ] 角色沿用宿主自身配置（不得为跑通而自行提权）；
- [ ] 失败重试 + 不阻塞对话 + 不静默丢事件；
- [ ] 有本地水位/状态，重启后不重复提交历史。
