# NapCat 部署（QQ 个人号 → 记忆库 8787）

> 一页纸部署文档。配套文件：`deploy/napcat/docker-compose.yml`、`.env.example`、`start.ps1`、`stop.ps1`、`precheck.ps1`。
> **所有命令都在仓库根目录 `D:\MemoryLib` 执行**（PowerShell 7，即 `pwsh`）。
>
> 全流程只有 3 个动作必须人工（脚本/agent 都不代做）：
> **① 用手机 QQ 扫码登录（🔴 本文件第 3 步）**；② 在 WebUI 里确认 WebSocket 服务器配置；③ 首次私聊测试。
> 本仓库的部署脚本只做「拉起容器」，**不会也不能替你扫码**。

---

## 0. 前置要求

| 项 | 要求 | 检查命令（可复制） |
| --- | --- | --- |
| Docker | Docker Desktop ≥ 20.10（本机实测 29.7.2，Compose v5.5.0） | `docker --version` |
| Compose v2 | `docker compose version` 能输出版本 | `docker compose version` |
| Node | Node 24（跑 `scripts/identity.mjs` 和适配器） | `node --version` |
| 记忆库 | 8787 已在运行（本套件不负责起它） | `Test-NetConnection 127.0.0.1 -Port 8787 -InformationLevel Quiet` |
| QQ 账号 | 一个**可以扫码登录**的个人 QQ（部署机上的 `F:\电脑QQ` 不会被容器使用，容器自带兼容 QQ） | 无 |
| 端口 | 3001 / 3000 / 6099 空闲 | `Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue`（有输出=被占用；3000、6099 同理） |

一键前置检查（不启动任何东西）：

```powershell
pwsh -NoProfile -Command "& { . 'deploy\napcat\precheck.ps1'; Assert-Docker; Assert-ComposeFile; Assert-EnvFile; Assert-PortsFree }"
```

---

## 1. 准备 `.env`（token 不进仓库）

```powershell
Copy-Item deploy\napcat\.env.example deploy\napcat\.env
# 生成一个随机 token，把输出填进 .env 的 NAPCAT_TOKEN=
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
notepad deploy\napcat\.env
```

`.env` 里要确认的三个值（模板见 `deploy/napcat/.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `NAPCAT_UID=1000` / `NAPCAT_GID=1000` | 容器内运行用户，Windows 上保持 1000 |
| `NAPCAT_TOKEN=<随机串>` | OneBot v11 的 access_token，**必须改掉 `change-me`** |
| `NAPCAT_ACCOUNT=`（可空） | 可选快速登录 QQ 号；**不能代替首次人工扫码** |

> 🔒 `.env` 已被 `.gitignore` 忽略；绝对不要 `git add -f deploy/napcat/.env`，也不要把真实 token / QQ 号写进 `.env.example` 或本文档。

---

## 2. 启动容器

```powershell
pwsh -File deploy\napcat\start.ps1
```

脚本会依次检查：docker 存在 → 版本 ≥ 20.10 → compose v2 + 守护进程 → compose 语法（`docker compose config`）→ `.env` 存在（token 仍是 `change-me` 只警告）→ 3001/3000/6099 空闲。任何一项失败都会打印「失败 + 处理」并退出，不会带病启动。

看状态 / 看日志：

```powershell
docker compose -f deploy\napcat\docker-compose.yml ps
docker compose -f deploy\napcat\docker-compose.yml logs --tail 100 napcat
```

---

## 3. 🔴 扫码登录 QQ（必须人工，脚本不碰账号）

> **这一步只能人做。** 没有 QQ 号、没有手机扫码，后面的 WS/身份/适配器全都接不上。
> agent 不得代替扫码，也不得索要你的 QQ 密码 / 扫码授权。

3.1 拿 WebUI token：

```powershell
docker compose -f deploy\napcat\docker-compose.yml logs --tail 200 napcat | Select-String -Pattern 'token|Token|WebUI'
# 备用：WebUI 的 token 落盘在 data 里
Get-Content deploy\napcat\data\webui.json
```

3.2 打开 WebUI（必须在**同一台机器**的浏览器里，因为只绑了 127.0.0.1）：

```powershell
Start-Process http://127.0.0.1:6099/webui
```

3.3 🔴 **人工操作**：用上一步的 token 登录 WebUI → 页面会显示登录二维码 → 用**手机 QQ 扫码**并在手机上确认登录。

3.4 确认登录成功：

```powershell
docker compose -f deploy\napcat\docker-compose.yml logs --tail 50 napcat | Select-String -Pattern '登录|login|online|QQ'
```

看到登录成功 / 已上线（以及一个 10 位左右的 QQ 号）即完成。**记住这个 QQ 号**，后面注册身份要用。
若二维码不显示，见第 7 节「常见错误」第 4 条。

---

## 4. 拿到 WS 地址与 access_token，并开 OneBot v11 WebSocket 服务

NapCat 的 WS 服务端默认没开，需要开一个（适配器是 WS **客户端**，主动连它）：

| 项 | 值 |
| --- | --- |
| WS 地址（给适配器） | `ws://127.0.0.1:3001` |
| access_token | `.env` 里的 `NAPCAT_TOKEN`（三处必须一致：`.env` / NapCat WebUI / `adapters/napcat/config.json`） |
| 监听地址（容器内） | `0.0.0.0`，端口 `3001`（宿主侧只映射到 127.0.0.1） |

