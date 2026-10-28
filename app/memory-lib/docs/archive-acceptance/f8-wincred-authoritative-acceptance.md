# F8 验收报告 —— wincred 转正（默认权威存储 + 迁移期 file 兜底）

> 工单：`memory-lib-fix-request-20260920.md` §2 F8（P2）："默认只读 wincred；迁移期兼容读 file 并给出提示。"
> 状态：**实现完成 + 实测通过**（本机 Windows Credential Manager 可读，已做端到端实测）。
> 协议不变：`credential_ref` / `secret` / `principal` 与错误码语义**未改动**；本次只决定"服务端从哪个后端读凭证"。

## 一、改了什么

| 面 | 文件 | 行为 |
|---|---|---|
| 凭证解析 | `src/credential-resolver.mjs` | wincred 权威读取；`fileFallback` **仅在显式配置时**生效；兜底与后端故障各给一次提示（`onFallbackNotice` 可注入，默认 stderr），提示只含 `credential_ref` + 文件路径，**不含 secret**；wincred **后端故障**不降级读文件 |
| 服务端配置 | `src/server-config.mjs`（新） | `--secret-store` 默认 `wincred`；`file` 为显式 opt-in；非法值/缺值 → 明确报错 + 退出码 1；`--secret-fallback-file` 只能配 wincred |
| 服务入口 | `server.mjs` | 启动即校验 secret store（先于任何数据根访问）；启动日志打印权威存储与兜底状态；找不到 wincred 读取脚本时明确失败 |
| 注册/轮换 | `src/identity-admin.mjs` | wincred 权威模式通过 stdin 写入且不创建 secret 文件；写失败 → `WincredWriteError`（显式失败）且不更新 `identity.json`；写入器 `wincredWriter` 可注入 |
| 接入脚本 | `scripts/onboard-framework.mjs` | wincred 写失败 = 退出码 1（不更新 `identity.json`、不留半套 secret）；stage-then-commit，`--wincred --no-file` = 只留凭据管理器；不带 `--wincred` 时告警（默认服务端读不到该凭证） |
| 测试 | `test/credential-store.test.mjs`（新）、`test/identity-admin.test.mjs` | 见 §三 |

`{ type: "file", dir }` 仍可作为**可注入 fixture** 使用（现有测试与 TMP fixture 不变），测试不写真实的凭据管理器。

## 二、AC 实测输出（原始命令与输出）

### AC1：file 存储移除后仍能鉴权成功（wincred 独立可用）

在 TMP 环境（TMP registry 副本 + **不存在**的 secrets 目录 = 文件存储已移除）里，用真实 `scripts/wincred-read.ps1` 读生产 target，并走**真实 HTTP 鉴权**：

```text
wincredReadNonEmpty      : true        # 真实凭据管理器读到的 secret 非空（48 字符）
authViaWincredOnly       : { ok: true, fingerprint: "cred_c00edb6aeb53cab6" }
fileStoreRead            : null        # file store 读不到（目录不存在）
fileDirExists            : false       # ← 文件存储确实不可用
httpWincredSecret        : { status: 200, code: "OK" }               # 走 wincred 的唯一来源 → 鉴权通过
httpWrongSecret          : { status: 401, code: "UNAUTHENTICATED" }  # 错 secret → 401（鉴权真的在生效）
prodSecretFileReadable   : true
prodFileEqualsWincred    : true        # 凭据管理器条目与生产 secret 文件同值（值未打印）
```

> 全程只读：未改名/删除生产 secret 文件、未写生产凭据管理器、未重启生产服务。文件存储的不可用由"指向不存在目录 + 无兜底配置"等价模拟。

### AC2：默认 = wincred，file 需显式 opt-in，非法值明确失败

```text
$ node server.mjs --secret-store banana
[memory-lib] unsupported --secret-store value: "banana" (expected: wincred | file; default: wincred; the file store is an explicit opt-in: "--secret-store file")
[exit=1]

$ node server.mjs --secret-store
[memory-lib] missing value for --secret-store (expected: wincred | file; default: wincred)
[exit=1]

$ node server.mjs --secret-store file --secret-fallback-file
[memory-lib] --secret-fallback-file requires --secret-store wincred (got "file"); the file store is already authoritative
[exit=1]
```

三种启动形态的启动日志（TMP 数据根 + `--port 0`）：

```text
# 默认（不带 --secret-store）
[memory-lib] secret store: wincred (Windows Credential Manager)

# 显式 file
[memory-lib] secret store: file (explicit opt-in, dir: …\secrets)

# 迁移期兜底
[memory-lib] secret store: wincred (Windows Credential Manager) + FILE fallback (MIGRATION ONLY, dir: …\secrets)
[memory-lib] ⚠️  migration file fallback ENABLED (dir: …\secrets): a WinCred miss is served from the secret file once per credential_ref, with a one-time notice. Drop --secret-fallback-file once every credential lives in WinCred.
```

