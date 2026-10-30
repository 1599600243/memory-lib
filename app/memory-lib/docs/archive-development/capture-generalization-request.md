# memory-lib 自动捕获通用化 —— 优化需求单 v3

- 日期：2026-09-15（v3：DSH 侧参考适配器已落地并入仓；补「单一提交者」原则）
- 提出方：DS 验收侧（用户确认）
- 实现方：OpenClaw / memory-lib 实现侧
- 背景：记忆库已具备自动捕获能力（`/v1/conversations/capture`、transcript 导入、`evidence/conversations` 提炼区、inbox 候选），DSH 侧已实测打通 HTTP 路径。
- 目标：**任何智能体 / 工具 / 宿主接入自动捕获时，只做「一个薄出口」，不重写记忆逻辑、不各自适配一遍。**
- 当前状态：**§二（MCP 工具补齐）与 §四（协议文档补齐）待实现方处理；§三（DSH 宿主侧）已完成，作为参考实现**。

---

## 一、通用接入契约（新增，最高优先）

### 1.1 统一事件格式（唯一入参形状）

```json
{
  "source": "宿主或应用标识",
  "conversation_id": "稳定会话标识",
  "event_id": "稳定事件标识",
  "session_id": "可选运行会话标识",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

**约束**：`source` 全局稳定（宿主名）；`conversation_id` 在同一来源内稳定（一个会话一个 ID，跨轮不变）；`event_id` 在同一 conversation 内唯一（重试时保持不变，用于幂等）。事件不得包含凭证 / secret / token / 密码。

### 1.2 三条等价通道（同一事件三种投递方式，语义必须一致）

| 通道 | 适用方 | 投递方式 | 结果要求 |
|---|---|---|---|
| **MCP 工具** | 任何 MCP 客户端 | 调 `memory_capture_conversation` | 返回 `evidenceId`/`evidencePath`/`candidateCount`，与 HTTP 一致 |
| **HTTP** | 任何能发请求的程序 | `POST /v1/conversations/capture` | 同上（当前已验证可用） |
| **文件目录** | 任何能写文件的工具（脚本/cron/其他系统） | 写入 `transcript-import/`（JSON / JSONL / MD / TXT） | 由导入器按内容哈希去重后进入同一管线 |

**要求**：三通道产生**完全相同的下游效果**（同一 evidence 区、同一提炼、同一 inbox 治理），不得因通道不同而语义分叉。

### 1.3 幂等与去重语义（必须明确并文档化）

1. 同一 `event_id` 重复提交 → 不产生重复 evidence、不产生重复候选；
2. 文件导入按内容哈希去重（现有实现）；
3. 去重结果需可观测（返回中体现 `deduped: true/false` 或等价字段），便于宿主判断投递是否已生效。

### 1.4 协议归属标注原则（防止其他宿主误判可移植）

在 `docs/onboarding.md` 与各 skill/插件说明中，对每个接入方式明确标注：

- **通用**：MCP 工具 / HTTP 端点 / transcript 目录 / `automatic-memory-capture` SKILL.md（纯文本规范）
- **OpenClaw 专属**：`skills/memory-capture/` 的 hook 协议（`metadata.openclaw.events`）

标注要求：专属协议不得作为**唯一**自动化路径；每写一个专属适配器，通用路径清单里至少要有一条等价替代。

### 1.5 最小参考适配器（宿主侧照抄即用，避免重复适配）

**A. 文件方式（任何语言/任何工具，零依赖）**

```js
// capture-bridge.mjs — 把消息写成 memory-lib 可导入的 transcript
import fs from "node:fs";
import path from "node:path";
const ROOT = process.env.MEMORY_LIB_TRANSCRIPT_ROOT ?? "I:\\OpenClaw\\memory-data\\memory\\transcript-import";
export function emit({ source, conversationId, eventId, messages }) {
  fs.mkdirSync(ROOT, { recursive: true });
  const file = path.join(ROOT, `${source}-${conversationId}-${eventId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    source, conversation_id: conversationId, event_id: eventId, messages,
  }, null, 2), "utf8");
  return file;
}
```

**B. HTTP 方式（MCP 补齐前的通用做法；凭证从环境变量读，禁止硬编码）**

```js
export async function capture({ baseUrl, credentialRef, secret, principal, event }) {
  const res = await fetch(`${baseUrl}/v1/conversations/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: credentialRef, secret, principal, ...event }),
  });
  if (!res.ok) throw new Error(`capture failed: HTTP ${res.status}`);
  return res.json(); // { evidenceId, evidencePath, candidateCount, deduped? }
}
```

**状态**：✅ **已入仓** `memory-lib/adapters/`——含 `README.md`（契约权威来源 + 统一约定 + 适配器一致性自检清单）与 `dsh/`（实时插件 + 轮询兜底 + 触发脚本）双形态参考实现。新宿主接入 = 照抄骨架 + 填 `source`/`conversation_id` + 接自己的事件源。
**要求**：`docs/onboarding.md` 指向该目录，作为新宿主唯一照抄入口。

### 1.6 新宿主接入检查清单（最小步骤，写进 onboarding）

1. 选定通道（MCP 优先 → HTTP → 文件目录兜底）；
2. 拿到 `credential_ref` + secret（走现有 onboard 流程），确认角色具备 `propose`（capture 需要）与所需 scope；
3. 复制参考适配器，填入稳定 `source` 与 `conversation_id`；
4. 首次投递一条测试事件 → 校验 evidence 落盘 + 候选进 inbox；
5. 如宿主仅支持「agent 主动调用」，则安装 `automatic-memory-capture` SKILL.md（通用）；
6. 接线失败重试（本地队列 + 退避），**不得阻塞宿主主流程、不得静默丢事件**；
7. 确认事件文件/请求中无凭证。

---

## 二、MCP 工具覆盖缺口（通用性收益最大，优先实现）

**问题**：本轮新增端点全部未进入 MCP 工具集（实测 `mcp/mcp-server.mjs` 无 capture/remember/drafts/persona/memory_list 相关工具）。MCP 客户端（Claude / Cursor / 任何 MCP 宿主）因此用不上自动捕获，只能走 OpenClaw 专属 hook 或自写 HTTP 客户端——与「记忆库是任何框架凭身份访问的独立核心」目标不符。

**要求**：把下列 HTTP 端点补成 MCP 工具（参数 / 返回 / 权限与 HTTP 完全一致，不新造语义）：

| 建议工具名 | 对应端点 | 权限要求 |
|---|---|---|
| `memory_capture_conversation` | `POST /v1/conversations/capture` | `propose` |
| `memory_capture_complete` | `POST /v1/conversations/complete` | `propose` |
| `memory_transcript_import_status` | `POST /v1/transcripts/import/status` | `search`（只读） |
| `memory_transcript_import_scan` | `POST /v1/transcripts/import/scan` | `propose` |
| `memory_list` | `POST /v1/memory/list` | `search`（受 scope 过滤） |
| `pet_remember` | `POST /v1/pet/remember` | `pet` + `propose` |
| `pet_drafts_put` / `pet_drafts_list` / `pet_drafts_clear` | `POST /v1/pet/runtime/drafts/*` | `pet` |
| `pet_persona_get` / `pet_persona_list` / `pet_persona_put` | `POST /v1/pet/runtime/persona/*` | `pet`（put 另需 persona 写权限语义） |

**AC**：
1. MCP 客户端调用 `memory_capture_conversation` → 返回结构与 HTTP 一致（`evidenceId`/`evidencePath`/`candidateCount`）；
2. 无 `propose` 权限角色调用 → 403 `ACTION_DENIED`（不得静默成功）；
3. 工具总数变化后 `mcp.test.mjs` 同步断言（当前 35）；
4. 原文仍落 `evidence/conversations`、候选仍进 `inbox`，**不得绕过治理闸门**。

---

## 三、宿主自动化等价通道（DSH 侧 —— 已完成 ✅，作为其他宿主的参考实现）

**原问题**：唯一「无需 agent 自觉」的自动通道是 OpenClaw 专属 hook，DSH 不认该协议；DSH 曾靠 agent 按 skill 规则主动调 HTTP，存在漏采风险。

**已实现**（`memory-lib/adapters/dsh/`，提交 `0181288` / `2bee0c6` / `3299551` / `42d5a1a`）：

| 形态 | 说明 |
|---|---|
| **实时插件**（Cordis） | 监听 `ctx.on('session/event')`，`turn/end` 时聚合成一个事件提交；失败进重试队列 |
| **轮询兜底** | 解析 `session.jsonl.zstd`，供 DSH 未运行/插件未生效时兜底；定时任务每 10 分钟 |
| **共享水位** | 两形态共用一个 `state.json` 水位，且依赖服务端 `event_id` 幂等，不重复提交 |
| **触发入口** | `capture-now.cmd`：agent/人工需要立即入库时触发通道，**不自行构造事件** |
| **真实缺陷修复** | 曾把「turn 已开、消息未落盘」的空 turn 当完成、推进水位，导致该 turn 永久漏采（实测丢 4 个 turn）；现改为空 turn 不推进水位、留待重试 |

**AC**：
1. 对话产生新消息后无需 agent 显式动作即可见 evidence + inbox 候选 ✅；
2. 失败不阻塞对话、不静默丢事件（重试队列 + 水位不推进）✅；
3. 事件内容不含凭证 ✅；
4. 出口保持「薄」——只搬运，不实现第二套记忆提炼/去重/治理 ✅。

---

## 四、协议一致性缺口（自检发现，防"换智能体又写兼容层"）

1. **事件格式未进 `docs/protocol.md`**：`/v1/conversations/capture` 在 protocol.md 只有一行端点表（第 28 行附近），统一事件字段（`source`/`conversation_id`/`event_id`/`session_id`/`messages`）的权威定义只存在于 `skills/automatic-memory-capture/SKILL.md`。
   **要求**：在 protocol.md 中补一节「自动捕获事件契约」，逐字段给出必填/可选、稳定性要求、幂等语义，并声明 SKILL.md 与本节的权威关系（避免两处漂移）。这样任何新宿主只需读 protocol.md 即可对接，不必猜。
2. **幂等语义需写入文档**：实测服务端已按 `event_id` 幂等（同一 event_id 返回同一 `evidenceId`），但没有文档记录。**要求**：写入 protocol.md，并明确「重放安全」是契约的一部分。
3. **适配器参考实现已入仓**：`memory-lib/adapters/`（含 `README.md` 与 `dsh/` 双形态实现）——作为「新宿主照抄」的唯一入口，避免每个宿主各自发明适配层。**要求**：`docs/onboarding.md` 指向该目录，并在其中补齐「适配器一致性自检清单」的引用。
4. **协议归属标注**：onboarding/各 skill 需标注每条通道是「通用」还是「宿主专属」（见 §1.4），确保专属协议旁总有等价通用路径。
5. **「单一提交者」原则须写进规范**（本次自检发现的重复根因）：同一宿主只允许**一个提交者**（宿主侧自动通道）；agent / 人工需要立即入库时**触发该通道**，不得自行构造 capture 事件或另定 `event_id`。
   - 理由：服务端按 `event_id` 幂等，只有同一提交者 + 同一命名规则才能让重放安全生效；两个提交者各造 event_id → 同一对话产出两批重复候选。
   - `event_id` 命名规则统一为 `<conversation_id>#turn-<N>`（由通道生成，调用方不参与命名）。
   - 参考实现与自检清单见 `memory-lib/adapters/README.md`。
6. **事件需要「工作区 / 项目」维度（协议扩展，用户已确认按此方案推进）**：
   **问题**：capture 事件目前只有 `source`（宿主）+ `conversation_id`（会话），无法表达「这段对话属于哪个工作区 / 项目」。实测 DSH 插件在 profile 级生效、跨工作区共享：`--D-AI-WANGDIAN--`（网点项目）的会话与 `--D-AI-deepseek-harness-agentgongz--`（记忆库项目）的会话进入同一 `source` → **跨项目混库**，服务端提炼时无法区分归属。
   **要求**：
   - 事件新增**可选**字段 `workspace`（工作区标识，建议用工作区目录名或规范化路径）与 `tags`（`string[]`，可选）；
   - 服务端：① 写入 evidence 元数据（可审计、可检索）；② 提炼候选时据此设置 scope 或 tag（如 `project:<workspace>` 或候选 tag），避免跨项目混库；③ 读取端（`/v1/memory/list` 等）支持按 workspace / tag 过滤；
   - **向后兼容**：字段缺失时行为与现状完全一致（不报错、不改变既有语义）；
   - **不得客户端私有扩展**：适配器不得自行添加协议未定义的字段来绕过（那正是「各写一套」的来源）。
   **AC**：带 `workspace` 的事件 → evidence 与候选中可查到该维度；不带该字段的行为不变；按 workspace 过滤可用。
7. **`/v1/health` 必须暴露向量检索可用性（本次验收发现的静默降级）**：
   **问题**：实测生产 `/v1/health` 返回 `healthy`，但本机 Ollama 未运行、embedding 不可用 → **vector lane 实际失效，检索静默降级为 file-first / FTS**，health 完全不反映该降级。后果：向量检索长期失效无人察觉（本次是验收时偶然发现），且会直接影响语义召回质量与 benchmark 分数。
   **要求**：
   - health 检查项新增**向量检索状态**：Ollama endpoint 可达性 + embedding 模型存在性 + `embeddings` 表 active 数量（≥1）；
   - **语义**：向量不可用时整体 health 不得为 `healthy`，应降级为 `reduced`/`degraded`，并在响应中显式给出 lane 状态（如 `lanes: { fts: "ok", vector: "unavailable", reason: "ollama unreachable" }`）；
   - 可选：向量不可用时在 `search` 响应中标注本次实际使用的 lane，便于调用方判断结果质量；
   - 不得因 Ollama 不可达而让 health 返回 5xx（仍需可诊断）。
   **AC**：停止 Ollama → health 不再返回 `healthy` 且明确指出 vector 不可用；启动 Ollama → 恢复 `healthy`。

---

## 五、自动提炼质量缺口（2026-09-19 人工审核 184 条候选发现）

**背景**：对 inbox 184 条自动捕获候选做人工审核，结果 **promote 38 / quarantine 3 / reject 143（78% 无长期价值）**。三个根因必须修，否则 inbox 会持续堆积噪声：

1. **敏感信息未过滤（P0 安全）**：3 条候选含**账号密码明文**（如 `Admin/bossA123`、`接单员和师傅统一使用密码12345678`、密码口诀），已人工 quarantine。
   **要求**：提炼阶段检测凭证类内容（密码/口令/secret/token/API key/账号密码对），命中则**不得生成候选**（或直接落到隔离区并告警），并在提炼日志中记录拦截计数。
2. **去重失效（P1）**：同一任务产生**5 条近乎相同**的候选（如「你是只读调查员…工作目录 D:\AI\WANGDIAN\...」重复 5 次）。
   **要求**：候选入库前做同源去重（内容哈希 / 语义近似 / 同 conversation 内相似度阈值），重复项合并为一条或直接丢弃。
3. **重要度校准失效（P1）**：46 条被标 `critical` 的候选中大量是过程性内容（"Git 仓库已同步至 bc2fa85"、"生产环境运行同步后的代码版本"、"本地工作树状态干净"）。
   **要求**：`importance` 分级需与"长期价值"挂钩（用户偏好/身份/架构决策/长期约束 → 高；一次性操作结果/状态快照/过程叙述 → ordinary），并**不得**把过程性内容标为 critical。

4. **提炼范围过宽（P1，78% 噪声的直接原因）**：大量候选是**对话过程碎片**（提交 hash、SSH key 路径、日志路径、计划任务状态、测试通过、文档节编号、浏览器跳转建议…）。
   **要求**：提炼目标收敛为「长期偏好 / 事实 / 决策 / 目标 / 任务」，明确丢弃"本次操作过程与瞬时状态"；可在提炼 prompt 中给出正反例，并设最小价值门槛（无长期价值则不生成候选）。

**AC**：
- 构造含密码的对话 → **不产生候选**（或仅隔离 + 告警计数）；
- 同一任务重复 5 次的对话 → 候选数 ≤ 1；
- 过程性叙述（"已提交/已同步/已重启/端口/日志路径"）→ 不产生 `critical` 候选，且整体候选产出率显著下降；
- 审核 100 条新候选时，人工 reject 比例 **< 30%**（当前 78%）。

---

## 六、验收方式

1. **MCP**：DSH 用 `memory__memory_capture_conversation` 提交真实事件 → 校验 evidence + 候选；
2. **幂等**：同 `event_id` 提交两次 → 第二次无重复 evidence/候选（并体现 deduped 状态）；
3. **三通道等价**：同一事件分别走 HTTP 与文件目录 → 下游效果一致；
4. **权限**：受限角色调用 → 403；
5. **通用适配器**：按 §1.5 参考实现，10 分钟内接一个新来源（用一个临时脚本模拟第三方工具）成功入库；
6. **回归**：`npm test` 全绿、`production-readonly-check` 为 `SLICE1_PRODUCTION_OK`。

---

## 七、交付物（实现方）

1. MCP 工具补齐 + 测试更新（§二）；
2. `docs/protocol.md` 增补：「自动捕获事件契约」一节（§四-1）+ 幂等语义（§四-2）+ 单一提交者原则（§四-5）；
3. `docs/onboarding.md` 增补：三通道等价说明、协议归属标注、新宿主接入检查清单（§1.6），并指向 `memory-lib/adapters/`；
4. 幂等/去重语义与返回字段说明（§1.3）。

> 参考实现（无需实现方编写，直接引用）：`memory-lib/adapters/`（提交 `0181288` / `2bee0c6` / `3299551` / `42d5a1a`，已 push 到 origin/master）。


