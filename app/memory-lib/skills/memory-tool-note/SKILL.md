---
name: memory-tool-note
description: Use after learning how to operate a non-obvious tool (CLI, API, service), to record it into tools-memory so the next session does not rediscover it.
---

# 工具记忆：用一次就记一条

## 什么时候写

刚摸清一个工具的用法，并且满足任一条件：

- 它需要**非显而易见的步骤**（安装、启动、参数组合）
- 它踩过**坑**（中文查询无效、超时、路径要求）
- 下次还会用（不是一次性脚本）

不要为「读文件」「grep」这类显而易见的操作记录。

## 怎么写

优先用 MCP 工具 `memory_tool_note`：

```
memory_tool_note {
  tool_name: "graphify",
  kind: "cli",
  env: "win-local",
  sections: {
    用途: "一句话说清它能干什么",
    接入方式: "安装与最小可用命令（可贴命令）",
    关键参数: "哪几个参数决定行为/性能",
    已知坑: "踩过的坑，写现象+原因",
    验证方式: "怎么确认它能用（具体命令与预期输出）"
  },
  evidence_refs: ["conversation-..."]   // 必须非空
}
```

没有 MCP 时用 CLI：

```
node scripts/note-tool.mjs graphify --purpose "..." --setup "..." --params "..." --pitfalls "..." --verify "..." --evidence conversation-xxx
```

## 硬规则

- 五段**缺一不可**（接口会拒），每段都要能指导下次操作
- 同一工具名重复写会**合并更新**，不会建重复文件
- `tool_name` 决定文件名：用稳定短名（`graphify`、`dbx`），不要带版本号
- 写入是 `platform` 可见性（跨组可读），**不要**把密钥/token 写进正文
