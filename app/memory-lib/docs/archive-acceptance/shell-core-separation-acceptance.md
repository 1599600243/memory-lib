# 壳核分离验收报告 —— 插件默认值修正 + 独立核心运行验证

日期：2026-08-22（本会话）
状态：**全部通过**

## 一、插件源码默认值修正（带备份）

| 文件 | 改动 | 影响 |
|---|---|---|
| `service.ts:27` | `WORKSPACE_ROOT`：`~\.openclaw\workspace` → `I:\OpenClaw\memory-data` | 派生修正：dataRoot（L28）、OPENCLAW_MEMORY_ROOT（L30）、knowledge/evidence/project-state 的 legacy fallback 路径（L1304/1319/1334/1653/1679）全部指向 I 盘真实位置（均已验证存在） |
| `index.ts:52` | `DEFAULT_DATA_ROOT`：旧 C: 路径 → `I:\OpenClaw\memory-data\memory` | 控制中心 fallback 路径正确 |

备份：`service.ts.bak-pre-pathfix-20260823-020457`、`index.ts.bak-pre-pathfix-20260823-020457`（插件 src 目录内，可随时回滚）

> 运行时行为说明：插件实际数据根仍由配置覆盖（canary 配置显式指定 dataRoot），默认值修正对现有配置的运行时行为零影响，但消除了"裸跑插件打到空目录"的风险。

## 二、插件行为不变验证

- 重跑 parity-probe：直接加载**改动后**的活体 service.ts 与 memory-lib 对比，**5 组查询全 MATCH（PARITY_OK）** → 插件源码可正常加载解析、搜索行为不变

## 三、独立核心运行验证（不依赖 OpenClaw）

- 新增入口：`memory-lib/server.mjs`（CLI：--data-root / --workspace-root / --port / --registry / --secrets-dir / --audit）
- 实测（独立进程，127.0.0.1:8787，无 OpenClaw）：
  - `GET /v1/health` → `{"ok":true,"health":"healthy"}`
  - `POST /v1/search`（researcher）→ 5 命中，全部来自生产 `curated/shared`
  - `POST /v1/get`（reader）→ `mem_20260805_memory_loop` 读取成功
- 审计落盘：`runtime/audit/access.jsonl` 3 行（health/search/get），主体/动作/scope/结果完整
- 停止后进程干净退出

## 四、结论

> 壳核分离第一步成立：**核心（memory-lib + 独立进程）已可在无 OpenClaw 环境下独立运行**；
> 插件仍是 OpenClaw 侧完整适配器（45+ 工具含 learning/steward 等，未动其内部逻辑）；
> 两个入口（插件 / 独立 core）行为一致（parity 证明），共享同一套文件真相与治理约定。

## 后续（可选/待定）

1. **OpenClaw 注册为框架**：把 openclaw 作为 framework 加入身份注册表，插件侧工具可选地改走 core 协议（大改，风险高，收益低——当前双入口行为一致，建议缓行）
2. **独立服务化**：`server.mjs` 可注册为 Windows 服务/开机自启（需你决定是否常驻）
3. **管理 API + Web UI**：下一阶段
