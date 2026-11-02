# 交接：memory-lib（2026-10-31）

> 给接手的会话/人。范围：只看记忆库本体（`app/memory-lib`）与其数据（`.\data\memory`）。
> 本文只写**已验证的事实**；未验证的会标注。

## 1. 当前状态

```
服务       memory-lib 监听 127.0.0.1:8787
           PID 24648，10-31 08:52:45 启动，/v1/health → 200
启动方式   计划任务 memory-lib-core
重启       schtasks /end /tn "memory-lib-core"  然后  schtasks /run /tn "memory-lib-core"
仓库       .\app，HEAD c0e7e23，未提交 0
备份       data/runtime/identity.json.bak-20261031-083755
           data/runtime/api-keys.json.bak-20261031-083755
```

## 2. 我今天改了什么（按主题）

### 2.1 框架凭证"声明白名单"（默认关闭）

- 提交：`7b40ab1` → 合并 `34c8999`
- 文件：`src/identity-registry.mjs`、`test/claim-allowlist.test.mjs`、`README.md`
- 语义：`identity.json` 的 framework 可选字段 `claim_allowlist: ["agent/role", ...]`，
  只在**非空数组**时生效；支持 `*` 通配（`qq-*/chat-reader`、`*/reader`）；非法规则忽略且不放行；
  越界返回 `CLAIM_NOT_ALLOWED`（HTTP 403）。
- 默认行为未变：未配置 / 空数组 / 非数组 ⇒ 放行。
- 验证：7/7 新测试；负对照改坏后 4 红。

### 2.2 外部来源守卫（**已生效**）

- 提交：`cd37d9f` → 合并 `4c9753b`
- 文件：`src/external-source-guard.mjs`（新）、`src/refinement-jobs.mjs`、`scripts/scan-external-visibility.mjs`、`test/external-source-guard.test.mjs`、`README.md`
- 语义：从 `evidence_refs` 取来源；`napcat-*` / `napcat:*` / `qq-*` / `qq:*` 为外部；
  外部来源 + `visibility ∈ {shared, platform}` ⇒ 抛 `EXTERNAL_SOURCE_VISIBILITY_DENIED`（403）。
  接在 `refinement-jobs` 的 `submit()` 里，**在 writeMemory 之前整批预检**。
- 验证：10/10；负对照 4 红；真实库巡检 `scanned 2068 / hits 0`。
- 注意：**尚未被生产流量触发过**（重启后无新写入），只有单测证据。

### 2.3 `source_trust` 字段（**已生效**）

- 提交：`1fd9888` → 合并 `4e5da2a`
- 文件：`src/write-memory.mjs`、`src/localhost-server.mjs`、`test/source-trust.test.mjs`、`README.md`
- 语义：写正式记忆时按 `evidence_refs` 落 `source_trust: "external" | "internal"`；
  读接口 `/v1/memory/list`、`/v1/memory/find`、`/v1/search` 每条结果透出该字段；
  老文件无字段 ⇒ 返回 `"unknown"`（不冒充 internal）。**不迁移历史文件。**
- 验证：8/8；负对照 5 红；重启后尚无新写入样本。

### 2.4 巡检脚本

- 提交：`9f0e594`、`c0e7e23`
- 文件：`scripts/scan-external-visibility.mjs`
- 输出：外部来源撞 shared/platform 的命中数；以及"`curated/shared` 层里可见性不是 shared"的统计（**正常设计**，不是缺陷，仅提醒按目录读会绕过隔离）。
- 用法：`node memory-lib/scripts/scan-external-visibility.mjs [--data-root 路径]`（只读）

### 2.5 控制台 v2（与记忆库同仓库，但属前端）

- 批 3 前三页：采集/导入、Agents、运行时（`13c605f`）
- 修复：`getJson` 缺 Authorization 导致 401（`11c9e49`）；Agents 调 `/v1/admin/registry` 用错 GET（`010ffdc`）；Agents 列错位（`535a974`）；范围列显示动作（`6467406`）；API Key 表说明（`3377170`、`1cecb0a`）
- 证据页弹窗：`5aa39ba`、`aa8a835`、`0086135`
- 验证脚本：`scripts/check-v2-pages.mjs`、`scripts/check-v2-evidence-click.mjs`（Edge CDP，无头）

## 3. 验证命令（可直接跑）

```powershell
cd app/memory-lib
node --test test/claim-allowlist.test.mjs        # 7/7
node --test test/external-source-guard.test.mjs  # 10/10
node --test test/source-trust.test.mjs           # 8/8
node scripts/scan-external-visibility.mjs        # scanned / hits / 目录统计
```

**已知基线失败（不是新引入）**：
- `test/refinement-jobs-submit-scope-http.test.mjs` 的 ML1 用例：`200 !== 404`（父提交 34c8999 上同样失败，已用临时 worktree 对照）
- `test/m1-4-write-entrypoints.test.mjs`：缺 `memory-write-entrypoints.md`（仓库根没有该文件且被 .gitignore 的 `/*` 忽略）

## 4. 待办（交给下一位）

### T1（唯一挂起项）`source_trust` 读侧性能

- 位置：`src/localhost-server.mjs` 的 `withSourceTrustList()`（约 :64-77）
- 问题：老文件没有 `source_trust`，每次请求对每个命中项 `fs.readFile` 补读；库里有 2066 个老文件，搜索命中多时会慢
- 建议：进程内缓存 `path → { mtimeMs, size, trust }`（上限 5000 条），或只补前 N 条、其余返回 `"unknown"`
- 验收：同一查询改前/改后耗时对比；字段值不变；`unknown` 回退不变；不碰可见性判定
- 红线：不改 `data/**`；不改 evidence 原文

### 已澄清、不需要做的

- "2066 个文件在 `curated/shared` 但 visibility=user"：**正常**，目录按 layer 分，visibility 是 frontmatter 的另一个维度（`write-memory.mjs:108`）
- 审计里 96 条 `UNAUTHENTICATED`：外部调用方问题，不在本次范围

### 没做、需要另外协调的

- **QQ 独立凭证（R1）**：QQ 桥接进程/配置不在本机可见范围（8787 无活跃客户端连接，D 盘与用户目录无 napcat 目录），需 QQ 那条线配合。
  备好的方案：`identity.json` 新增第二个 framework `qqbot`（独立 credential + 现有 `qq-*` agents + `claim_allowlist: ["qq-*/*"]`），QQ 侧改 credential_ref/secret；MCP 侧白名单收窄到 `admin-01/librarian-admin`。

## 5. 红线

- 不碰 `.\data\**` 里的 evidence 原文；不改全局 git 配置
- 不擅自重启 8787（会短暂中断记忆服务）；要重启先说明
- 身份/凭证改动先备份 `data/runtime/identity.json` 与 `api-keys.json`
