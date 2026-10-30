# AGENT-SPEC：接入记忆库的统一规范（v1）

> 目的：**新接一个 agent，不需要改代码、不需要问人"你的记忆在哪"** —— 填一份 manifest，跑一次校验，就算接上了。
> 制定：产品岗 2026-10-27。实现见 `orders/AGENT-SPEC-1-manifest-and-discover.md`（本单已在仓库，见 `orders/`）。

## 0. 统一接口：三能力 + 一份自声明 + 四条自证（v2，**这一节是规范的核心**）

> **规范规定"结果"和"怎么证明"，不规定"你写哪个配置文件、用什么命令"。**
> 因为每个 agent 的配置机制是**它自己的知识**（有人读 `mcpServers`、有人读 `mcp.servers`、有人只能用 CLI 注册、有人只能手工）。
> 规范一旦去规定"格式"，就等于把某一家写死，换一家就废。所以：

### 0.1 三个能力（必须都能演示）

| 能力 | 要求（只规定结果） |
|---|---|
| **A. 读** | 在**你自己的会话里**能调用一个名为 `memory` 的 MCP server，且 `memory_health` / `memory_recall_brief` / `memory_search` 可调通 |
| **B. 写回** | 你的对话能进 `evidence/conversations`：要么你 **POST** `/v1/conversations/capture`，要么你在 manifest 里声明 transcript 目录**由我们 tail** |
| **C. 自声明** | 在 `D:\MemoryLib\data\runtime\agents\<id>.json` 写一份 manifest（§1），**其中 `read.apply` 由你填**：你是用改配置、用你自己的 CLI、还是只能手工 |

### 0.2 一条硬规矩（不变）

- 记忆库位置由**服务端**决定（`--data-root`）；你只认 **`http://127.0.0.1:8787`**（REST）或 **`…/mcp`**（MCP）；
- **禁止**在你的配置里出现 `D:\MemoryLib\data\memory` 这类路径。

### 0.3 四条自证（**验收只看这四条，不看你怎么配的**）

| 自证 | 怎么证明 |
|---|---|
| **P1 读通** | `memory_health`（或 `GET /v1/health`）返回 `health: "healthy"`，附原始输出 |
| **P2 写回** | 提交一次对话后，`evidence/conversations` 出现新文件，`source` 等于你 manifest 里声明的 `source` |
| **P3 幂等** | 紧接着再跑一次写回 ⇒ **0 条新增** |
| **P4 不越权** | 你的 `reader` 身份 POST `/v1/conversations/capture` ⇒ **403**；`capture-ingest` ⇒ 200 |

### 0.4 因此：`apply` 是**你的声明**，不是我们的规定

- 你在 `read.apply.command` 里写**你自己那条可复现的命令**（或者 `kind="manual"` + 写清手工步骤）；
- 若 `apply` 与我们的"已知提示表"（§9.2，仅作参考）不一致，**以你的声明为准**——因为只有你知道自己读哪个文件；
- 你声明的方式**必须能被别人照着复现**（这是唯一要求）。

## 1. Manifest：每个 agent 一份

位置：`D:\MemoryLib\data\runtime\agents\<id>.json`（`id` 用 kebab-case，如 `codex`、`claude-code`、`openclaw`）。

```json
{
  "specVersion": 1,
  "id": "openclaw",
  "displayName": "OpenClaw",
  "read": {
    "mode": "mcp",
    "server": "memory",
    "configPath": "~/.openclaw/config.json",
    "credentialRef": "memory-lib/openclaw",
    "agent": "openclaw-01",
    "role": "reader"
  },
  "write": {
    "mode": "transcript",
    "source": "openclaw",
    "sources": [
      { "dirs": ["~/.openclaw/agents/*/sessions"], "format": "jsonl-zst", "glob": "*.jsonl*" }
    ],
    "credentialRef": "memory-lib/openclaw",
    "agent": "openclaw-01",
    "role": "capture-ingest"
  },
  "inject": "brief-on-demand",
  "state": "discovered",
  "notes": ""
}
```

