---
name: memory-role-note
description: Use when an agent learns a reusable lesson about its own craft (what works, when it applies, where it breaks), to record it as a role memory instead of a generic note.
---

# 角色记忆：记"我这类角色学会的东西"

## 与另外两层的区别

| 层 | 记什么 | 例子 |
|---|---|---|
| profile（画像） | **关于人**的稳定事实 | 主人要中文、要原始输出 |
| role（角色记忆） | **关于我这类角色**的经验 | "验收测试的 fixture 必须用真实返回形状" |
| tool（工具记忆） | **某个工具**怎么用 | graphify 的坑与参数 |

判断口诀：**主语是人 → profile；主语是我/同行 → role；主语是工具 → tool。**

## 什么时候写

- 踩过一次坑，并且知道**为什么**、**什么时候还会再遇到**
- 这条经验**跨任务复用**（不是这次任务的细节）
- 说出来能改变下次的行为

不写：一次性结论、用户偏好（会被拒，去写 profile）、任务进度（去写 plans/project-progress）。

## 怎么写

```
memory_role_note {
  kind: "lesson",        // lesson | capability | boundary | preference
  confidence: "high",    // low | medium | high
  sections: {
    经验: "至少 15 个字，写清现象 + 原因 + 正确做法",
    适用场景: "什么情况下会再遇到",
    边界: "什么情况下不适用/别照搬"
  },
  evidence_refs: ["conversation-..."]   // 必须非空
}
```

CLI 等价：

```
node scripts/note-role.mjs --experience "..." --scope "..." --boundary "..." --kind lesson --confidence high --evidence conversation-xxx
```

## 硬规则

- 三段都非空，`经验` ≥15 字
- 身份（agent_id/role_id）由服务端从凭据解析，**不能自报**
- 写成"用户偏好"口吻会被拒（服务端有检测），请改用 profile 层
- 同一 agent + 同 kind 的近重复会**合并**，不会重复堆文件
