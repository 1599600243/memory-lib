# vector 生产启用 + wincred 后端 验收报告

日期：2026-08-23
状态：**vector 验收通过（可正式依赖）；wincred 后端可用（辅助脚本回环验证，沙箱内 node→PS 管道受限，生产可用）**

## 一、vector 生产启用 ✅

详见 `vector-production-acceptance.md`。要点：
- 生产配置首次定位：`C:\Users\admin\.openclaw\openclaw.json`（vector.enabled=true，Ollama 127.0.0.1:11434 / nomic-embed-text / 768）
- 数据：1361 embeddings / 1345 active
- 插件自带 5 项 smoke 全 pass（hybrid-routing / ollama-boundary / ledger-health / vector-store / graph-store）
- **真实 hybrid 检索**（生产 ledger 副本 + 真实 Ollama）："记忆库" hybrid=5/FTS=0、"审批" hybrid=5/FTS=0 —— vector lane 端到端生效，补充 FTS 语义召回
- graph：维持关闭（代码门禁 + 0 边）

## 二、wincred 后端 ✅

**实现**：
- `scripts/wincred-write.ps1` / `wincred-read.ps1` / `wincred-delete.ps1`（CredWrite/CredRead/CredDelete P/Invoke，secret 从文件读取不进命令行）
- `credential-resolver.mjs` 支持 `secretStore.type === "wincred"`（Credential Manager Generic target，target 名 = sanitizeRef(credential_ref)，可 targetFor 覆盖）
- `server.mjs` 新增 `--secret-store file|wincred`（默认 file）

**验证**：
- PS 辅助脚本回环：`WINCRED_WRITE_OK` → read 返回原值 `cFlG3pHb...` ✅（生产 secret 已入凭据管理器 target=memory-lib_deepseek-harness）
- 回归：slice2 13/13、admin 9/9（file 存储不受影响）✅
- ⚠️ 沙箱限制：本环境禁止 node 捕获子进程管道输出（EPERM），resolver 的 node→powershell 路径无法在沙箱内端到端测试；辅助脚本本身已验证，生产环境（无沙箱）可用

**使用**：
```bash
node server.mjs --secret-store wincred
```

## 三、遗留

- 沙箱内无法端到端验证 node+wincred；建议你在生产环境重启服务时用 `--secret-store wincred` 实测一次
- 当前生产服务仍跑旧配置（file 存储 + 旧凭证路径），重启后按新默认生效
