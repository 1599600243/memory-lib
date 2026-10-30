# PENDING —— 待办/搁置清单（后续单独设计）

> 记录时间：2026-08-23。条目按状态分组，供后续单独设计时取用。
> 架构基线更新（2026-09-01）：memory-lib 是完全独立系统；正式客户端入口为 HTTP、MCP、Web。Desktop-pet 与 Web pet 都是独立客户端，不属于任何智能体或宿主系统。
> 进度更新（2026-08-24）：受信 review/promote/deprecate 端点 ✅ 已完成（steward 角色 + 生产验证）；pet-desktop Tauri 壳 ✅ 已完成（Rust 1.98 装好、rsproxy 镜像、exe 5.4MB 构建并试启动通过）。
> 历史验收记录（2026-08-24）：曾验证一个外部 MCP 客户端通过 streamable-http 接入 `/mcp`；该记录不构成 memory-lib 对任何宿主或客户端的架构依赖。

## 已完成（宠物路线图）

1. learning 协议端点（plan/progress/间隔重复/profile）✅
2. 宠物交互服务（斜杠命令 + 多模式 + LLM 可插拔）✅
3. 联网纠偏技能（/research + /fetch + web provider）✅
4. 宠物壳 MVP（/pet 网页）✅
5. 受信 review/promote/deprecate 端点（独立治理角色，审核闭环由 memory-lib 自己负责）✅
6. pet-desktop Tauri 壳 ✅（Rust 1.98 + rsproxy 镜像，exe 5.4MB 构建并试启动通过）

## 搁置 · 待单独设计（用户明确要求放后面）

### 1. 控制台审核工作台前端（后端端点已就绪）
- 前端：控制台候选视图加"通过 / 拒绝 / 隔离"按钮（steward/admin 登录可用）
- 后端 `review / promote / deprecate` 端点已完成（见“已完成”第 5 条）；只差前端交互按钮

### 2. 统一协议与客户端体系
- HTTP、MCP（stdio / streamable-http）和 Web（`/console`、`/pet`）是 memory-lib 的正式接入面。
- SDK 是开发者调用接口；不改变 HTTP/MCP/Web 的产品入口定位。
- Desktop-pet 通过独立 HTTP 客户端协议访问 memory-lib；不得继承其他系统的会话、身份或运行依赖。
- Web pet 统一为 memory-lib 官方 Web 客户端，与 Desktop-pet 共用 pet contract、模式、权限、记忆过滤、学习和管家语义；只保留 Web 与桌面表现差异。

## 已确认产品路线（2026-09-01）：独立 Desktop-pet + memory-lib

- **产品形态**：把 Steward（记忆管家）与 Learning（学习助手）做成**桌面宠物**应用——可见的宠物形象 + 对话陪伴 + 记忆治理 + 学习闭环
- **架构**：Desktop-pet 是独立桌面客户端；核心能力、身份权限、审计、学习和长期记忆均由 memory-lib 提供
- **模型**：memory-lib 统一配置本地模型与远程模型，按优先级自动 fallback；Desktop-pet 不绕过 memory-lib 直接调用模型作为正式主路径
- **权限**：陪伴、普通、管家、学习、治理模式绑定不同 role/scope/action；治理模式允许 promote/deprecate，但必须显式开启、逐项确认并审计
- **记忆**：默认读取 credential 授权的全部范围；Desktop-pet 可配置自己的 denylist，由 memory-lib 服务端强制执行
- **成长**：本地保存短期会话和表现状态；memory-lib 保存长期记忆、共同经历、学习进展和角色成长事实
- **角色**：共享共同经历、偏好、目标和学习进展；各角色保留私有人格记忆
- **Web pet**：保留并统一为无 Live2D 的 Web 客户端，不另建一套宠物后端或人格体系

