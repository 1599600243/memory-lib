# MEMORY-CONTRACT — D29 数据契约

> D29 当前契约：持久化记忆由 `memory_write` / `POST /v1/write` 直接写入目标层；对话原文仅保存为 storage-only evidence。candidate/inbox、模型提炼队列、review/promote、knowledge quarantine 和 consolidator 不属于当前生产协议。

## 通用字段

每条正式记忆是一个 Markdown 文件，frontmatter 保存结构化字段，正文保存可读内容。直接写入必须提供非空 `evidence_refs`；服务端补充连接身份、时间、scope、审计和幂等字段。

| 字段 | 说明 |
|---|---|
| `id` | 层内稳定唯一键 |
| `layer` | 由 D29 writer 选择的目标层 |
| `occurred_at` | 事实发生时间 |
| `captured_at` | 写入时间 |
| `source` | 来源标识 |
| `evidence_refs` | 对话证据或文档证据路径/标识 |
| `status` | `active`、`superseded` 或 `archived` |
| `tags` | 检索标签 |

## 目标层与落点

| D29 layer | 落点 |
|---|---|
| `curated-shared` | `curated/shared/` |
| `agent` | `curated/agents/<agent_id>/` |
| `project-state` | `project-state/<project>/` |
| `project-decision` | `project-state/<project>/decisions/` |
| `project-progress` | `project-state/<project>/progress.md` |
| `tool` | `tools-memory/` |
| `plan` | `plans/` |
| `profile` | `profile/` |
| `document` | `evidence/documents/` |

学习计划、进度、复习和画像由独立 learning storage 管理，不进入 memory-lib 检索根。

## 对话证据

对话 capture 保存脱敏原文到 `evidence/conversations/`。该树是 storage-only，不建立普通 FTS/向量索引，也不进入默认检索；它不会自动生成正式记忆。模型如需持久化事实，必须另行调用 `memory_write` 并引用证据。

## 索引与检索

默认检索根为 `curated/shared`、`curated/agents`、`project-state`、`tools-memory`、`plans`、`profile` 和 `evidence/documents`。archives、runtime、live tools、learning 和 `evidence/conversations` 排除。索引可重建；新文件在刷新前由 bounded file-first 补差保持可见。

```powershell
node scripts/index.mjs --data-root I:\OpenClaw\memory-data\memory
```

权限在检索前按 credential、agent、role、user、group 和 scope 过滤；索引不是权限来源。API key 明文只在签发响应出现一次，身份清单只返回无密元数据。日常检索默认包含图谱扩展，并保留 `matched_by`、`graph_path`、`evidence_ids`；传入 `graphExpand: false` 时仅使用索引与向量。无 principal 的 parity 模式不执行图谱扩展，因为无法安全确定租户和可见性边界。

## 身份是权威，`mode` 只是子维度（产品裁决 2026-10-17）

`role_id` / `agent_id` / `group_id` / `user_id` **只能由服务端从凭据解析**，是权限与归属的权威；请求体里的同类字段只能被忽略或用于**收窄**，永远不能扩大可见范围。
`mode`（companion / assistant / steward / learner / governance）是**同一身份之下的内容维度（子键/标签）**，不是权限维度：调用方可以指定它，但只能在"已经属于该身份"的数据里选。

因此：**persona 的权威键 =（服务端解析出的 `role_id`, `mode`）**；**宠物草稿的权威键 =（服务端解析出的 `role_id`）**，`mode` 只作为标签落盘（`pet_mode`）。
**凡是喂给模型的内容，其 persona 必须来自该身份**——禁止任何路径用写死的或别的身份的 persona 顶替。详见 `docs/protocol.md` 的 "Identity is the authority; `mode` is a sub-dimension"。
