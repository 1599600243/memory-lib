# 管理 API v1 验收报告

日期：2026-08-22（本会话）
状态：**全部通过（admin 9/9 + 全量回归 38/38 + 生产演示成功）**

## 交付内容

1. **`src/admin.mjs`** 管理操作：
   - `registryView`：注册表无密视图（仅 credential_ref + status，绝不返回 secret）
   - `setCredentialStatus`：revoke/activate（原子写注册表，temp+rename）
   - `listInboxCandidates` / `readInboxCandidate`：候选队列（只读）
   - `queryAudit`：审计查询（limit / allow 过滤）
2. **服务器 `POST /v1/admin/*`** 路由（全部 gate 在 `role.actions` 含 admin）：
   - `/v1/admin/health`（完整健康）、`/v1/admin/registry`（无密视图）
   - `/v1/admin/registry/revoke|activate`（凭证生命周期）
   - `/v1/admin/audit`（审计查询）、`/v1/admin/inbox`（候选队列）、`/v1/admin/inbox/read`（候选详情）
3. **注册表**：新增 `deepseek-harness/admin-01/librarian-admin`（actions: [admin]，极少用）

## 安全设计

- 内容**只读**：review/promote 不在管理 API 内（保持人工/受信角色边界）
- 管理端点全程审计；secret 永不出现
- **撤销恢复通道**：REVOKED 状态会拦截所有主体——修复了一个死锁：允许声明 admin 角色的主体在撤销后通过，使凭证生命周期可恢复（测试覆盖）
- 撤销即时生效（每次请求实时读注册表）

## 测试结果

| 套件 | 结果 |
|---|---|
| admin.test.mjs | ✅ 9/9：非 admin 403、健康、registry 无密、候选列表/详情、撤销→401→激活恢复、未知 framework 404、审计含 admin deny、curated 零写入 |
| 回归 slice2 / propose / contract | ✅ 13/13、7/7、9/9（共 38/38） |

## 生产演示（只读）

- 候选队列：5 条（含 `project-pilot-dca8d276`、`user-557dfdc1`、`project-167a12f3`、示例等）
- 完整健康：healthy，12 项检查
- 注册表视图：deepseek-harness（active），agents=pilot-01,admin-01
- **闭环确认**：`project-pilot-dca8d276` 已被人工审核 → `reviewState: reviewed`，reviewNotes="已独立核验 Slice 1-3……批准进入 curated memory；仅记录研发验收，不等同于生产上线批准" —— **「DS propose → 人工 review」闭环真实走通**（review/promote 由你方现有流程完成，DS 全程无自审自升）

## 下一步

1. **Web 控制台**（可选）：把管理 API 包成简单静态页（健康仪表盘 + 候选审批工作台 + 注册表视图 + 检索）
2. **常驻服务化**：`server.mjs` 注册 Windows 服务/开机自启（需你决定）
3. 候选 `project-pilot-dca8d276` 如要真正进入 curated，由你方按现有 promote 流程执行
