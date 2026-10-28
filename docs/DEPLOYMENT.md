# 从零部署（换一台机器照这个走）

> 目标：一台**干净机器**上，从空目录到"服务在跑、能写能搜、能接 agent"，全程可复制粘贴。
> 所有命令都在**仓库根**执行。当前验证过的平台：Windows 11 + Node 24.18；Linux 只验过 CI 的 smoke。

## 0. 前置检查

| 项 | 要求 | 怎么确认 |
|---|---|---|
| Node | **≥ 24**（用到 `zstdDecompressSync`） | `node --version` |
| 端口 | 默认 `8787`，可换 | `netstat -ano \| findstr :8787`（Windows）/ `ss -ltnp \| grep 8787` |
| 磁盘 | 数据根预留 ≥ 1GB（实测 1500 条记忆约几十 MB） | — |
| 可选 | Ollama + `bge-m3`（向量检索；不装也能跑） | `ollama list` |

## 1. 拿到代码

```bash
git clone https://github.com/1599600243/memory-lib.git
cd memory-lib
```

**clone 失败就重试**（本机实测该域名会间歇性 TLS 失败），或改用离线包：拿到仓库压缩包解压即可，目录结构一样。

## 2. 安装（先预览，再真装）

```bash
node scripts/install.mjs --dry-run --secret-store file     # 只打印将做什么
node scripts/install.mjs --write   --secret-store file     # 真执行
```

`--data-root` 指的是**整套部署工作区**（默认 `./memory-data`），装完是这样：

```
memory-data/
  memory/                  ← 服务数据（curated/、evidence/、indexes/）
  runtime/
    identity.json          ← 身份与角色（默认只有一个 reader 身份）
    secrets/               ← file 模式下的凭据（--secret-store file）
    deploy.json            ← 本次部署记录（port/timezone/store）
    audit/access.jsonl     ← 审计（每个请求一行）
```

要点：

- **默认干跑**，不加 `--write` 不动任何文件；
- 目标目录**非空会被拒绝**；确认要覆盖时加 `--force`，它会先产 `*.backup-<ts>.json.gz`；
- 同参数重复执行是 **`no-op`**（幂等，不会重建凭据）；
- 想装到别处：`--data-root /srv/memory-data`（install 与 doctor **必须传同一个值**）。

## 3. 建索引并启动

安装器最后会打印 `next-index` / `next-start`，照抄即可。默认值版本：

```bash
node app/memory-lib/scripts/index.mjs --data-root memory-data/memory

node app/memory-lib/server.mjs \
  --data-root memory-data/memory \
  --workspace-root memory-data \
  --registry memory-data/runtime/identity.json \
  --secrets-dir memory-data/runtime/secrets \
  --audit memory-data/runtime/audit/access.jsonl \
  --port 8787 --calendar-timezone Asia/Shanghai \
  --secret-store file --summary-index none
```

**服务只绑 `127.0.0.1`**（构造时拒绝 `0.0.0.0`）。要给别人用，请在前面加反向代理并自己负责鉴权。

### 让它常驻

**Windows**（计划任务，开机自启）：

```powershell
schtasks /Create /TN "memory-lib" /SC ONSTART /RU $env:USERNAME /TR "cmd /c cd /d C:\path\memory-lib && node app\memory-lib\server.mjs --data-root memory-data\memory --workspace-root memory-data --registry memory-data\runtime\identity.json --secrets-dir memory-data\runtime\secrets --audit memory-data\runtime\audit\access.jsonl --port 8787 --calendar-timezone Asia/Shanghai --secret-store file --summary-index none"
```

**Linux**（systemd，`/etc/systemd/system/memory-lib.service`）：

```ini
[Unit]
Description=memory-lib
After=network.target

[Service]
WorkingDirectory=/srv/memory-lib
ExecStart=/usr/bin/node app/memory-lib/server.mjs --data-root /srv/memory-data/memory \
  --workspace-root /srv/memory-data --registry /srv/memory-data/runtime/identity.json \
  --secrets-dir /srv/memory-data/runtime/secrets --audit /srv/memory-data/runtime/audit/access.jsonl \
  --port 8787 --calendar-timezone Asia/Shanghai --secret-store file --summary-index none
Restart=always

[Install]
WantedBy=multi-user.target
```

## 4. 自检（十项，带修复命令）

```bash
node scripts/doctor.mjs --data-root memory-data
```

