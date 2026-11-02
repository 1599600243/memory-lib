---
name: memory-plan-profile-note
description: Use when recording a plan (goal/steps/blocker) or a profile fact (preference/habit/taboo) into MemoryLib, so later sessions can pick it up instead of re-asking.
---

# 计划 / 画像记忆：手动写入口

## 计划（plans/<topic>.md）

什么时候写：事情**跨会话**、有明确步骤、需要知道"卡在哪"。

```
memory_plan_note {
  topic: "控制台 v2 收尾",
  sections: {
    目标: "一句话目标",
    步骤: "- [x] 已完成的一步\n- [ ] 待做的一步",   // 必须有 - [ ] / - [x]
    当前卡点: "现在卡在哪（没有就写「无」）"
  },
  status: "draft",           // 新建只能是 draft；用 memory_plan_confirm 确认后才变 active
  evidence_refs: ["conversation-..."]
}
```

CLI 等价：

```
node scripts/note-plan.mjs "控制台 v2 收尾" --goal "..." --steps "- [ ] ..." --blocker "..." --evidence conversation-xxx
```

## 画像（profile/<id>.md）

什么时候写：**关于人的稳定事实**——偏好、习惯、忌讳、长期约束。不要写一次性的任务细节。

```
memory_profile_note {
  id: "user-prefers-chinese",
  body: "主人要求解释用中文，先结论后证据；不接受只有口头报告，要有原始输出。",
  tags: ["preference", "language"],
  evidence_refs: ["conversation-..."]
}
```

CLI 等价：

```
node scripts/note-profile.mjs user-prefers-chinese --body "..." --tags preference,language --evidence conversation-xxx
```

## 硬规则

- 两者都**必须带非空 evidence_refs**，否则被拒
- 计划的 `步骤` 没有 `- [ ]` / `- [x]` 会被拒
- 画像 id 用稳定的 kebab-case（`user-prefers-chinese`），不要带日期
- 画像写入是 `private` 可见性（只有本人/本 agent 能读），不要把别人的隐私写进来
