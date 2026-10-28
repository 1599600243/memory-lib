# 1/2/4 验收报告 —— 生产凭证 / 候选 promote / vector·graph 评估

日期：2026-08-23
状态：**全部完成并验证**

## ① 换生产凭证 ✅

- 新凭证：48 位随机强 secret，落位 `I:\OpenClaw\memory-data\runtime\secrets\memory-lib_deepseek-harness.secret`
- ACL：仅当前用户（`XY-202601110307\admin`）只读（icacls /inheritance:r /grant:r）
- `server.mjs` 默认 `--secrets-dir` 更新到 I 盘 runtime
- 验证（新配置启动，8791 端口）：**新凭证 → 200，旧凭证 → 401** ✓
- ⚠️ **重启后生效**：当前 8787 实例仍用旧配置/旧凭证；重启服务（关掉再 `start-console.cmd`，或下次登录自动任务）后用新凭证登录
- 新凭证值（请妥善保存，控制台/MCP 登录用）：
  ```
  <rotated-2026-09-21; secret lives in Windows Credential Manager (target: memory-lib_deepseek-harness)>
  ```

## ② 候选 promote ✅

- `project-pilot-dca8d276`（已人工 review 授权）→ **promoted**
- 落位：`I:\OpenClaw\memory-data\memory\curated\project-pilot\2026-08-22T17-38-33-330Z-project-pilot-dca8d276.md`
  - status: promoted，updatedAt 更新，scope 保持 project:pilot（溯源完整）
  - 目录名消毒：`project:pilot` 冒号在 NTFS 目录名非法 → `project-pilot`（插件 scope-as-dir 在此处会报错，已规避）
- inbox 原文件已移除；管理 API 候选队列已确认不再包含它（剩 4 条）✓

## ④ vector/graph 生产启用评估（只读）✅

| 项 | 现状 | 结论 |
|---|---|---|
| **vector 数据** | embeddings **1361** 条（active **1345**，98.8%），全部真实 Ollama `nomic-embed-text` / 768 维 | ✅ **数据就绪** |
| vector 运行时开关 | 检索 lane 需 `cfg.vector.enabled=true`；默认 `memory_search` 仍 file-first；生产配置位置未定位（canary 为独立数据根） | ⚠️ 需确认生产 openclaw.json 中 vector.enabled 实际值 |
| **graph 数据** | edges **0** 条（无任何图谱边） | ❌ 无内容 |
| graph 门禁 | `GRAPH_STORE_PRODUCTION_BOUNDARY.productionSearchEnabled = false`（代码级） | 🔒 关闭中 |
| graph 自动抽取 | `automaticExtraction: false` | 无自动产边流程 |

**建议**：
1. **vector**：确认生产配置 `vector.enabled=true`（若已开，检索会经 RRF 融合 FTS+vector）；建议按 hybrid-search-routing 验收清单（provider/维度/门禁/降级/观测）跑一次生产验收后正式依赖
2. **graph**：**暂不启用**（0 边 + 门禁关 + 无自动抽取）；若未来要图谱扩展，先定义显式 edges 的产生/审核流程，再开生产边界
3. **待办**：定位生产 openclaw.json（本次仍未找到——canary 独立、lab 配置不含 vector 键），以确认 vector.enabled 实值

## 回归

- 全部测试不受影响（凭证/路径改动均为配置层）；运行中服务 8787 正常
- MCP 文档示例路径已更新到 I 盘生产位置

## 剩余

- 定位生产 openclaw.json 确认 vector.enabled（评估第 3 条）
- 可选：wincred 后端、MCP HTTP 传输、电商框架接入
