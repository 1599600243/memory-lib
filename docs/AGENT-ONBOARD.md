# 让任意 Agent 接上记忆库（接入矩阵）

> 目标：**同一件事不再被问第二遍**，不管你用的是 DSH、Codex、Claude Code、Cursor、OpenClaw 还是别的。
> 前提：记忆服务 `8787` 在跑；任何支持 **MCP** 的客户端都能接。

## 一、接入分三件事（不同 agent 支持程度不同）

| 能力 | 靠什么 | DSH | Codex | Claude Code | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| ① **读/写记忆** | MCP（stdio 或 http） | ✅ 已连 | ✅ **已配好并验证** | 生成配置即可 | 生成配置即可 | 生成配置即可 |
| ② **写回记忆**（捕获对话） | 各家的 hook / transcript | ✅ 插件自动 | 需适配器（P1） | 需适配器（P1） | 需适配器（P1） | 需适配器（P1） |
| ③ **自动注入**（每轮塞记忆） | 各家 system prompt hook | ✅ 插件 | 无（改用"自己取一次"） | 同 | 同 | 同 |

**关键**：没有 ③ 的 agent，用 **`memory_recall_brief`** 补——让它在回答前自己调一次，效果接近注入。
把 `--instructions` 生成的段落粘进它的规则文件（`AGENTS.md` / `CLAUDE.md` / `.cursorrules`）即可。

## 二、一条命令接入（推荐）

```powershell
cd .

# 1) 生成配置（密钥默认打码，不显示在屏幕）
node scripts\agent-onboard.mjs --agent codex          # 打印 TOML
node scripts\agent-onboard.mjs --agent claude-code    # 打印 JSON / claude mcp add 命令
node scripts\agent-onboard.mjs --agent cursor         # 打印 .cursor/mcp.json
node scripts\agent-onboard.mjs --agent openclaw       # 打印 JSON + HTTP 备选

# 2) 直接写进配置文件（密钥只落文件，不回显）
node scripts\agent-onboard.mjs --agent codex --write          # → %USERPROFILE%\.codex\config.toml
node scripts\agent-onboard.mjs --agent cursor --write         # → .\.cursor\mcp.json
node scripts\agent-onboard.mjs --agent claude-code --write    # → .\.mcp.json

# 3) 真实握手验证（启动 stdio MCP 并调三个工具，不花模型钱）
node scripts\agent-onboard.mjs --agent codex --verify

# 4) 生成"怎么用记忆"的规则段落，粘进该 agent 的 AGENTS.md
node scripts\agent-onboard.mjs --instructions
```

**身份**默认 `pilot-01 / reader`（只读，最安全）。要写记忆时显式提身份：

```powershell
node scripts\agent-onboard.mjs --agent codex --write --agent-id admin-01 --role librarian-admin
```

## 三、已验证的事实（2026-10-26）

**Codex**：

```
$ codex mcp list
Name    Command                      Args                                            Env                      Status   Auth
memory  node  .\...\mcp-server.mjs                 MCP_MEMORY_*=*****       enabled  Unsupported
```

**stdio MCP 握手（同一份配置，等价于 Codex 启动时做的事）**：

```
initialize      ✅ memory-lib-mcp 0.2.0
tools/list      ✅ 49 个工具（含 memory_search / memory_recall_brief / memory_write）
memory_health   ✅ healthy
memory_recall_brief(记忆库几层) ✅ 返回"记忆库收敛为 8 层…"
```

## 四、各家细节

### Codex（已配好）

配置在 `%USERPROFILE%\.codex\config.toml`，用 `[mcp_servers.memory]` 段。重启 Codex 生效。
验证：`codex mcp list` 看到 `memory ... enabled`。

### Claude Code

```powershell
claude mcp add memory --scope user -- <命令里的 env 逐项 --env> -- "node" "app/memory-lib\mcp\mcp-server.mjs"
```
或把 `--write` 生成的 `.mcp.json` 放到项目根。