### 宠物设计参考（2026-08-23 用户调研，融入宠物/记忆库）
- **DeepTutor（HKUDS，12.7k★）**：Personal TutorBot（独立记忆/性格/技能/进化）+ 多模式工作区（聊天/解题/测验/研究/可视化）+ MCP 服务——验证"role+记忆库+MCP"方向；借多模式交互与 TutorBot 人格概念（对应我们的 role 体系）
- **learn-anything（d-wwei）**：学习地图（模块权重/难度/依赖）、三段式教学（概念→反模式→实践）、水平校准（自评+小测）、7 种简化策略、概念解剖、错误 3 步诊断、进度持久化、间隔重复（艾宾浩斯 4 轮）、成就系统——**方法论直接作为 learning 协议端点的设计规格**
- **learn-anything（ChenChenyaqi）**：斜杠命令（/learn:topic 等 6 命令）+ 知识地图热力图 Web 面板——借命令式交互与可视化
- **AutoSearch（MCP 原生联网研究）**：作为宠物"技能"，联网获取最新知识/纠偏——"薄壳+协议"契合
- **三层纠偏（回应"怕走弯"）**：① 确定性方法论（校准/诊断/间隔重复，不依赖模型强度）② 联网搜索纠偏（AutoSearch/MCP）③ 用户确认制（已定案）——本地模型可安全使用
- **落位**：learning 端点按 learn-anything 数据结构设计（learning_map/module/calibration/diagnosis/spaced_repetition/progress/achievement）；宠物交互借斜杠命令+多模式；联网搜索作技能；不照搬任何项目代码（架构不同，只借方法论与交互模式）
- **LLM 可插拔，客户端可选**：默认本地 Ollama；可选云端 OpenAI 兼容 API；一个配置/下拉切换
- **资源策略**：空闲不调用 LLM ≈ 不吃配置（Ollama 模型按需加载，空闲自动卸载）；聊天时临时占用
- **防带偏机制**：学习计划/目标/里程碑**用户确认制**（宠物只起草）；进度/复盘进记忆库可视化、可回滚
- 学习系统数据（计划/进度/画像）在记忆库，与模型选型无关，切换模型零迁移

### 宠物 UI 优化（统一 Web pet / Desktop-pet 体系）
- 现状：/pet 与 /console 为功能性单文件页面（可用但视觉粗糙）
- 方向（后续单独设计）：更精致的宠物形象（真实角色设计/动效）、对话体验（流式输出、markdown 渲染、语音可选）、布局/主题打磨、Tauri 桌面化时一并做
- 暂缓：不影响功能使用

### 3. 已确认、待实现的独立宠物能力
- [ ] memory-lib 模型配置：本地/远程 provider、优先级、失败分类、模式级 fallback 策略
- [ ] Desktop-pet 模式权限：模式切换、临时治理授权、逐项确认和审计
- [ ] Desktop-pet 读取限制：layer/visibility/project/topic/tag/item denylist，服务端强制过滤
- [ ] 短期/长期记忆分层：Desktop-pet 本地短期上下文，memory-lib 长期记忆候选和治理
- [ ] 共享记忆与角色私有记忆：shared / pet / character scope 及检索优先级
- [ ] Web pet 统一：复用正式 pet contract、模式和权限，不维护独立逻辑分支

## 其他待办（自主可做/条件待定）

