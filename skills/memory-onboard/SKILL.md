---
name: memory-onboard
description: 接入新 agent 到 MemoryLib 时使用：按 AGENT-SPEC 的三能力（读/写回/自声明）接入，用 P1–P4 自证，并排查 manifest、transcript、MCP 与权限问题。
---

# MemoryLib 接入（给接入方 agent 自己看）

**唯一权威**：仓库根的 `docs/AGENT-SPEC.md`（当前 v2.1）。本技能只是快捷路径；冲突时以规范为准，并在报告里指出冲突。

## 0. 先记住：规范规定"结果 + 怎么证明"，**不规定**你写哪个配置文件

`AGENT-SPEC §0` 定义统一接口 = **三能力 + 一份自声明 + 四条自证**：

| 能力 | 你要做到 |
|---|---|
| A **读** | 你的会话里能调通名为 `memory` 的 MCP server：`memory_health` / `memory_recall_brief` / `memory_search` |
| B **写回** | 你的对话能进 `evidence/conversations`：你 POST `/v1/conversations/capture`，或在 manifest 里声明 transcript 目录由我们 tail |
| C **自声明** | 写 `data/runtime/agents/<id>.json`，其中 `read.apply` **由你填**（你怎么接入、用什么命令，别人能照着复现即可） |

**你不需要问我们"记忆库在哪个文件夹"**：只认 `http://127.0.0.1:8787`（REST）或 `…/mcp`（MCP）。**禁止**把你的配置指向服务端的记忆库数据目录（由服务端 `--data-root` 持有，接入方不需要、也不允许知道它）。

## 1. 自声明：manifest 怎么写

```powershell
# 在仓库根执行（会探测你的目录/格式，先看它会写什么）
node scripts/agent-discover.mjs --agent <id>
# 确认后落盘
node scripts/agent-discover.mjs --agent <id> --write
# 校验（坏字段会逐条报）
node scripts/agent-discover.mjs --validate
```

**`read.apply` 三种形态（你选，你声明）**：

```json
{ "kind": "config", "configPath": "~/你的配置文件", "format": "json|toml|yaml" }
{ "kind": "cli",    "command": "<你的注册命令>", "verifyCommand": "<验证命令>" }
{ "kind": "manual", "notes": "我读哪个文件、手工怎么改" }
```

- `kind="cli"` ⇒ `command` 与 `verifyCommand` **都必填**；
- **如果 `apply` 带 `"inferred": true`**，那说明这是**我们自动探测的猜测，不是你的真实情况** —— 你必须自己核对；你确认/修改后把它改成 `inferred: false`（或删掉该字段）。

**写回（`write`）**：

```json
{ "mode": "transcript", "source": "<你的标识>",
  "sources": [{ "dirs": ["~/.你/sessions"], "format": "jsonl|jsonl-zst|json-object", "glob": "*.jsonl*" }],
  "credentialRef": "…", "agent": "…", "role": "capture-ingest" }
{ "mode": "hook", "source": "<你的标识>", "agent": "…", "role": "capture-ingest" }
```

- `transcript` ⇒ `sources[]` 必填；`hook` ⇒ `sources[]` 必须缺省（你自己 POST）；`none` ⇒ 只填 `mode`；
- 目录还不存在 ⇒ 保持 `state=discovered`，**不许**猜消息形状。

## 2. 自证：P1–P4（验收只看这四条）

| 自证 | 命令 | 通过标准 |
|---|---|---|
| **P1 读通** | `memory_health`（MCP）或 `GET http://127.0.0.1:8787/v1/health` | 返回 `health: "healthy"` |
| **P2 写回** | `node scripts/capture-tail.mjs --agent <id> --once --backfill --verify` | 打印 evidence 路径且 `source=<你的 source>`；manifest 变 `state=verified` |
| **P3 幂等** | 紧接着再跑一次（去掉 `--verify`） | `抽出 0 条消息，提交 0 次` |
| **P4 不越权** | 用你的 `reader` 身份 POST `/v1/conversations/capture` | **403**（`capture-ingest` 才是 200） |

**health 的三种形状（别搞混，`AGENT-SPEC §9.4`）**：

| 入口 | 有 `checks` 吗 | 完成标准 |
|---|---|---|
| `GET /v1/health`（匿名） | ❌ 扁平 `ok/service/version/health/audit/vector/capacity/index/audit_rotation` | `health === "healthy"` |
| MCP `memory_health`（**reader 与 admin 都一样**） | ❌ 同上 | `health === "healthy"` |
| `POST /v1/admin/health`（`librarian-admin`） | ✅ `checks[10]` | `checks` 全 ok |

## 3. 启用与托管

```powershell
node scripts/agent-discover.mjs --agent <id> --enable     # 只有 verified 才能启用
```

只有 `enabled` 且 `write.mode=transcript` 的才交给计划任务托管。`--dry-run` 只预览，**不推进偏移**。

## 4. 失败排查

- `--validate` 报字段 ⇒ 按报出的完整字段路径改类型/必填/枚举；**不要**把 secret 填进 manifest（只许 `credentialRef`）。
- `WARN read.configPath 不存在` ⇒ 说明你的 `configPath` 写错或还没建；`kind="manual"` 时这是允许的，但要写明你实际读哪个文件。
- `目录未出现` ⇒ 保持 `discovered`；目录出现后重跑 discover。
- `WARN unparsable <file> @offset` ⇒ 该文件里没有可识别的消息形状；**偏移不会前进**，修好格式后会自动重试。
- `401` ⇒ `memory_health` 401 才是凭据问题；`GET /health` 匿名 401 是**正常**（用 `/v1/health`）。
- `403` ⇒ 写回必须用 `capture-ingest`；`reader` 只能读。
- 第二次仍有消息 ⇒ 别删状态文件；先查 manifest 的目录/glob 是否重复、文件是否被重写。
- `zstdDecompressSync 不可用` ⇒ 你的 Node 低于 24；`jsonl-zst` 需要 Node 24+。

## 5. 交付时要报告什么（这比"配好了"更有价值）

1. P1–P4 的**命令与原始输出**；
2. 你填的 manifest 全文（尤其 `read.apply`，以及你是否改了 `inferred`）；
3. **"规范没规定、但你必须自己做决定"清单**：遇到什么决定 → 怎么定 → 希望规范怎么改；
4. **"规范说错/说漏"清单**；
5. 回滚方式（怎么退回接入前）。
