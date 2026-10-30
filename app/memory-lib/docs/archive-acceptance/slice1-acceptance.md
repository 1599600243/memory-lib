# Slice 1 验收报告 —— 只读共享库 memory-lib

日期：2026-08（本会话）
状态：**全部通过**

## 验收项对照（roadmap §3 Slice 1）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 只读打开生产数据根后 health 正常 | ✅ **healthy**，0 个 missing checks | `scripts/production-readonly-check.mjs` |
| 2 | search 结果与现有插件 file-first 行为一致（同 fixture 对比） | ✅ **PARITY_OK**（5 组查询全部 MATCH，含命中数与内容） | `scripts/parity-probe.mjs`（直接执行活体插件 `createMemoryService` 对比） |
| 3 | get 能按 id 读 curated | ✅ 生产实测 `mem_20260805_memory_loop` 读取成功 | production 检查 |
| 4 | 全程零写入 | ✅ fixture 与生产（801 文件）前后快照 **CLEAN**，无任何文件变化 | `zero-write-check.mjs`（sha256+size+mtime） |
| 5 | 无任何 openclaw import | ✅ 仅 node 内置（fs/promises、path、crypto）+ 抽取代码；零第三方依赖 | 源码 + package.json |

## 额外验证

- **scope 过滤在检索前**：受限模式 roots 仅 `curated/shared`；`search "store-ops"` 3 个命中全部在授权根内（0 泄漏）；agent 区内容（主智能体等）搜索返回空
- **get 不泄漏存在性**：越权/未知 id 返回 `null`（而非报错或内容）
- **deny-by-default**：未映射 scope（如 `{layer:"recovery"}`）→ 无根 → 空结果
- **inbox 永不入检索根**（fixture 验证）
- **fixture 契约测试 9/9 通过**：health healthy/reduced、parity 搜索、受限搜索、agent scope、get 越权、零写入

## 产物

```
memory-lib/
├─ src/read-only-core.mjs   逐字抽取（含活体 service.ts 出处行号）
├─ src/memory-lib.mjs       库层封装（scope 解析 + health/search/get）
├─ test/fixtures/           契约测试夹具
├─ test/contract.test.mjs   9 项契约测试（node:test，直跑通过）
├─ scripts/parity-probe.mjs 与活体插件行为对比（PARITY_OK）
├─ scripts/production-readonly-check.mjs  生产只读验收（SLICE1_PRODUCTION_OK）
└─ scripts/zero-write-check.mjs           零写入快照/差异工具
```

## 风险备注

- 生产零写入快照窗口内，若 OpenClaw Gateway 并发写入会出现脏 diff（本次窗口干净）；后续复测建议选静默时段
- 只读未触碰 ledger/FTS/vector/graph 派生层（Slice 2 定只读接入方式）

## 结论

> Slice 1 成立：共享库抽取成功、行为与活体插件一致、scope 过滤在检索前生效、全程零写入。
> 可以进入 Slice 2（localhost 适配器 + credential_ref + reader/shared + 审计）。