| 项 | 状态/条件 |
|---|---|
| **P0 写入即检索（benchmark 验收）** | ✅ 当前规模下已修复并验证：hybrid 后对授权 roots 做确定性词面补差，新 promote 的唯一标记立即可见；精确 `id` 直接从文件真相定位并排第一；promote/deprecate 后增量刷新自有图谱。边界：普通词面补差默认最多扫描 600 个文件，且不写插件拥有的 FTS/vector ledger，因此不是任意规模下的 ledger 强一致性。 |
| **检索校准** | ✅ `npm run calibrate:retrieval -- <dataRoot> <workspaceRoot>` 提供只读固定评测：随机/ID 型精确查询无实体时禁止纯向量噪声；已知 ID 和完整正文必须命中正确 Top1；自然语言允许纯向量召回并单独报告观察结果，不把固定余弦阈值描述成语义正确性保证。 |
| **project 通配授权** | ✅ `project:*` 仅匹配同 layer/visibility 下的具体 project；不跨越 shared/agent/knowledge 边界；隔离 propose 回归已覆盖。 |
| **P1 deprecate 覆盖 project-state** | ✅ 已修复：按授权 roots 查找，不再硬编码 curated/；默认检索在 ledger、file-first、graph 三条路径最终按文件真相排除 `status: deprecated` |
| **测试隔离** | ✅ 所有认证测试使用独立 TMP registry 和运行时生成的 fixture 凭证；`npm test` 使用顺序 runner（规避 node --test spawn EPERM 与 Node 24 展开问题），在不携带运行凭证的 portable 仓库中 11 文件全绿 |
| **临时产物清理** | ✅ 已删 `_dsh_bench`（22MB）、`_dsh_audit`（14MB）、`scripts/_dsh_*`（报告已固化于 memory-lib-benchmark-report.md） |
| MCP streamable-http 传输 | ✅ `/mcp` 支持 POST 请求/响应，GET→405 关闭 SSE 探测；远程仍需 TLS/反代 |
| python SDK（协议配套） | ✅ 已完成（`sdk/memory_client.py` 零依赖，覆盖全协议，smoke test 通过） |
| 远程客户端接入 | 待用户定网络方案（Tailscale / TLS 反代 / 远程模式） |
| graph 图谱产边流程 | ✅ P1+P2+P3 已实现并**生产启用**（已建图 522 节点/508 边；search 默认附带图谱相关条目；控制台图谱视图）；隔离测试 11/11 |
| wincred 转正（停用 file 存储） | ✅ **F8 已完成**：服务端默认 `--secret-store wincred`（唯一权威读取路径），`--secret-store file` 为显式 opt-in，迁移期用 `--secret-fallback-file` 按需读文件并给出一次性提示（不含 secret）；wincred 写失败显式报错（不再静默双活）。残留动作属运维：删 `runtime\secrets\*.secret` 后去掉 `--secret-fallback-file`。见 `docs/f8-wincred-authoritative-acceptance.md` |
| 新框架接入（电商等） | 注册即用，未做 |

| 清理 git 全局死代理（127.0.0.1:7890） | ✅ 已清（http/https proxy unset + insteadof 移除，push 直连成功） |

| MCP 客户端实测（Claude/Cursor） | 待安装客户端 |

## F11 未实现 backlog 与 WAL 说明（2026-09-19 返工补充）

- **首登强制改密**：未实现。`/v1/auth/password` 是可选自助改密，非强制 post-provisioning 流程。
- **TOTP / MFA 二次认证**：未实现，也未预留协议接口位（backlog 原话「接口留位」暂不落地）。
- **wincred 读取缓存**：`--wincred-cache-ms`（默认 1000ms）只缓存成功的机器请求凭证读取；账号密码记录永不缓存；未命中/错误不缓存；进程内写路径立即失效，进程外轮换最长 1 秒陈旧（`0` 关闭缓存恢复严格每次重读）。见 `docs/operations.md` §1.1、`docs/auth-f11.md`。
- **WAL 只读副作用**：SQLite WAL ledger 只读打开会刷新 `-shm`/`-wal` 侧车；zero-write 校验用 `diffSnapshots(..., { allowWal: true })` 显式豁免侧车，主 `.sqlite` 字节恒等仍强制。见 `docs/operations.md` §2 健康检查。

## 说明

- 当前系统功能已全部在线（hybrid 检索含向量 / wincred / 控制台 / MCP / 协议规范 + SDK），本清单不影响使用
- 以上条目按需取用，设计时参照 `docs/protocol.md` 与各验收报告
