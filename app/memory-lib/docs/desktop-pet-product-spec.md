# Desktop-pet 与 memory-lib 产品规格（D29）

## 1. 独立边界

`memory-lib` 是独立的记忆系统，不依赖任何智能体、宿主或框架。Desktop-pet 是独立客户端，只通过 HTTP、MCP 或 Web 使用正式协议。

## 2. 模型编排

桌宠可以使用 memory-lib 配置的模型，但不得绕过服务协议直接改写长期记忆。对话原文保存到 `evidence/conversations`；需要长期保存的事实由模型调用 `memory_write` 直接写入 D29 目标层。

## 3. 模式与权限

模式由服务端身份绑定，不由客户端自行声明高权限身份。

| 模式 | 用途 | 默认能力 |
|---|---|---|
| 陪伴 | 日常交流、情绪和共同回忆 | search、get、pet |
| 普通 | 普通管家协助 | 陪伴 + 直接写入 |
| 管家 | 任务、整理、计划、记忆 | search、get、直接写入、learning、pet |
| 学习 | 教学、测验、计划、复习 | search、get、直接写入、learning |
| 治理 | 直接写入、deprecate 等 | 仅明确开启后授予并审计 |

高权限操作仍需 credential、agent、role、scope 和 action 五层约束。

## 4. 读取限制

默认只读 credential 被授予的 D29 检索根：`curated/shared`、`curated/agents`、`project-state`、`tools-memory`、`plans`、`profile` 和 `evidence/documents`。`evidence/conversations` 是 storage-only；learning 由独立学习助手管理，不进入 memory-lib 检索。

## 5. 写入规则

- 持久化记忆通过 `memory_write` / `POST /v1/write` 直接写入明确目标层。
- 每次直接写入必须携带 `evidence_refs`，由服务端校验 scope、字段、去重和审计。
- 学习计划、进度、复习结果和学习者画像写入独立 learning 层。
- 对话 capture 只保存脱敏原文，不创建 candidate/inbox，不触发模型 review/promote。
- `drafts/` 是独立 TTL 运行时区，默认不进入检索。

## 6. 人格与记忆

Desktop-pet 自己拥有完整人格和表现方式。共享长期记忆包括用户偏好、共同经历、目标、决定和学习进展；角色可以有私有人格记忆。短期记忆保存在客户端，长期记忆由 memory-lib 的 D29 直接写入和检索协议管理。

## 7. Web pet

保留 `/pet` 作为官方 Web 客户端。Web pet 与 Desktop-pet 共用 library.v1、pet contract、模式与权限语义、记忆读取限制、模型优先级和人格/短期/长期分层，但保留各自界面实现。
