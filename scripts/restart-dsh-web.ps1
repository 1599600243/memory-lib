# 重启 DSH Web（3080）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restart-dsh-web.ps1
# 作用：停掉当前 dsh web 进程 → 用同样的命令重新拉起 → 等端口恢复 → 写日志
#      即使调用它的终端/会话被一起关掉，本脚本也会跑完（脱离父进程）。

$ErrorActionPreference = 'Continue'
$log = '.\logs\dsh-web-restart.log'
New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line
  Write-Output $line
}

$node = 'node'
$bin  = 'D:\AI\deepseek-harness\node_modules\@deepseek-ai\dsh\lib\bin.js'
$cwd  = 'D:\AI\deepseek-harness'

Say '=== 开始重启 dsh web ==='

# 1) 找到监听 3080 的进程（比按命令行匹配更准）
$owners = @()
try { $owners = (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique } catch {}
if (-not $owners) {
  $owners = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh.+bin\.js"?\s+web' }).ProcessId
}
foreach ($p in $owners) {
  Say "停止 PID $p"
  try { Stop-Process -Id $p -Force -ErrorAction Stop } catch { Say "  停止失败: $($_.Exception.Message)" }
}

# 2) 等端口释放（最多 15 秒）
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  $still = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  if (-not $still) { Say "3080 已释放（等待 $i 秒）"; break }
}

# 3) 拉起
Say "启动: $node $bin web  (cwd=$cwd)"
$proc = Start-Process -FilePath $node -ArgumentList $bin, 'web' -WorkingDirectory $cwd -WindowStyle Hidden -PassThru
Say "新进程 PID $($proc.Id)"

# 4) 等健康（最多 60 秒）
$ok = $false
for ($i = 1; $i -le 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3080/' -TimeoutSec 3 -SkipHttpErrorCheck
    if ($r.StatusCode -ge 200) { Say "3080 已恢复（$i 秒，HTTP $($r.StatusCode)）"; $ok = $true; break }
  } catch { }
}
if (-not $ok) { Say '❌ 3080 在 60 秒内没有恢复，请手动启动（见文件底部命令）' }

Say '=== 结束 ==='
Say ''
Say '手动启动命令（复制到 PowerShell）：'
Say "Start-Process -FilePath '$node' -ArgumentList '$bin','web' -WorkingDirectory '$cwd' -WindowStyle Hidden"
