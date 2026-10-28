# REFINE-LOOP-1 等价定时机制（不需要管理员权限、不需要计划任务服务）
#
# 为什么要有它：本机当前用户 IsAdmin=False，`schtasks /Create` 报
#   "ERROR: The system cannot find the path specified."（连 /Query 也报同样错，Task Scheduler 服务访问被拒）；
#   Register-ScheduledTask -> "拒绝访问"。所以计划任务这条必须由有权限的账户执行，
#   这里给一个等价物：一个纯计时器进程，每 N 秒拉起一次 refine-worker-run.cmd。
#
# 关键性质与计划任务一致：
#   · 每个 tick 都是**全新进程**（cmd -> node 各起一个新 PID），worker 自身无状态
#   · 进度只存在于 .\state\refine-state.json
#   · 重叠由 worker 自己的 .lock 挡住（上一轮没跑完，这一轮直接跳过）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\refine-worker-loop.ps1
#   powershell ... -File ... -IntervalSeconds 60          # 改间隔
#   powershell ... -File ... -WorkerArgs "--limit 1"      # 给 worker 传额外参数（自检用）
# 停止：
#   New-Item -ItemType File .\logs\refine-worker-loop.stop -Force
# 查活：
#   Get-Content .\logs\refine-worker-loop.pid; Get-Content .\logs\refine-worker-loop.log -Tail 10

param(
  [int]$IntervalSeconds = 300,
  [string]$WorkerCmd = ".\scripts\refine-worker-run.cmd",
  [string]$WorkerArgs = ""
)

$logDir = ".\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$pidFile = Join-Path $logDir "refine-worker-loop.pid"
$stopFile = Join-Path $logDir "refine-worker-loop.stop"
$loopLog = Join-Path $logDir "refine-worker-loop.log"

# 上一轮留下的 stop 文件会立刻把新进程停掉，所以启动时先清掉
if (Test-Path $stopFile) { Remove-Item $stopFile -Force }
Set-Content -Path $pidFile -Value $PID -Encoding utf8
Add-Content -Path $loopLog -Value ("[{0}] loop start pid={1} interval={2}s worker={3} args={4}" -f (Get-Date -Format "o"), $PID, $IntervalSeconds, $WorkerCmd, $WorkerArgs)

while (-not (Test-Path $stopFile)) {
  $tickAt = Get-Date -Format "o"
  Add-Content -Path $loopLog -Value ("[{0}] tick start" -f $tickAt)
  if ($WorkerArgs) {
    & cmd /c "`"$WorkerCmd`" $WorkerArgs"
  } else {
    & cmd /c "`"$WorkerCmd`""
  }
  Add-Content -Path $loopLog -Value ("[{0}] tick end exit={1}" -f $tickAt, $LASTEXITCODE)
  # 睡到下一个 tick；用小步长 sleep 以便 stop 文件能被较快感知
  $remain = $IntervalSeconds
  while ($remain -gt 0 -and -not (Test-Path $stopFile)) {
    $step = [Math]::Min(5, $remain)
    Start-Sleep -Seconds $step
    $remain -= $step
  }
}

Add-Content -Path $loopLog -Value ("[{0}] loop stop (stop file seen)" -f (Get-Date -Format "o"))
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
