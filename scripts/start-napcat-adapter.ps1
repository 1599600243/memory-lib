# start-napcat-adapter.ps1 —— 常驻运行 NapCat 适配器（计划任务 napcat-adapter 调用）
# 也可手工前台运行。日志写到 logs\napcat-service.log。

$ErrorActionPreference = 'Stop'
$root = 'D:\MemoryLib'
$node = 'F:\ZHONGYAO\nodejs\node.exe'
$entry = Join-Path $root 'adapters\napcat\serve.mjs'
$logDir = Join-Path $root 'logs'
$log = Join-Path $logDir 'napcat-service.log'

if (-not (Test-Path $entry)) { throw "找不到适配器入口: $entry" }
if (-not (Test-Path (Join-Path $root 'adapters\napcat\config.json'))) { throw "缺少 adapters\napcat\config.json" }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
 
 # 清掉可能残留的锁：任务被强杀时 node 来不及释放锁，会把新实例挡在门外（2026-10-29 踩过两次）
 $lock = Join-Path $logDir 'napcat-adapter.lock'
 if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 启动 napcat 适配器" | Out-File -FilePath $log -Append -Encoding utf8
Set-Location $root
& $node $entry *>> $log
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 适配器退出（exit=$LASTEXITCODE）" | Out-File -FilePath $log -Append -Encoding utf8


