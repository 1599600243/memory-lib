# 宠物 UI 修复交接（OpenClaw 接手）

## 文件
- 页面源码：`memory-lib/web/pet.html`（单文件，服务端 `GET /pet` 同源伺服，`cache-control: no-store`）
- 服务端路由：`memory-lib/src/localhost-server.mjs`（读文件逐请求返回，改文件后无需重启服务）

## 现象（用户实测 DOM 尺寸）
- `.chat`（id="chat"）尺寸约 **828 × 1084.61**（容器异常高）
- `.msg.pet` 尺寸约 **44 × 40**（气泡异常窄，文字"一个字一行"）

## 已尝试但用户反馈未变
1. `min-height:0`（flex 溢出修复）
2. 简化布局：大宠物+气泡 → 小头像放 header、chat 做主体
3. `width:fit-content` + `overflow-wrap:anywhere`（出现文字超出气泡）
4. **当前版：块级布局** —— `.chat` 去掉 `display:flex`，`.msg { max-width:80%; overflow-wrap:break-word; word-break:break-word; white-space:pre-wrap; }`，`.msg.user{margin-left:auto}` / `.msg.pet{margin-right:auto}`

## 关键结论（已验证）
- 服务端实际返回的 HTML **已是最新版块布局**（含 `margin-left:auto`、无 `align-self:flex-start`、有 `max-width:80%`）
- 因此用户"还是一样"极可能是 **浏览器/WebView2 缓存了旧版页面**——请先让用户 **Ctrl+F5 硬刷新**，或清 WebView2 缓存/重启桌面 exe，再判断是否仍复现

## 若硬刷新后仍复现（真 CSS bug 排查方向）
- `max-width:80%` 未生效 → 检查是否有其他规则覆盖，或 `.msg` 的父级宽度异常
- `.chat` 高度 1084px 异常 → 检查 `html,body{height:100%}` + `body{height:100vh;overflow:hidden}` 链路在 WebView2 是否生效；若 body 高度链断裂，`flex:1` 无处可 flex，chat 会按内容撑高
- 建议：用 DevTools 看 `.msg` 的 computed style（width/max-width），确认 `max-width:80%` 是否真的算出来

## 参考
- 其余待办/设计见 `memory-lib/docs/PENDING.md`