期望：`doctor: 10/10 ok`。**没装 `bge-m3` 时第 4 项会是 `WARN`**，仍是 10/10（带 1 warning）。

| # | 检查 | 说明 |
|---|---|---|
| 1 | Node 与 zstd | Node < 24 直接失败 |
| 2 | 数据根可写 | 不存在就提示跑 install |
| 3 | 端口 | 空闲或"服务已在运行（MemoryLib）"都算通过 |
| 4 | 服务健康 | 可达 + `service=memory-lib`；**降级只算 WARN**，不可达/索引失败才是 FAIL |
| 5 | 凭据可读 | 按 `deploy.json` 的 store 查；file 缺文件就是 FAIL |
| 6 | 时区 | 必须是 IANA 名（`Asia/Shanghai`），不接受 `China Standard Time` |
| 7 | 索引表 | `5/5` 且 `quick_check=ok` |
| 8 | 审计可写 | 目录权限 |
| 9 | 计划任务 | 只有声明要用时才检查 |
| 10 | 数据未被 git 跟踪 | 防止把 `data/` 提交进仓库 |

退出码可直接当门禁：**有 FAIL ⇒ 1；只有 WARN ⇒ 0**。

## 5. 接一个 AI agent

契约（`docs/AGENT-SPEC.md`）：**能读、能写回、会自证**。

**读**（支持 MCP 的 agent，加一个 `memory` server）：

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["<仓库绝对路径>/scripts/memory-mcp-launch.mjs"],
      "env": {
        "MCP_MEMORY_URL": "http://127.0.0.1:8787",
        "MCP_MEMORY_CRED_REF": "memory-lib/local",
        "MCP_MEMORY_AGENT": "local-01",
        "MCP_MEMORY_ROLE": "reader"
      }
    }
  }
}
```

**写回**（二选一，都不用改对方代码）：

```bash
# A. 侧车扫它的会话文件
node scripts/capture-tail.mjs --dir <会话目录> --format jsonl --source <标识> --once --backfill --verify

# B. 它自己 POST /v1/conversations/capture（source / conversation_id / event_id / messages）
```

**自证四条**：`memory_health` healthy → evidence 里出现 `source` → 再次跑 0 条（幂等）→ `reader` 身份写捕获得 403。

> **默认身份只能读**。要写入得在 `runtime/identity.json` 里给它加一个带 `write` + `propose` 的角色（smoke 脚本里有完整示例）。

## 6. 备份 / 升级 / 回滚

```bash
# 停服务后备份数据根（文件即真相）
tar -czf memory-data-$(date +%F).tar.gz memory-data/

# 升级：拉新代码 → 重跑 install（幂等）→ 重启服务 → doctor
git pull
node scripts/install.mjs --write --data-root memory-data --secret-store file
```

**注意**：本版本不承诺数据格式向后兼容；升级前先备份。索引可随时重建（`index.mjs`），坏了大不了重建，**文件层才是真相**。

## 7. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `EADDRINUSE` | 端口被占；换个 `--port`，install/启动/doctor **三处要一致** |
| `凭据缺失` / 401 | `--secret-store file` 的文件被删了；重跑 install 生成，或改 wincred 模式 |
| `时区报错` | 必须 IANA 名；`Asia/Shanghai` ✅，`China Standard Time` ❌ |
| `health: degraded` | 常见于没装 `bge-m3`（向量车道 stale）或索引未建；跑一次 `index.mjs`，或 `ollama pull bge-m3` |
| 搜不到刚写的东西 | ① 写入方与读取方**不在同一 group**；② 索引未刷新（等 10s 或手动 `index.mjs`） |
| `clone` 卡住 / TLS 失败 | 该域名会间歇性抖动；重试，或用离线压缩包 |
| doctor 说"data 被 git 跟踪" | 你的数据根落在仓库里了；挪到仓库外，或确认 `.gitignore` 生效 |

## 8. 安全清单（部署前过一遍）

- [ ] 服务只绑 `127.0.0.1`，没有直接暴露公网；
- [ ] 凭据只在凭据管理器 / `runtime/secrets/`，**没有**进 git（`doctor` 第 10 项会查）；
- [ ] 公开场合的机器人只用 `reader` + `capture-ingest`，**绝不给 `librarian-admin`**；
- [ ] 备份有异地副本；
- [ ] 知道 `data/memory` 是"真相"，索引只是可重建的缓存。