### 1.1 `read`：怎么读记忆（必填）

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `mcp` \| `http` \| `none` | 首选 `mcp`（stdio 或 streamable-http） |
| `server` | string | MCP server 名（约定 `memory`） |
| `configPath` | string | 该 agent 的 MCP 配置**文件**（用于写配置与自检） |
| `credentialRef` | string | 密钥引用（wincred 条目），**manifest 里不许出现明文 secret** |
| `agent` / `role` | string | 该接入方的读写身份（默认只读 `reader`） |

**条件必填（v1.1 澄清）**：`mode="none"` 时，`server` / `configPath` / `credentialRef` / `agent` / `role` **可以省略**（表示该 agent 不读记忆，只写回）；`mode="mcp"|"http"` 时上述字段**全部必填**。

### 1.2 `write`：怎么把对话写回来（必填，可为 `none`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `transcript` \| `hook` \| `none` | `transcript`=我们扫它的文件；`hook`=它自己 POST |
| `source` | string | 入库时的 `source` 标签（用于区分"这话是谁说的"） |
| `sources[]` | array | 每项 `{ dirs[], format, glob }`；`dirs` 支持 `~` 与 `*` 通配 |
| `format` | `jsonl` \| `jsonl-zst` \| `json-object` | 见 §2 |
| `agent` / `role` | string | 写身份必须是 `capture-ingest`（只允许写 evidence，不允许直写 curated） |

**条件必填（v1.1 澄清）**：
- `mode="transcript"` ⇒ `sources[]` **必须非空**，且每项 `format` 必填；
- `mode="hook"` ⇒ **`sources[]` 必须缺省或为空数组**（它自己 POST，我们没有文件可扫；DSH 就是这一形态）；
- `mode="none"` ⇒ 除 `mode` 外全部可省略。

**明文密钥禁令（v1.1 补充，必须机器校验）**：manifest **任意层级**出现以下键名即判失败（大小写不敏感）：
`secret`、`password`、`token`、`apiKey`、`api_key`、`bearer`。密钥只能通过 `credentialRef` 引用。

### 1.3 `inject`：要不要自动注入（必填）

| 取值 | 含义 |
|---|---|
| `native` | 该 agent 有我们的插件/hook，能每轮自动注入（如 DSH） |
| `brief-on-demand` | 没有注入能力，要求它**回答前自己调** `memory_recall_brief`（配合规则段落，见 `agent-onboard --instructions`） |

### 1.4 `state`：接入状态机

```
discovered → verified → enabled
                ↘ disabled（人显式关掉）
```

- `discovered`：`agent-discover` 探测到了目录/格式，但**没验证过**能真入库；
- `verified`：跑过 `--verify`，**真实提交过一次并读回证据**；
- `enabled`：`capture-tail` 会托管它（只有 `enabled` + `write.mode=transcript` 才跑）。

**只有 `enabled` 的才会被自动托管**；`discovered` 的只在列表里显示，不占资源。

## 2. 格式适配：只认三种，不认识就报错
| | |
|---|---|
| `jsonl` | 纯文本 JSONL，每行一个 JSON |
| `jsonl-zst` | **zstd 压缩**的 JSONL（OpenClaw 的会话就是 `.jsonl.deleted.<ts>.zst`） |
| `json-object` | 整个文件是一个 JSON（可能含 `messages[]` 数组） |

**消息抽取规则**（顺序尝试，不猜）：
1. `{role, content}`，`content` 为字符串或 `[{type:"text",text}]`；
2. `{message:{role, content}}`；
3. `{payload:{type:"message", role, content}}`（Codex rollout 形状）；
4. `{messages:[...]}`（json-object 的容器）。

**抽不到就报错**，不许"尽力猜"——宁可 `discovered` 卡住等人看一眼，也不要把垃圾写进记忆库。

## 3. 幂等与去重
- 每个文件记录**字节偏移**（`D:\MemoryLib\state\capture-tail-<id>.json`）；
- `event_id = <conversation_id>:<startOffset>-<endOffset>`；服务端按 `event_id` 去重；
- **`--dry-run` 绝不前进偏移**（曾经的 bug：预览之后真跑就没内容了）。

