# Slice 2 验收报告 —— localhost 适配器（127.0.0.1 + credential_ref + reader/shared + 审计）

日期：2026-08（本会话）
状态：**全部通过（13/13）**

## 验收项对照（roadmap §3 Slice 2）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 只允许 127.0.0.1，禁止 0.0.0.0 | ✅ 构造时拒绝非 loopback host；socket 层二次拦截 | `test/slice2.test.mjs` #1 |
| 2 | 凭证缺失 / 错误 / 未知 ref → 401 | ✅ 三种路径均 401 UNAUTHENTICATED / UNKNOWN_CREDENTIAL | #3 #4 #5 |
| 3 | 已撤销凭证 → 立即失效 | ✅ 改注册表 status=revoked 后下一请求 401 REVOKED，恢复后即 200 | #12 |
| 4 | 伪造 role（reviewer 未绑定 pilot-01）→ 403 | ✅ UNKNOWN_ROLE | #7 |
| 5 | 未知 agent 声明 → 403 | ✅ UNKNOWN_AGENT（身份只由凭证反解） | #8 |
| 6 | 越权 scope → 403 | ✅ FORBIDDEN + detail=SCOPE_DENIED | #9 |
| 7 | shared 搜索结果不越界 | ✅ 命中全部在 curated/shared 内 | #6 |
| 8 | get 不能读私有层 | ✅ agent 条目返回 404（不泄漏存在性） | #10 |
| 9 | 审计完整且不泄密 | ✅ 每请求恰好 1 行（delta 验证）；全日志扫描无 secret | #11 |
| 10 | 全程零写入 | ✅ 数据根前后快照 CLEAN | #13 |
| 11 | credential_ref 不落明文 secret | ✅ identity.json 只有 credential_ref+status；secret 在独立 secret 文件 | runtime/identity.json |

## 安全规格落地确认

- **凭证反解主体**：`frameworkByCredentialRef` 是唯一信任锚；请求里的 framework_id 被忽略（服务器根本不读它）
- **请求字段只作声明**：agent_id/role_id 必须存在于该 framework 注册表，否则 403
- **撤销即时生效**：每次请求实时重读注册表 + secret 文件，无缓存
- **审计白名单**：ts/requestId/channel/framework/agent/role/credentialFingerprint/action/scope/resourceId/allow/denyReason/latencyMs；指纹 = ref 的 sha256 前缀，不含 secret
- **health 弱鉴权最小化**：/v1/health 返回 health 字符串，不含 roots/dataRoot
- **secret 存储 v0**：`runtime/secrets/<ref>.secret` 独立文件（扩展点：wincred），生产需设仅服务账户可读 ACL

## 新增产物

```
memory-lib/src/identity-registry.mjs   注册表加载 + 凭证反解主体 + 角色/action/scope 授权
memory-lib/src/credential-resolver.mjs 凭证解析（secret 文件存储 v0，wincred 扩展点）+ 指纹
memory-lib/src/audit.mjs               追加式 JSONL 审计（字段白名单）
memory-lib/src/localhost-server.mjs    127.0.0.1 HTTP 适配器（health/search/get）
memory-lib/runtime/identity.json       开发注册表（deepseek-harness/pilot-01/reader）
memory-lib/runtime/secrets/*.secret    开发 secret（生产凭证由你另行放置）
memory-lib/test/slice2.test.mjs        13 项适配器测试
```

## 结论

> Slice 2 成立：localhost 适配器只绑回环、凭证反解主体、请求字段只作声明、撤销即时生效、
> 越权/伪造全拒绝、审计完整不泄密、全程零写入。可以进入 Slice 3（pilot-01 八项验收）。

## 待你决定（Slice 3 前）

1. **生产凭证**：开发 secret 只是测试用。生产 pilot-01 的凭证由你生成并放入 secret store（或选 Windows Credential Manager 后端，我来实现 wincred 读取）
2. **注册表位置**：当前用 `memory-lib/runtime/identity.json`（开发）；生产是否放到 `I:\OpenClaw\memory-data\runtime\identity.json`（D2）
3. **审计落点**：当前在临时目录；生产建议 `I:\OpenClaw\memory-data\runtime\audit\`（D4）
