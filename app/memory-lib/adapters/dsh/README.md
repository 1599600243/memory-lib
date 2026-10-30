# DSH（DeepSeek Harness）自动记忆捕获适配器

DSH 接入 memory-lib 自动捕获的参考实现，含两种形态：

| 形态 | 文件 | 生效条件 | 特点 |
|---|---|---|---|
| **实时插件**（推荐） | `plugin/` | 装入 DSH profile 并重启 DSH | 监听 `ctx.on('session/event')`，turn 结束即提交；失败进重试队列 |
| **轮询兜底** | `poll-capture.mjs` | 定时任务（如每 10 分钟） | 解析 DSH 会话日志 `session.jsonl.zstd`；DSH 未运行或插件未生效时兜底 |

`capture-now.cmd` 是同一轮询适配器的立即触发入口，调用 `poll-capture.mjs`；部署到 `<dshHome>/memory-capture/` 后，部署副本可命名为 `capture.mjs` 以兼容既有隐藏任务入口。

两者**共享水位文件**（`<dshHome>/memory-capture/state.json` 的 `sessions.<id>.maxTurn`），因此不会重复提交；服务端另按 `event_id` 幂等（实测：同一 `event_id` 返回同一 evidence）。

## 立即捕获（agent / 人工触发）

需要「马上入库」时**触发本通道**，不要自己 POST capture：

```bash
# 已安装：<dshHome>/memory-capture/capture-now.cmd（内部调用 poll-capture.mjs）
capture-now.cmd            # 立即捕获一次
capture-now.cmd --dry-run  # 只看会提交什么
```

`event_id` 规则统一为 `<conversation_id>#turn-<N>`（由通道生成，调用方不参与命名）；
服务端按 event_id 幂等，因此重复触发安全。

## 契约依据

- 事件格式与行为规则：`skills/automatic-memory-capture/SKILL.md`
- 端点：`POST /v1/conversations/capture`（见 `docs/protocol.md`）
- 只搬运、不提炼：脱敏原文进 `evidence/conversations`；长期记忆由模型通过 `memory_write` / `POST /v1/write` 直接提交

## 安装（实时插件）

```bash
# 1) 放置插件包
mkdir -p <dshHome>/profiles/web/local-plugins/dsh-memory-capture
cp plugin/index.js plugin/package.json <dshHome>/profiles/web/local-plugins/dsh-memory-capture/
cp -r <dshHome>/profiles/web/local-plugins/dsh-memory-capture <dshHome>/profiles/web/node_modules/dsh-memory-capture

# 2) 声明依赖（防包管理器清理）
#    在 <dshHome>/profiles/web/package.json 的 dependencies 增加：
#    "dsh-memory-capture": "file:./local-plugins/dsh-memory-capture"

# 3) 挂载插件：在 <dshHome>/profiles/web/cordis.patch.yml 追加
#    - insert:
#        - id: memory-capture
#          name: 'dsh-memory-capture'

# 4) 重启 DSH 生效（会短暂中断当前会话）
```

## 安装（轮询兜底）

```bash
node poll-capture.mjs            # 单次运行
node poll-capture.mjs --dry-run  # 只看会提交什么
node poll-capture.mjs --backfill # 首次接入时补录历史 turn（默认只建基线）
# 建议用计划任务每 10 分钟跑一次
```

## 配置（环境变量，缺省回落到 `profiles/web/cordis.patch.yml`）

| 变量 | 用途 | 缺省 |
|---|---|---|
| `DSH_HOME` | DSH 主目录 | `~/.dsh` |
| `MEMORY_LIB_URL` | memory-lib 地址 | `http://127.0.0.1:8787` |
| `MEMORY_LIB_CRED_REF` / `MEMORY_LIB_SECRET` | 凭证 | 读 profile 配置 |
| `MEMORY_LIB_AGENT` | 主体 agent | `pilot-01` |
| `MEMORY_LIB_CAPTURE_ROLE` | 自动捕获专用角色 | `capture-ingest`（具备 capture/write 权限，scope 为 shared + project:*） |
| `MEMORY_LIB_WORKSPACE_MAP` | 轮询器的 profile 目录→workspace JSON 映射 | 回落到 `<dshHome>/memory-capture/workspace-map.json` |

## 行为约束（与 SKILL.md 对齐）

- 只提交**真人消息**（`user/message` 且 `source.kind === "user"`）与**助手正文**（`assistant/message` 的 `type === "text"`），丢弃 reasoning、工具细节与运行时注入上下文；
- 按 turn 聚合为一个事件：`event_id = <sessionId>#turn-<N>`；
- 从 DSH session/profile 的可信目录上下文提取 `workspace`，随事件上报；不得从消息正文或 agent 输出中推断 workspace；
- DSH profile 目录名存在连字符歧义，轮询器不得反向猜路径。配置 `workspace-map.json`，例如：
  ```json
  {
    "--D-AI-WANGDIAN--": "D:/AI/WANGDIAN",
    "--D-AI-deepseek-harness-agentgongz--": "D:/AI/deepseek-harness/agentgongz"
  }
  ```
  未映射目录保持旧 shared 行为并写 warning，保证向后兼容且不误分流。
- 首次接入默认**只建基线不补录历史**（避免大量历史 evidence 回填），需要时用 `--backfill`；
- 提交失败不推进水位、不阻塞对话、不静默丢事件（重试队列 / 下次轮询重试）。

## 状态与日志

```
<dshHome>/memory-capture/
├─ state.json      每个会话的水位（maxTurn）与文件指纹，实时/轮询共用
├─ capture.log     轮询器日志
└─ realtime.log    实时插件日志
```

## 已知边界

- 水位写入是「读-合并-取最大」，两个进程极端并发时可能重复提交一次；服务端 `event_id` 幂等兜底，不会产生重复 evidence；
- 轮询形态依赖 `7z.exe`（zstd 解压）；无 7z 时轮询跳过并记日志，实时插件不受影响；
- DSH 侧 `skills/automatic-memory-capture/SKILL.md` 需与仓库源保持同步（见仓库 `skills/`）。
