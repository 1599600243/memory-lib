# 决定：开发岗/验收岗改用 gpt-5.6-sol（2026-10-20）

> 裁决人：用户。落地人：产品岗。本文是这次模型选择的唯一依据，改动前后都可对照。

## 一、为什么改

之前 `agent-default-model` 被我设成 `mainpath-proxy / deepseek-flash`，理由是**让所有会话流量穿过 8899 捕获代理**。
该理由已作废：捕获与注入都已搬进 DSH 插件（进程内 hook），与走哪个 provider 无关。

用户口径：**「我那个额度多」**（blackai 的 GPT 额度），开发与验收改用它。

## 二、改哪些、不改哪些

| 对象 | 模型 | 说明 |
|---|---|---|
| 开发岗 8（`session-b3eb6133…`） | → `gpt` / `gpt-5.6-sol` | RANK-1 交付后切 |
| 验收岗 4（`session-564b671c…`） | → `gpt` / `gpt-5.6-sol` | 同上 |
| **产品岗（本会话 `session-dccc44aa…`）** | **保持 DeepSeek 不变** | 用户明示：仍保留 deepseek |
| **`agent-default-model`**（新建会话/子代理） | **保持 `mainpath-proxy / deepseek-flash` 不变** | 不动全局默认 |

## 三、怎么切（不重建会话、保留上下文）

```powershell
# 先看现状（dry-run，不产生改动）
node D:\AI\deepseek-harness\agentgongz\switch-role-model.mjs
# 确认无误后执行
node D:\AI\deepseek-harness\agentgongz\switch-role-model.mjs --apply
```

脚本用 `session.selectModel`（payload：`{sessionId, provider, model}`），先读 `session.models` 校验目标模型在可选列表里，再切，逐条打印前后值。

## 四、切换后必须验证的三件事

1. **模型真的换了**：再跑一次 dry-run，`现在:` 两行都应是 `gpt / gpt-5.6-sol`。
2. **捕获没断**：让开发卡回一句话 → `memory-capture\realtime.log` 出现该会话的 `OK session-… evidence=…`。
3. **注入没断**：同一轮出现 `inject_ok {"conversationId":"session-b3eb6133…"}`。
   （这两条都不依赖 provider，属"确认没被换模型带坏"，不是请求 provider 特性。）

## 五、已知取舍（写下来防止以后惊讶）

- gpt 走 blackai 网关（`https://blackaicoding.com/v1`），**不经过本地 8899**，代理侧流量统计会少掉这部分；但捕获/注入在插件里，功能不受影响。
- gpt 的上下文窗口按配置是 200k（DeepSeek 侧 1M）。两张岗位卡上下文约 300k/210k 字符量级，切模型后若触发压缩，属预期。
- 记忆提炼（refine-worker）继续用 DeepSeek 的 key，与岗位卡模型无关，不受影响。

## 六、回滚

一条命令切回（把 `--model` 换成原模型即可）：

```powershell
node D:\AI\deepseek-harness\agentgongz\switch-role-model.mjs --apply --provider mainpath-proxy --model deepseek-flash
```

（或按会话实际原值：`deepseek-official / deepseek-v4-flash`，以切换前 dry-run 打印的 `现在:` 为准。）
