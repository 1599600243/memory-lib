# 收尾批次验收报告（清理 / ledger 加固 / 生产落位 / 自启 / 文档）

日期：2026-08-23
状态：**全部通过（回归 49/49）**

## ① .bak 备份清理 ✅

- 删除 tools/.bak × 21、learning/.bak × 1、插件 src/.bak × 2，共 **24 个**
- 删除前抽查 3 个修复脚本：语法 0 错误、无旧路径残留
- 当前 memory-data 树 .bak 残留：**0**

## ② ledger 并发加固 ✅

- 活体插件 `src/infrastructure/ledger.ts` `openLedger()` 增加：
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  ```
  （解决此前发现的无 WAL、无超时 → 多进程并发会撞 SQLITE_BUSY 的问题）
- 改前备份：`ledger.ts.bak-pre-wal-*`
- 验证：parity 探测（导入含 ledger.ts 的 service.ts）→ **PARITY_OK**，插件可加载、行为不变

## ③ 注册表/审计生产落位 ✅

- `I:\OpenClaw\memory-data\runtime\identity.json`（拷贝开发注册表，内容一致）
- `I:\OpenClaw\memory-data\runtime\audit\`（审计落位 D4）
- `server.mjs` 默认值更新：registry/audit → I 盘 runtime；`--registry/--audit` 仍可覆盖
- 验证：`node server.mjs --port 8790` 用新默认值启动 → health 200

## ④ 开机自启 ✅

- 计划任务 `memory-lib-core`（schtasks onlogon，当前用户，无需管理员）→ `autostart.cmd` → `node server.mjs`
- `install-autostart.cmd` / `uninstall-autostart.cmd` 提供装/卸（双击即可）
- 实测：任务运行正常；端口被占用时 **Last Result=1（友好退出，无崩溃框）** —— 正是防重复启动设计

## ⑤ README 全景总文档 ✅

`memory-lib/README.md` 升级为总览：架构图、快速开始、目录结构、协议表、安全模型、治理闭环、
**8 份验收报告索引**、运维（自启/换凭证/端口冲突）、只读核心同步清单、测试命令、已知边界。

## 回归

全部 5 套测试 **49/49 通过**（contract 9 + slice2 13 + propose 7 + admin 9 + mcp 11）；
运行中服务（8787）health 200 正常。

## 剩余待办（需你参与）

1. **换生产凭证**：真凭证写入 secret 文件（当前仍是开发凭证）；可选实现 wincred 后端
2. **候选 promote**：`project-pilot-dca8d276` 是否进入 curated（reviewNotes 已批准，但注明不等同生产上线）
3. 新框架接入（如电商）：注册 framework + agent + role 即可
4. 可选深化：OpenClaw 走 core 协议、vector/graph 生产启用、MCP HTTP 传输
