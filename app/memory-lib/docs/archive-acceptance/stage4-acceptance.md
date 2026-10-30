# 阶段 4 验收报告 —— propose 写能力 + 「DS propose → 人工 review」闭环

日期：2026-08-22（本会话）
状态：**全部通过（fixture 7/7 + 生产试点成功）**

## 交付内容

1. **memory-lib.propose()**：只写 inbox（永不碰 curated/ledger），复用活体插件约定
   - id = `slugify(scope)-uuid8`；文件名 = `ISO(无冒号点)-id.md`
   - frontmatter 含插件字段（id/scope/status/reviewState/createdAt/updatedAt/confidence/proposedBy/tags/importance/ownerId/agentId/projectId）+ 跨框架溯源（framework_id/agent_id/role_id/task_id/evidence_refs）
   - 原子写（同目录临时文件 + rename）；要求受限 scope（无限制 parity 模式禁用写）
2. **适配器 POST /v1/propose**：授权走 `role.actions` 含 propose；候选 scope 必须在角色 scope 内；**先记审计后回响应**（修复了"响应先于审计落盘"的竞态）
3. **注册表**：pilot-01 增加 `researcher` 角色（scopes: shared / knowledge/approved / project:pilot；actions: search/get/propose）

## 测试结果

| 套件 | 结果 |
|---|---|
| propose.test.mjs（临时数据根） | ✅ **7/7**：reader 不可 propose(403)；researcher 可 propose(200+落盘+溯源完整)；project:pilot scope 字符串正确；越权 scope 拒绝(403)；无 content 拒绝(400)；curated 零写入；审计 allow/deny 各 1 行且无 secret |
| 回归 slice2.test.mjs | ✅ 13/13（服务器重构后） |
| 回归 contract.test.mjs | ✅ 9/9 |

## 生产试点（真实闭环第一步）

- 主体：`deepseek-harness / pilot-01 / researcher`，scope `project:pilot`
- **候选已落盘**：`I:\OpenClaw\memory-data\memory\inbox\2026-08-22T17-38-33-330Z-project-pilot-dca8d276.md`
  - id: `project-pilot-dca8d276`，status: proposed，reviewState: pending
  - 溯源：proposedBy=deepseek-harness/pilot-01，framework_id/agent_id/role_id/task_id/evidence_refs 齐全
  - curated 零写入（快照 CLEAN）
- 执行：`node scripts/pilot-propose.mjs` → **PILOT_PROPOSE_OK**

## 治理边界（保持不变）

- DS 只能 propose 到 inbox；**不能 review/promote 自己的候选**（这些仍需受信角色/人工）
- curated 不允许外部框架直接写（本阶段无 update/promote 能力）
- important/critical 内容仍应由人工把关（本候选 importance=ordinary）

## 下一步（等你行动）

1. **人工 review 候选** `project-pilot-dca8d276`：用现有 OpenClaw 流程（review-inbox-item / promote-inbox-item 或你习惯的方式）审核、promote 或拒绝
2. 审核通过后，继续：路径修复独立工作流 → 壳核分离 → 管理 API/Web UI
