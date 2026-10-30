# Web 控制台 v1 验收报告

日期：2026-08-22（本会话；F11 更新）
状态：**F11 认证回归通过**

## 交付内容

1. **`web/console.html`**（单文件、零外部依赖、vanilla JS）：
   - 认证面板：显式 `accounts[]` 用户名 + 密码登录（密码框，不落盘），成功后仅在内存保留 Bearer session；主体与权限由账号绑定的 framework/agent/role 返回
   - 五个视图：
     | 视图 | 数据源 | 内容 |
     |---|---|---|
     | 健康 | `/v1/admin/health` | health 状态 + 12 项检查表（名称/状态/路径） |
     | 候选 | `/v1/admin/inbox` + `/v1/admin/inbox/read` | 候选队列表（id/scope/reviewState/proposedBy/importance/时间），点击看详情（完整 frontmatter + body + reviewNotes） |
     | 注册表 | `/v1/admin/registry` | 无密视图：framework/credential 状态/agents/roles（actions+scopes） |
     | 审计 | `/v1/admin/audit` | 最近 200 条：时间/主体/动作/allow-deny/资源/延迟 |
     | 检索 | `/v1/search` | 以当前身份搜索，显示命中数 + 路径/行/摘要 |
   - 连接测试按钮 + 状态灯；错误信息展示 error.code
2. **服务器 `GET /console`（和 `/`）路由**：同源伺服（127.0.0.1），**免 CORS**；页面加载不写审计（无数据），其背后每个 API 调用照常审计

## 验证结果

| 项 | 结果 |
|---|---|
| GET /console | ✅ 200 text/html（12.8KB，含全部五个视图） |
| GET / | ✅ 200 |
| 回归 slice2 / admin / propose | ✅ 13/13、9/9、7/7（服务器加路由后无破坏） |
| 健康 | ✅ healthy |

## 使用方式

```bash
node server.mjs   # 默认 127.0.0.1:8787
# 浏览器打开 http://127.0.0.1:8787/console
# 认证面板：admin@example + 账户密码（管理视图）
#            登录对应的显式账号即可获得其绑定的主体与授权范围
```

## 安全说明

- 仅本机访问（127.0.0.1 强制）；secret 不进 URL/日志/审计/本地存储
- 控制台本身无写操作 UI（review/promote 仍走人工流程）；凭证撤销/激活在注册表视图后续可加按钮（当前走 API/脚本）

## 下一步（可选）

1. 控制台加"撤销/激活凭证"按钮（调 admin/registry/revoke|activate）
2. `server.mjs` 注册 Windows 服务/开机自启
3. MCP adapter（让 Claude/Cursor 等生态接入）