## 4. 身份与权限（不许例外）
| 用途 | role | 能做什么 |
|---|---|---|
| 读记忆 | `reader` | `memory_search` / `memory_recall_brief` / `memory_get` |
| 写回对话 | `capture-ingest` | 只能 `POST /v1/conversations/capture`（写 evidence，不直写 curated） |
| 管数据 | `librarian-admin` | 仅人工/管理用途，**不许给普通 agent** |

## 5. 一次接入的完整流程（5 步，都可脚本化）

```powershell
# 1) 探测：扫描已知候选目录，判断格式，生成 manifest（默认 dry-run，不落盘）
node scripts\agent-discover.mjs --agent openclaw

# 2) 落盘：写成 data/runtime/agents/openclaw.json，state=discovered
node scripts\agent-discover.mjs --agent openclaw --write

# 3) 配置读侧：生成该 agent 的 MCP 配置（或打印片段）
node scripts\agent-onboard.mjs --agent openclaw --write

# 4) 验证：真提交一次并读回证据，通过后 state=verified
node scripts\capture-tail.mjs --agent openclaw --once --backfill --verify

# 5) 启用：state=enabled（之后由计划任务托管）
node scripts\agent-discover.mjs --agent openclaw --enable
```

## 6. 验收判据（接一个新 agent 必须满足）

- **A1** manifest 通过 schema 校验（字段类型/枚举/必填）；
- **A2** `read` 侧真能调通：`memory_health` 返回 `ok:true`（或 REST 等价）；
- **A3** `write` 侧真能入库：跑一次 `--backfill --verify`，`evidence/conversations` 下出现新文件，`source` 等于 manifest 的 `source`；
- **A4** 幂等：再跑一次 **0 条**；
- **A5** 不越权：用 `reader` 身份尝试 `POST /v1/conversations/capture` 必须 **403**；
- **A6** 记忆库位置不出现在 manifest 里（grep 断言：不出现 `data\memory`）。

## 7. 已有接入现状

| agent | read | write | inject | state |
|---|---|---|---|---|
| `deepseek-harness` | mcp（内置） | hook（插件，native） | `native` | `enabled` |
| `codex` | mcp（已配 `~/.codex/config.toml`） | transcript（`~/.codex/sessions`，**目录还没出现**） | `brief-on-demand` | `discovered` |
| `openclaw` | mcp（待配） | transcript（`~/.openclaw/agents/*/sessions`，`.jsonl.deleted.*.zst`） | `brief-on-demand` | `discovered` |

## 8. 自举（v1.1 新增）：声明 → 生成 → 验证

> 目标（用户原话）：**"后面别的东西接入，就能直接按规范来给自己快速搭一个技能出来"**。
> 所以规范不只是给人读的文档，还必须能**机器消费**：一份 manifest 进，一套接入物出。

### 8.1 一份 manifest 应当生成这些东西

| 生成物 | 路径 | 作用 |
|---|---|---|
| 该 agent 的自配技能 | `~/.dsh/skills/memory-<id>/SKILL.md` | 让该 agent **自己读、自己配**（读侧 MCP + brief 用法 + 失败排查） |
| 读侧 MCP 配置片段 | 按 `read.configPath` 的格式输出（toml / json） | 直接粘或 `--write` 落盘 |
| 写侧配置文件 | `data/runtime/agents/<id>.json` | capture 托管的输入 |
| 校验清单 | 打印出来的 5 条命令 | 声明 → 生成 → 验证一条龙 |

### 8.2 生成器契约

```
node scripts/agent-scaffold.mjs --agent <id> [--manifest-dir <dir>] [--dry-run] [--write]
```

