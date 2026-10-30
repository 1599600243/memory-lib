# start-qqbot.ps1 —— 以计划任务方式常驻 QQ 机器人（profile=qqbot）
# 由计划任务 dsh-qqbot 调用；也可手工运行（前台，Ctrl+C 停）。
# 密钥不落盘：每次启动从 qqbot profile 的 cordis.patch.yml 读取，仅放进进程环境变量。

$ErrorActionPreference = 'Stop'

$dshRoot = 'D:\AI\deepseek-harness'
$node = 'F:\ZHONGYAO\nodejs\node.exe'
$bin = Join-Path $dshRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\qqbot\cordis.patch.yml'
$logDir = 'D:\MemoryLib\logs'
$log = Join-Path $logDir 'qqbot-service.log'

if (-not (Test-Path $bin)) { throw "找不到 dsh bin: $bin" }
if (-not (Test-Path $patch)) { throw "找不到 qqbot profile 配置: $patch" }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$m = Select-String -Path $patch -Pattern "X-MCP-Secret:\s*['`"]?([^'`"\r\n]+)" | Select-Object -First 1
if (-not $m) { throw "qqbot profile 里读不到记忆库密钥（X-MCP-Secret）" }
$env:MEMORY_LIB_SECRET = $m.Matches[0].Groups[1].Value.Trim()
# QQ 是短句通道：提炼阈值降到 5 字（否则"记住，我对花生过敏"这类全被当短对话丢掉）
$env:DSH_REFINE_MIN_CHARS = '5'

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 启动 qqbot profile" | Out-File -FilePath $log -Append -Encoding utf8
Set-Location $dshRoot
# 前台运行：进程活着 = 任务活着；输出追加到日志（含二维码/绑定提示）
& $node $bin --profile qqbot *>> $log
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] qqbot 进程退出（exit=$LASTEXITCODE）" | Out-File -FilePath $log -Append -Encoding utf8
