# 记忆库宠物 桌面壳（Tauri）

> 宠物（记忆管家 + 学习助手）的**原生桌面窗口**。核心逻辑全部在 memory-lib（127.0.0.1:8787），
> 本壳只是把 `/pet` 页面装进一个原生窗口——"用户端是壳，核心在记忆库"。

## 架构

```
记忆库宠物.exe（Tauri 原生窗口）
  └─ 窗口加载 http://127.0.0.1:8787/pet   ← 需要核心服务在运行
        └─ /v1/pet/command → memory-lib（身份/scope/审计/LLM 可插拔）
```

- **依赖**：核心服务必须运行（`node server.mjs` / `start-console.cmd` / 开机自启任务 `memory-lib-core`）
- 本机未运行核心时，窗口显示跳转失败提示（前端 stub 页）

## 前置条件

- Windows 10/11（WebView2 Runtime 已随系统/Edge 安装）
- Node.js ≥ 18
- Rust 工具链（缺失时 `build-desktop.ps1` 自动通过 rustup 安装 stable-msvc）

## 构建

```powershell
cd memory-lib\pet-desktop
.\build-desktop.ps1
```

产物：
- `src-tauri\target\release\记忆库宠物.exe`（免安装单文件）
- `src-tauri\target\release\bundle\nsis\*.exe`（安装包）
- `src-tauri\target\release\bundle\msi\*.msi`

## 运行

```powershell
# 1) 确保核心服务在跑
node ..\server.mjs --secret-store wincred
# 2) 启动桌面宠物
.\src-tauri\target\release\记忆库宠物.exe
```

## 自定义

| 项 | 方式 |
|---|---|
| 宠物页面地址 | 环境变量 `PET_URL`（默认 http://127.0.0.1:8787/pet） |
| 图标 | 替换 `app-icon.png`（1024×1024）后重跑 `build-desktop.ps1`（自动重新生成 icons） |
| 窗口大小/标题 | `src-tauri/src/main.rs`（inner_size / title） |

## 说明

- 同源加载（窗口直接指向服务页面），**无 CORS 问题**，核心安全模型（身份/scope/审计）不变
- UI 打磨（形象/动效/主题）见 `docs/PENDING.md` —— 后续单独设计，桌面化时一并做
- 构建需联网（rustup 下载 + crates.io 拉依赖）；如代理不可用，参考仓库根 README 清理 git 代理