4.1 查看 token（复制用）：

```powershell
Select-String -Path deploy\napcat\.env -Pattern '^NAPCAT_TOKEN='
```

4.2 在 WebUI 里配置（人工点几下，无 CLI 等价命令）：
**网络配置 → 新建 → WebSocket 服务器**，填：

- 名称：`memorylib`
- Host：`0.0.0.0`
- Port：`3001`
- Token：与 `.env` 的 `NAPCAT_TOKEN` 完全相同
- 启用：开

WebUI 页面关了可以重开（仍只在本机可用）：

```powershell
Start-Process http://127.0.0.1:6099/webui
```

保存后 NapCat 会把配置写进 `deploy/napcat/data/onebot11_<QQ号>.json`，可用命令确认：

```powershell
Get-ChildItem deploy\napcat\data -Filter 'onebot11_*.json' | Select-Object Name,Length,LastWriteTime
```

4.3 验证 3001 已在监听：

```powershell
Test-NetConnection 127.0.0.1 -Port 3001 -InformationLevel Quiet
```

输出 `True` 即 OK（只验证端口，token 是否正确由第 6 步适配器日志验证）。

---

## 5. 注册身份（QQ 号 → 独立 agent）

```powershell
node scripts\identity.mjs add --channel napcat --uid <你的QQ号> --name 主人 --role owner
node scripts\identity.mjs list
node scripts\identity.mjs resolve --channel napcat --uid <你的QQ号>
```

- `<你的QQ号>` 换成第 3 步登录成功的那个号（只在本机命令里出现，不要写进仓库文件）。
- 注册后每个 QQ 用户会得到一个独立 agent（`qq-<hash>`），记忆按 user 级隔离；**未登记的身份默认拒绝**，不会自动建号。
- 群聊还要满足「@ 或叫名字 + 群在白名单」才会响应。

---

## 6. 启动适配器

6.1 准备适配器本地配置（`config.json` 已被 gitignore，可放 token）：

```powershell
Copy-Item adapters\napcat\config.example.json adapters\napcat\config.json
notepad adapters\napcat\config.json
```

要改的字段（其余保持模板默认）：

| 字段 | 值 |
| --- | --- |
| `napcat.wsUrl` | `ws://127.0.0.1:3001` |
| `napcat.accessToken` | 与 `.env` 的 `NAPCAT_TOKEN` 相同 |
| `bot.selfId` | 可留空（适配器会从连接事件里自动取）；也可填第 3 步的 QQ 号 |
| `memory.baseUrl` | `http://127.0.0.1:8787` |
| `model.keyFile` / `memory.credentialPatch` | 指向本机密钥文件（模板里是 `C:\Users\admin\...`，按实际路径改） |

6.2 启动（前台运行，`Ctrl+C` 停）：

```powershell
node adapters\napcat\index.mjs
```

看到下面两行即连通：

```
[napcat] ... 连接 ws://127.0.0.1:3001
[napcat] ... 已连接 NapCat
```

6.3 验证：用另一个 QQ 私聊第 3 步登录的号，应收到回复；再发「记住：我对花生过敏」之类的话，确认 `capture` 写回（适配器日志无「写回失败」即可）。群聊需 @ 且在 `bot.groupAllow` 白名单里。

---

## 7. 常见错误

### 1) 端口占用