- 输入：该 agent 的 manifest（若不存在，先跑 `agent-discover` 生成骨架）；
- `--dry-run`（默认）：**打印**将要生成的每个文件路径 + 内容，不落盘；
- `--write`：落盘；**已存在且内容相同则不重写**（幂等），内容不同则备份 `.bak-<ts>` 再写；
- 生成物**不许**包含明文 secret、**不许**包含记忆库数据路径（`data\memory`）；
- 生成物里的 agent 名/身份/目录，**全部来自 manifest**，不许硬编码。

### 8.3 自举的验收判据

- **B1** 给一个**从未接入过的假 agent**（manifest 手写，目录用临时目录）跑 `--write`，生成 4 类产物且路径正确；
- **B2** 生成的 SKILL.md 里：不含明文 secret、不含 `data\memory`、包含"先调 `memory_recall_brief`"的指令；
- **B3** 幂等：连跑两次，第二次**不重写**任何文件；
- **B4** 生成的技能**真的能用**：把该 SKILL.md 临时挂进 skills 目录 → 用一个 agent 读它 → 它按里面的三步能配好（至少能跑通 `memory_health`）；
- **B5** 删掉该 agent 的 manifest 目录与生成物后重跑，能**从零重建**（不依赖上一次的残留）。


**v1.1 补充（capture 侧，必须实现）**：`capture-tail` 遇到"文件非空、但一行消息都抽不出"时，**不许 exit 0 静默跳过**：
1. 该文件**不前进偏移**（否则永久跳过后面的内容）；
2. 记一条 `WARN unparsable <file> @offset=<n>` 到日志；
3. 同一文件连续 3 轮抽不出 ⇒ 在 manifest 的 `notes` 里记 `unparsable:<file>`，并在 `--verify` 里报红；
4. `--dry-run` 同样要报这条 WARN（预览时就该看见）。

**v1.2 澄清（与实现对齐）**：
- `sources[].glob` **可选，默认 `*`**（少一个必填项，接入方少踩一次坑）；实现必须按默认 `*` 处理；
- `write.credentialRef` **必填**（`mode≠none` 时），与 `read.credentialRef` 同源或独立；
- `write.agent` / `write.role` 必填（`mode≠none` 时），`role` 必须是 `capture-ingest`。

## 9. 读侧"落地方式"（v1.3 新增，必须实现）

> 起因：实测本机 **OpenClaw 2026.10.5** 的 MCP 配置**不在** `mcpServers`，而在 `~/.openclaw/openclaw.json` 的 **`mcp.servers`**，
> 且它提供 `openclaw mcp add <name> --command … --arg … --env k=v`（**保存前会自校验**）。
> 也就是说：**"写哪个文件、怎么写"是 agent 特有的**，不能一律假设 `mcpServers`。

### 9.1 manifest 增加 `read.apply`

```json
"read": {
  "mode": "mcp",
  "server": "memory",
  "configPath": "~/.openclaw/openclaw.json",
  "apply": {
    "kind": "cli",
    "command": "openclaw mcp add memory --command \"<node>\" --arg \"<launcher>\" --env MCP_MEMORY_URL=http://127.0.0.1:8787 --env MCP_MEMORY_CRED_REF=<ref> --env MCP_MEMORY_AGENT=<agent> --env MCP_MEMORY_ROLE=<role>",
    "verifyCommand": "openclaw mcp list"
  },
  "credentialRef": "memory-lib/deepseek-harness",
  "agent": "pilot-01",
  "role": "reader"
}
```

- `apply.kind`：`config`（往 `configPath` 合并一段 JSON/TOML）| `cli`（用该 agent 自己的命令注册）| `manual`（无法自动，只出说明）；
- `apply.command`：**必须可复制粘贴**，占位符 `<node>` / `<launcher>` / `<ref>` / `<agent>` / `<role>` 由 scaffold 用真实值渲染；
- `apply.verifyCommand`：跑它就能看到"注册成功了没"；
- `apply` 缺省时按 `kind="config"` 处理（向后兼容）。

### 9.2 参考提示表（**只是提示，不是要求**；以接入方自己的 `apply` 声明为准）

