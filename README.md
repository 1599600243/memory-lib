# memory-lib

> **状态：个人自用 / 实验性项目。** 接口与数据格式仍在变，暂不保证向后兼容。
> 我把它开源出来，是因为"AI 的记忆"这件事值得多看几种做法；**它不是生产级产品**，用之前请自己评估。

一个**本地优先**的长期记忆服务：文件是真相，SQLite 只是可重建的索引，通过 **HTTP + MCP** 两套标准接口对外提供服务。

## 它想解决什么

跟 AI 聊过的事，下次不该再问一遍。为此它做四件事：

| 能力 | 做法 |
|---|---|
| **存** | 8 层记忆模型（共享/角色/项目/工具/计划/画像/证据文档 + 原始对话），每条记忆有**两个时间轴**：事件发生时间 与 记录时间 |
| **取** | 纯词面检索（不需要 embedding 也能用），按"事件日"整日枚举，答不出来就说没有，**不编** |
| **写回** | 两种都不改对方代码：侧车扫 transcript（jsonl / jsonl+zstd / json-object），或对方直接 POST |
| **注入** | 有宿主扩展点时每轮自动注入（`native`）；没有时要求 agent 自己调（`on-demand`）——契约见 [`docs/INJECT-SPEC.md`](docs/INJECT-SPEC.md) |

## 5 分钟跑起来

前置：**Node.js 24+**（用到 `zstdDecompressSync`）。可选：本机 Ollama + `bge-m3`（启用向量检索；不装也能跑，只是健康状态里向量车道为 `stale`）。

```bash
# ① 安装（默认只预览，不写文件）
node scripts/install.mjs --dry-run --secret-store file
node scripts/install.mjs --write --secret-store file

# ② 建索引并启动（按安装器打印的 next-index / next-start 抄）
node app/memory-lib/scripts/index.mjs --data-root memory-data/memory
node app/memory-lib/server.mjs --data-root memory-data/memory --workspace-root memory-data \
  --registry memory-data/runtime/identity.json --secrets-dir memory-data/runtime/secrets \
  --audit memory-data/runtime/audit/access.jsonl --port 8787 \
  --calendar-timezone Asia/Shanghai --secret-store file --summary-index none

# ③ 自检（另一个终端）
node scripts/doctor.mjs --data-root memory-data
```

`doctor` 十项全过 = `10/10 ok`；若没装 `bge-m3`，第 4 项会是 `WARN`（不是失败）。**每一项失败都会给一条可执行的修复命令。**

## 接入一个 AI agent

契约只有三条：**能读、能写回、会自证**（`docs/AGENT-SPEC.md`）：

- **读**：任何支持 MCP 客户端的 agent，加一个 `memory` server 指向 `scripts/memory-mcp-launch.mjs` 即可；不支持的走 HTTP。
- **写回**：`capture-tail.mjs` 扫它的会话文件，或它自己 POST `/v1/conversations/capture`。
- **自证**：`memory_health` healthy / evidence 里出现 `source` / 二次跑 0 条 / 越权 403。

接入工具：

```bash
node scripts/agent-discover.mjs --agent <id>        # 探测目录与格式，生成 manifest（默认 dry-run）
node scripts/capture-tail.mjs --agent <id> --once --backfill --verify
```

给 agent 自己看的技能在 [`skills/memory-onboard/SKILL.md`](skills/memory-onboard/SKILL.md)。

## 目录

```
app/memory-lib/    服务本体（HTTP + MCP、检索、写入、索引、控制台）
scripts/           安装、自检、接入、写回侧车
docs/              接入规范（AGENT-SPEC）、注入契约（INJECT-SPEC）、版本策略
skills/            给接入方 agent 的 onboarding 技能
```

## 安全与隐私（重要）

- 密钥**只**通过 `credentialRef` 引用（Windows 凭据管理器 / 文件），仓库里**没有任何 secret**；
- 服务默认只绑 `127.0.0.1`；
- 数据目录（`data/`）**不在本仓库**，`.gitignore` 已挡住运行时产物；
- 记忆有**可见性**与**身份**：`reader` 只能看共享层，写回用 `capture-ingest`，管理用 `librarian-admin`——**别把 admin 身份给公开场合的机器人**。

## License

MIT，见 [`LICENSE`](LICENSE)。
