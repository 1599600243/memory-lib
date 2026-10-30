# napcat-watchdog.ps1 —— 米汐掉线看门狗
#
# 每 5 分钟跑一次（计划任务 napcat-watchdog）：
#   1) 适配器 WS 是否在连（日志里最近 10 分钟有没有"已连接"，或是否在反复"连接断开"）
#   2) NapCat 是否在等扫码登录（容器日志最近 10 分钟出现"请扫描下面的二维码"）
# 有问题就弹 Windows 通知 + 追加 logs\ALERT.log；同一种问题 30 分钟内不重复弹。

$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\MemoryLib'
$adapterLog = Join-Path $root 'logs\napcat-service.log'
$alertLog = Join-Path $root 'logs\ALERT.log'
$stateFile = Join-Path $root 'logs\.watchdog-state.json'
$now = Get-Date

function Write-Alert([string]$reason, [string]$detail) {
  $last = $null
  if (Test-Path $stateFile) {
    try { $st = Get-Content $stateFile -Raw | ConvertFrom-Json; if ($st.reason -eq $reason) { $last = [datetime]$st.at } } catch {}
  }
  if ($last -and ($now - $last).TotalMinutes -lt 30) { return }  # 同一问题 30 分钟内不重复

  $line = "[{0}] {1} | {2}" -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $reason, $detail
  Add-Content -Path $alertLog -Value $line -Encoding utf8

  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Warning
    $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $ni.BalloonTipTitle = '米汐掉线了'
    $ni.BalloonTipText = "$reason`n$detail"
    $ni.Visible = $true
    $ni.ShowBalloonTip(20000)
    Start-Sleep -Seconds 8
    $ni.Dispose()
  } catch { /* 通知失败不影响告警落盘 */ }

  @{ reason = $reason; at = $now.ToString('o') } | ConvertTo-Json | Set-Content $stateFile -Encoding utf8
}

# 1) 扫码登录态：看"最后一次出现的是二维码还是登录成功"
#    （只看 --since 10m 会误报：刚登录成功时，十分钟前那条二维码还在窗口里）
$lines = @(docker logs memorylib-napcat --tail 400 2>&1 | ForEach-Object { [string]$_ })
$lastQr = -1; $lastStart = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '请扫描下面的二维码') { $lastQr = $i }
  if ($lines[$i] -match 'WebSocket Server\] Server Started') { $lastStart = $i }
}
if ($lastQr -gt $lastStart) {
  Write-Alert '需要扫码登录' 'NapCat 最后一次动作是在等二维码扫描，QQ 会话已失效'
  exit 0
}

# 2) 适配器连不上
if (-not (Test-Path $adapterLog)) { Write-Alert '适配器日志缺失' "找不到 $adapterLog"; exit 0 }
$tail = Get-Content $adapterLog -Tail 200
$lastConnect = $tail | Where-Object { $_ -match '已连接 NapCat' } | Select-Object -Last 1
$recentDisconnect = ($tail | Where-Object { $_ -match '连接断开' }).Count

if ($recentDisconnect -ge 6 -and -not $lastConnect) {
  Write-Alert '适配器连不上 NapCat' '日志里连续多次"连接断开"，且没有新的"已连接"'
  exit 0
}

# 3) 进程没了（计划任务会重启，但也要让人知道）
$adapter = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'serve\.mjs' }
if (-not $adapter) { Write-Alert '适配器进程不存在' '计划任务应在 1 分钟内拉起，若持续请检查任务状态' }