报错特征：`port is already allocated`、`EADDRINUSE`，或 `start.ps1` 直接提示「端口被占用」。

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3001,3000,6099 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
netstat -ano | Select-String ':3001\s'
```

- 占用者是自己上次的 NapCat 容器 → `pwsh -File deploy\napcat\stop.ps1` 后重试。
- 占用者是别的程序（例如别的 QQ 机器人/旧 NapCat）→ 自己确认后停掉它；`start.ps1` 不会替你杀进程。

### 2) token 错（连不上 / 一直重连）

报错特征：适配器日志反复「连接断开，5 秒后重连」「WS 错误」；NapCat 日志出现 401/403。
检查三处是否**完全一致**（区分大小写、无空格）：

```powershell
Select-String -Path deploy\napcat\.env -Pattern '^NAPCAT_TOKEN='
Get-ChildItem deploy\napcat\data -Filter 'onebot11_*.json' | Select-Object Name
Select-String -Path deploy\napcat\data\onebot11_*.json -Pattern 'token'
Select-String -Path adapters\napcat\config.json -Pattern 'accessToken'
```

改完 `.env` 要重启容器（`stop.ps1` → `start.ps1`），改完 `config.json` 要重启适配器。
注意：token 里的特殊字符在 URL 里会被转义，适配器已用 `encodeURIComponent` 处理，不要自己再手转义。

### 3) QQ 版本不兼容

报错特征：容器启动后 NapCat 日志报「当前 QQ 版本不支持 / 请升级 QQ」、或登录阶段直接崩。
原因：NapCat 只支持特定版本的 QQ。**官方 Docker 镜像自带兼容的 QQ，宿主机的 `F:\电脑QQ` 不参与**（不要试图把宿主机 QQ 目录挂进容器替换）。
处理：

```powershell
docker compose -f deploy\napcat\docker-compose.yml logs --tail 200 napcat
# 升级镜像版本：改 docker-compose.yml 里 image 的 tag，然后
pwsh -File deploy\napcat\stop.ps1
pwsh -File deploy\napcat\start.ps1
```

### 4) 二维码不显示

逐项排查：

```powershell
docker compose -f deploy\napcat\docker-compose.yml ps
docker compose -f deploy\napcat\docker-compose.yml logs --tail 100 napcat
Test-NetConnection 127.0.0.1 -Port 6099 -InformationLevel Quiet
```

- 容器没起 → 看 `logs` 里的报错（多为端口占用或镜像拉取失败）。
- 浏览器打不开 `http://127.0.0.1:6099/webui` → 端口只绑了 127.0.0.1，**必须在本机浏览器**打开，不能从别的机器访问。
- 打不开登录页/登录被拒 → 用第 3.1 步的命令重新取 WebUI token。
- 登录了但页面空白 → 刷新页面；仍空白则重启容器：

```powershell
pwsh -File deploy\napcat\stop.ps1
pwsh -File deploy\napcat\start.ps1
```

### 5) 镜像 tag 拉不到（manifest unknown / not found）

```powershell
docker pull mlikiowa/napcat-docker:latest
```

拉成功后把 `docker-compose.yml` 的 `image:` 改成 `mlikiowa/napcat-docker:latest`（或 Docker Hub 上实际存在的 `vX.Y.Z`），再 `start.ps1`。
本仓库默认固定 `v4.18.37` 是为了避免自动升级导致 QQ 版本/协议不兼容。

### 6) QQ 数据目录写不进去（权限/每次重启都要重新扫码）

本仓库按工作单把 QQ 数据挂在 `./qq:/root/.config/QQ`。若容器日志报无法写该目录或登录态不持久，把 `docker-compose.yml` 里那一行改成官方非 root 镜像的路径：

```yaml
      - ./qq:/app/.config/QQ
```

改完 `stop.ps1` → `start.ps1`（改了挂载点，需要重新扫码一次）。

---

## 8. 停止 / 重置

```powershell
# 停止容器（保留 ./data 与 ./qq，下次 start 不用重新扫码）
pwsh -File deploy\napcat\stop.ps1

# ⚠️ 危险：彻底重置（删登录态与 NapCat 配置，必须重新扫码）
# pwsh -File deploy\napcat\stop.ps1
# Remove-Item -Recurse -Force deploy\napcat\data, deploy\napcat\qq
```

## 9. 安全边界（不要改）

- 3001/3000/6099 只绑 `127.0.0.1`；不要改成 `0.0.0.0`，也不要在路由器/防火墙做端口转发。
- `.env`、`deploy/napcat/data/`、`deploy/napcat/qq/` 已在 `.gitignore`；不要 force add。
- token 泄露处理：换 `NAPCAT_TOKEN` 三处（`.env` / WebUI WS 配置 / `config.json`）→ `stop.ps1` → `start.ps1` → 重启适配器。
- 适配器对未登记身份默认拒绝；记忆写 user 级，不写 platform。

自检（有输出=这些路径已被 git 忽略，绝不该入库）：

```powershell
git check-ignore -v deploy\napcat\.env deploy\napcat\data\ deploy\napcat\qq\
```
