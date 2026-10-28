# Slice 3 验收报告 —— pilot-01 八项验收（生产数据根，只读）

日期：2026-08（本会话）
状态：**全部通过（8/8 + 零写入）**
主体：`deepseek-harness / pilot-01 / reader / scope=[memory/shared] / actions=[search,get]`
目标数据根：`I:\OpenClaw\memory-data\memory`（只读）

## 验收结果

| # | 验收项 | 结果 | 实测 |
|---|---|---|---|
| A1 | 无凭证拒绝 | ✅ | 401 UNAUTHENTICATED |
| A2 | 错误凭证拒绝 | ✅ | 401 |
| A3 | 伪造 role（pilot-01 声称 reviewer）拒绝 | ✅ | 403 UNKNOWN_ROLE |
| A4 | 越权 scope（请求 agent/main）拒绝 | ✅ | 403 FORBIDDEN + detail SCOPE_DENIED |
| A5 | shared 搜索结果不越界 | ✅ | 生产查询 hits=20，leaked=0 |
| A6 | get 不能读私有层 | ✅ | agent 条目→404（不泄漏），共享条目→200 |
| A7 | 审计完整且不泄密 | ✅ | 每请求恰好 1 行（delta=1），全日志无 secret |
| A8 | OpenClaw 原插件行为不变 | ✅ | memory-lib 仅读取插件源码（parity-probe 全 MATCH）；对插件零写入 |
| — | 零写入 | ✅ | 生产 801+ 文件快照 CLEAN |

执行：`node scripts/pilot-acceptance.mjs` → **PILOT_ACCEPTANCE_PASS**

## 意义

- 「核心库 + 身份层 + 协议面」模式在**真实生产数据**上验证成立；
- 读取路径全程只读、可审计、不可越权、不可伪造；
- 按 roadmap，八项全过后才讨论 propose —— **当前未实现任何写能力，propose 留待下一步讨论**。

## 生产前待办（用户侧）

1. **替换生产凭证**：当前 pilot 用的开发 secret（`memory-lib/runtime/secrets/`）只是占位；生产凭证由你生成并放入 secret store，或选 Windows Credential Manager 后端（需实现 wincred 读取）
2. **注册表落位**（D2）：生产注册表建议 `I:\OpenClaw\memory-data\runtime\identity.json`
3. **审计落位**（D4）：生产审计建议 `I:\OpenClaw\memory-data\runtime\audit\`
4. **secret 文件 ACL**：仅服务账户可读（icacls 或文件属性）
