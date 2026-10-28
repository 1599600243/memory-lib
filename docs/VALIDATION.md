# 这个项目被怎么验过

> 自用 / 实验性项目。下面是**我实际跑过**的验证，不是"设计上应该成立"。
> 复现方式只依赖本仓库里的文件；没写出来的，就是**没验过**。

## 1. 装得起来（任何人都能复现）

```bash
node scripts/install.mjs --dry-run --secret-store file   # 只预览
node scripts/install.mjs --write   --secret-store file   # 真装
node scripts/doctor.mjs --data-root memory-data          # 十项自检
```

验过的行为（`scripts/deploy1.test.mjs` 9 项 + 手工核对）：

| 项 | 期望 |
|---|---|
| 默认干跑 | 不写文件，只打印"将创建/将修改" |
| 幂等 | 同参数第二次是 `no-op`，不重建凭据、不覆盖数据 |
| 非空目标 | 默认**拒绝**；`--force` 才动手，且先产出 `*.backup-<ts>.json.gz` |
| 自检只读 | `doctor` 前后数据目录哈希不变 |
| 坏一处能定位 | 端口不通 / 凭据缺失 / 时区非法，各自给出**可执行的修复命令** |
| 无向量模型 | 向量车道 `stale` 只算 `WARN`，不算失败；不可达/服务身份错/索引失败才 `FAIL` |
| 退出码 | 有 FAIL ⇒ 1；只有 WARN ⇒ 0（可直接当 CI 门禁） |

## 2. 端到端能跑通

`node scripts/smoke.mjs` 会在临时目录里做完整一轮（CI 也跑这个）：

```
install --write  →  启动服务  →  doctor 10/10 ok (1 warning)  →  写一条  →  用它的唯一标记搜回来
```

- 在 **Windows** 上：通过（本机 Node 24.18、file secret store、`--summary-index none`）；
- 在 **Linux / CI** 上：`.github/workflows/ci.yml` 会在 `ubuntu-latest` 与 `windows-latest` 复跑同一脚本；
  **CI 机器通常没有 Ollama**，所以 `doctor` 第 4 项（健康/向量车道）会单项 FAIL —— smoke 按"已知环境差异"接受它，其余九项必须全过。

## 3. 语义层验过的点

| 主题 | 验过的行为 |
|---|---|
| **双时间轴** | 按"事件日"取一整天，`occurred_at` 那天能查到、`updated_at`（写入那天）查不到；跨时区不硬编码 +8 |
| **按天完整性** | 分页取到 `total_count` 用完，条数必须相等；取不满报 `INCOMPLETE`，不假装完整 |
| **不编** | 问句里没有时间表达 ⇒ **拒绝**（不给范围、不猜）；库里没有 ⇒ 明确说"没有"，不给"可能" |
| **可见性** | `reader` 只到共享层；跨身份/跨组读不到；无身份调用**拒绝**而不是返回空 |
| **写入鉴权** | 自报身份与服务端绑定不一致 ⇒ 403；`platform` 可见性要 admin；越权一律拒绝且**零写入** |
| **写回** | transcript 三格式（`jsonl` / `jsonl-zst` / `json-object`）；按字节偏移幂等，二次跑 0 条；抽不出消息时**不前进偏移**并 WARN |
| **注入** | 整段 ≤600 字符、≤8 条、只整句；他人 private 内容**零出现**；服务不可用时跳过且**不编造**；审计带 `channel=inject` |

## 4. 明确**没**验过的（别当成保证）

- **规模**：最大只在 ~1500 条精选记忆 / ~2000 条原始对话上跑过；万级以上没测；
- **平台**：主要在 Windows 上开发验证；Linux 只有 CI 的 smoke 与语法检查，**没跑全量测试**；
- **并发**：多进程同时写同一数据根没有专门压测；
- **安全**：没有第三方安全审计；没有 fuzz、没有渗透测试；
- **升级路径**：数据格式变更的迁移脚本**没有**（当前版本不承诺向后兼容）；
- **性能**：没有公开的 p95 基线数字。

## 5. 怎么自己验

```bash
node scripts/syntax-check.mjs                 # 所有 .mjs 语法
node scripts/smoke.mjs                        # 端到端（临时目录，不碰你的数据）
cd app/memory-lib && node scripts/run-tests.mjs   # 全量测试（Windows 上验过；Linux 未验）
```