### AC3：迁移期兜底"按需 + 一次性提示 + 无 secret 泄漏"

- 未配置兜底：wincred 未命中 → 返回 `null`、**不读文件、不提示**（`UNKNOWN_CREDENTIAL`）。
- 配置兜底：wincred 未命中 → 读文件成功，**每个 `credential_ref` 只提示一次**（同一 ref 第二次读取不再提示，不同 ref 各自提示一次）。
- 提示断言：不含 secret、也不含 secret 的任意 12 字符片段；提示含 `file fallback` / `migration` / 对应 `credential_ref`。
- wincred **后端故障**（脚本缺失/超时）：返回 `null`、**不回落文件**、给出一次提示（含原因，不含 secret）；用文件里的 secret 也**无法通过鉴权**（否则就是被掩盖的双活）。

## 三、测试

```text
$ node test/credential-store.test.mjs
✔ file 存储：{ type: 'file', dir } 仍可注入读取（fixtures 不变）
✔ file 存储：authenticate 走 file store 成功并返回 credential 指纹
✔ 未知 secret store 类型 -> 明确报错（不静默当 file）
✔ wincred 权威：wincred 命中即使用 wincred，即使同名 file 存在
✔ 迁移兜底默认关闭：wincred 未命中 + file 存在 -> null 且无提示
✔ 迁移兜底仅在显式配置时生效，且提示只出现一次（每个 credential_ref）
✔ 兜底提示不含 secret（无泄漏），且指明是迁移兜底
✔ wincred 后端故障不静默兜底（不掩盖双活）：不返回 file secret，且明确提示原因
✔ 实测 wincred 读取助手：不存在的 target 判定为 not-found（不误判成后端故障）
✔ readFlagValue：区分未提供 / 带值 / 缺值 / 后跟另一个参数
✔ 配置解析：默认 wincred，显式 file，非法值清晰报错
✔ CLI 实测：非法 --secret-store 以退出码 1 明确失败（不启动服务、也不退回 file）
ℹ tests 12 / pass 12 / fail 0

$ node test/identity-admin.test.mjs
✔ createFramework：wincred 写成功 -> wincred: true
✔ createFramework：未请求 wincred -> wincred: null 且不调用写入器
✔ createFramework：wincred 写失败 -> 明确报错，registry 不半注册，secret 文件不留残留
✔ rotateCredential：wincred 写失败 -> 明确报错并原样保留旧 secret（不做半套轮换）
ℹ tests 8 / pass 8 / fail 0
```

两个文件都已进 `scripts/run-tests.mjs`（`npm test` 顺序 runner）。

## 四、迁移步骤（运维，详见 `docs/operations.md` §1.1）

1. 确认每个 `credential_ref` 在凭据管理器里有对应 target（用读取脚本校验）：
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\wincred-read.ps1 -Target memory-lib_<ref>`（只输出 secret 本身，勿写进日志）。
2. 迁移期用 `--secret-fallback-file` 启动；观察 stderr 的 `resolved from the FILE fallback (migration mode)` 提示（每条一次）。
3. 把提示里出现的 `credential_ref` 逐个写入凭据管理器（`scripts\wincred-write.ps1 -Target memory-lib_<ref> -SecretFile <文件>`），确认服务端不再产生兜底提示。
4. 删除 `runtime\secrets\*.secret`，并去掉 `--secret-fallback-file`，回到纯 wincred。
5. 轮换凭证用 `POST /v1/admin/credential/rotate` 或 `scripts\onboard-framework.mjs --wincred --no-file`；HTTP 路由按服务端权威存储自动决定写入位置，WinCred 权威模式不落 secret 文件，write 失败会明确报错且不会留下半套。

## 五、未做 / 风险（诚实边界）

1. **未改生产运行形态**：生产服务仍在原进程/原参数下运行；本次没有重启服务、没有改名或删除生产 secret 文件（属于运维动作，见 §四）。因此"file 存储移除后仍能鉴权"是**等价模拟 + 真实 wincred 读取 + 真实 HTTP 鉴权**三者组合验证的，而不是在生产机上真的把文件删了再观察。
2. **未写真实凭据管理器**：`wincred-write.ps1` 的成功/失败路径只在测试里用**注入写入器**验证；对真实 Credential Manager 的写操作会用生产 target，属生产写操作，本次未执行。写入失败路径已覆盖（失败 = 显式报错 + 回滚）。
3. **`--secret-store` 取值大小写敏感**：`FILE` / `file `（带空格）都会明确报错（不做静默 trim / 大小写归一）——这是有意的"不猜"。
4. 迁移兜底开启期间仍是"wincred 权威 + file 可读"，**提示只出现在 stderr**；若运维只看日志文件，需确认 stderr 被采集。
