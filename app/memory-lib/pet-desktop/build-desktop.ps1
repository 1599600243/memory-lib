# 记忆库宠物 桌面壳 一键构建（Windows）
# 前置：Node.js ≥ 18；Rust 若缺失会自动安装（rustup，经 rsproxy 国内镜像）
# 说明：自动配置 cargo 国内镜像 + 绕过本机死代理（127.0.0.1:7890 等），换机器可复现
# 产物：src-tauri/target/release/记忆库宠物.exe（--no-bundle 快速出 exe；去掉该参数可打包 NSIS/MSI）
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

# --- 网络加固：镜像 + 代理绕过（不修改用户全局配置）---
$env:RUSTUP_DIST_SERVER = if ($env:RUSTUP_DIST_SERVER) { $env:RUSTUP_DIST_SERVER } else { 'https://rsproxy.cn' }
$env:RUSTUP_UPDATE_ROOT = if ($env:RUSTUP_UPDATE_ROOT) { $env:RUSTUP_UPDATE_ROOT } else { 'https://rsproxy.cn/rustup' }
$env:no_proxy = '*'; $env:NO_PROXY = '*'
foreach ($p in @('http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','all_proxy')) { $env:$p = '' }
$env:GIT_CONFIG_COUNT = '2'; $env:GIT_CONFIG_KEY_0 = 'http.proxy'; $env:GIT_CONFIG_VALUE_0 = ''
$env:GIT_CONFIG_KEY_1 = 'https.proxy'; $env:GIT_CONFIG_VALUE_1 = ''

# cargo 国内镜像（只写一次）
$cargoCfg = "$env:USERPROFILE\.cargo\config.toml"
if (-not (Test-Path $cargoCfg) -or -not (Select-String -Path $cargoCfg -Pattern 'rsproxy' -Quiet)) {
  New-Item -ItemType Directory -Path "$env:USERPROFILE\.cargo" -Force | Out-Null
  Set-Content $cargoCfg @'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"

[net]
git-fetch-with-cli = true
'@ -Encoding UTF8
  Write-Host "[net] cargo 镜像已写入 $cargoCfg"
}

Write-Host '== [1/4] 检查 Rust 工具链 =='
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host '未检测到 cargo，安装 rustup（stable-msvc，经 rsproxy 镜像）...'
  $rustup = "$env:TEMP\rustup-init.exe"
  if (-not (Test-Path $rustup)) { Invoke-WebRequest -Uri 'https://rsproxy.cn/rustup/rustup-init.exe' -OutFile $rustup -UseBasicParsing }
  & $rustup -y --default-toolchain stable --profile minimal
  $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'rustup 安装后 cargo 仍不可用' }
}
Write-Host "cargo: $(cargo --version)"

Write-Host '== [2/4] 安装 Tauri CLI =='
if (-not (Test-Path 'node_modules\.bin\tauri.cmd')) {
  npm install --no-audit --no-fund
}

Write-Host '== [3/4] 生成图标（从 app-icon.png）=='
if (-not (Test-Path 'src-tauri\icons\icon.ico')) {
  & .\node_modules\.bin\tauri.cmd icon app-icon.png
}

Write-Host '== [4/4] 构建（首次编译需下载约 500 个 crate，可能 10-30 分钟）=='
$noBundle = if ($args -contains '-no-bundle') { '--no-bundle' } else { '' }
& .\node_modules\.bin\tauri.cmd build $noBundle

Write-Host ''
Write-Host '== 构建完成 =='
Get-ChildItem 'src-tauri\target\release\*.exe' -ErrorAction SilentlyContinue | Select-Object Name, Length
Get-ChildItem 'src-tauri\target\release\bundle\nsis\*.exe','src-tauri\target\release\bundle\msi\*.msi' -ErrorAction SilentlyContinue | Select-Object FullName, Length
Write-Host ''
Write-Host '运行：双击 src-tauri\target\release\记忆库宠物.exe（需核心服务在跑：node server.mjs）'