| agent | 配置文件 | 键路径 | 常见做法 |
|---|---|---|---|
| OpenClaw | `~/.openclaw/openclaw.json` | `mcp.servers` | 用 `openclaw mcp add …`（它保存前自校验） |
| Codex | `~/.codex/config.toml` | `[mcp_servers.memory]` | 改 TOML 段 |
| Claude Code | `~/.claude.json`（或 `~/.claude/settings.json`） | `mcpServers` | 改 JSON 段 |
| DSH | `~/.dsh/profiles/web/cordis.patch.yml` | yaml `mcp.memory` | 改 yaml 段 |

**用法**：这张表只用于"我们帮它猜一下"和"校验它声明得对不对"，**不得**作为任务书里的指令。
**接入方自己知道它读什么**；它声明什么，就以什么为准（§0.4）。

**探测规则（工具侧）**：先看它声明的 CLI 是否存在（`where <bin>`）；否则看 `configPath` 是否存在并含提示表里的键；都没有 ⇒ `kind="manual"` + `configPathVerified:false`，只出说明、不写文件。

### 9.3 scaffold 的渲染要求

生成的 SKILL.md 第 1 节，必须按 `apply.kind` 给**该 agent 专用**的落地步骤：

- `cli`：给完整命令行（含真实 node/launcher 路径），并给 `verifyCommand`；
- `config`：给该 agent 的**正确键路径**（例如 Codex 是 TOML 的 `[mcp_servers.memory]`，**不是** JSON 的 `mcpServers`）；
- `manual`：明说"这个 agent 需要手工配，我们不知道它读哪里"，并给等价验证（`/v1/health`）。

**禁止**：不管什么 agent 都吐一段 `mcpServers` JSON。那对 OpenClaw / Codex 都是错的。

### 9.4 health 的三种真实形状（v1.3.1 更正，**我之前写错过，以本节为准**）

我实测了三个入口，**只有管理员 HTTP 路由才有 `checks`**：

| 入口 | 调用方式 | 顶层键 | 完成标准 |
|---|---|---|---|
| 公共健康 | `GET /v1/health`（匿名） | `ok, service, version, health, audit, vector, capacity, index, audit_rotation` | `health === "healthy"`（可加 `vector.status === "ok"`、`index.failed === 0`） |
| MCP 健康 | `memory_health({})`（**reader 与 admin 都一样**） | 同上，**无 `checks`** | 同上 |
| 管理员健康 | `POST /v1/admin/health`（`librarian-admin`） | 多了 `checks[10]`、`dataRoot`、`roots`、`scopeMode`、`principal` 等 | `checks` **全为 ok**（10 项：curated / project-state / tools-memory / plans / profile / evidence-documents / evidence-conversations / recovery-policies / recovery-plans / vector-lane） |

**因此**：给普通接入方（reader）的技能里，**禁止**把"checks 全 ok"当完成标准——它取不到 `checks`；只有管理员身份才用 `POST /v1/admin/health` 判 10 项。

**教训（写进规范，防止再犯）**：不能把某个入口的返回结构当成所有入口的；写"完成标准"前必须**逐入口实测**。

### 9.5 猜测必须"可识别"（v2.1，新增，必须实现）

`agent-discover` 写进 manifest 的 `read.apply`，如果来自**内置提示表**（§9.2）而不是接入方自己声明，**必须带标记**：

```json
"apply": { "kind": "cli", "command": "…", "verifyCommand": "…", "inferred": true, "inferredFrom": "AGENT-SPEC §9.2 hint table" }
```

- `inferred: true` ⇒ 这是我们的猜测；
- `agent-scaffold` 渲染时，凡是 `inferred: true` 的步骤，前面必须加一行醒目提示：
  **「以下为自动探测的猜测，请确认后再执行（你若知道自己怎么配，以你的为准）」**；
- 接入方自己写 `apply` 时 **不带** `inferred`（或显式 `inferred: false`），渲染时不加这行提示；
- 校验规则：`kind="cli"` ⇒ `command` 与 `verifyCommand` **都必填**；`kind="manual"` ⇒ 都不要。