### Cursor

`--write` 生成 `.cursor/mcp.json`（项目级）或放 `%USERPROFILE%\.cursor\mcp.json`（全局）。

### OpenClaw

`--agent openclaw` 会打印 JSON 模板；若它只支持 HTTP MCP，用：

```
url:     http://127.0.0.1:8787/mcp
headers: X-MCP-Credential-Ref / X-MCP-Secret / X-MCP-Agent / X-MCP-Role
```

### 通用（任何 stdio MCP 客户端）

```
command: node
args:    app/memory-lib\mcp\mcp-server.mjs
env:     MCP_MEMORY_URL / MCP_MEMORY_CRED_REF / MCP_MEMORY_SECRET / MCP_MEMORY_AGENT / MCP_MEMORY_ROLE
```

## 五、安全与租户

- **不要给所有 agent 管理员身份**：默认 `reader` 只能读；写 `private`/`platform` 需要 `librarian-admin`。
- 密钥在 `wincred`（`memory-lib/deepseek-harness`），配置里写的是引用还是明文取决于客户端能力；
  我们的 `--write` 会把密钥写进该客户端的配置文件（本机），**不写进仓库、不回显到屏幕**。
- 想按 agent 分租户：`/v1/admin/framework/create` 建独立 framework + 独立 key（P1 做工具化）。

## 六、捕获适配器（P1-a，2026-10-27）

**问题**：没有 ② 的 agent，它说的话**进不了记忆库** —— 只读不写，等于"同一件事还会被问第二遍"。

**做法（聚合通用）**：不写 N 套入库逻辑，只写一个**通用 tailer** + 每个 agent 一句"怎么抽消息"：

```
任意 transcript(JSONL)  ──[capture-tail.mjs]──▶  POST /v1/conversations/capture
                                                  （source / conversation_id / event_id / messages）
```

### 用法

```powershell
# 跑一遍（回填历史）
node scripts\capture-tail.mjs --dir "$env:USERPROFILE\.codex\sessions" --format codex --source codex --once --backfill

# 常驻（每 15 秒扫一次新增；默认只读增量）
node scripts\capture-tail.mjs --dir "$env:USERPROFILE\.claude\projects" --format claude --source claude-code

# 先看会提交什么（不写库、不前进偏移）
node scripts\capture-tail.mjs --dir <dir> --format plain --source manual --once --backfill --dry-run
```

### 它保证的三件事

1. **幂等**：按文件记录字节偏移（状态在 `state\capture-tail-<source>.json`），重启不重复入库，`event_id = 文件:偏移`；
2. **dry-run 不落状态**：预览之后真跑仍然会提交（这个 bug 已修，见下）；
3. **不挑格式**：一行 JSON 里只要能找到 `{role, content}` / `{message:{role,content}}` / `{payload:{type:"message",role,content}}` 三种常见形状之一就抽得出来。

### 真实验证（2026-10-27，在 `mem-1445` 副本上，未碰生产）

```
造两份 transcript（Codex rollout 形状 + Claude Code 形状）各 2 条消息
dry-run            ✅ 抽出 4 条，0 提交，状态文件未创建
真提交             ✅ 提交 2 次，失败 0，耗时 2.1s，退出码 0
再跑一遍（幂等）    ✅ 0 条（偏移已前进）
副本落盘           ✅ evidence/conversations/conversation-158255e1….md
                     source: "codextest"、calendarDate: 2026-10-27（按 Asia/Shanghai 事件日）
测试数据已清除       ✅ 副本基线保持干净
```

### 还差的一步（P1-c，未做）

**常驻托管**：现在需要手动起进程。要真正"自动"，得给每个 agent 建一个计划任务（开机启动 + 崩溃重启），
像 `memory-lib-core` 那样。做之前要先确认各 agent 的 transcript 目录是否稳定。


