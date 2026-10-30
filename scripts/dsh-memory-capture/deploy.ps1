# 插件部署脚本（由**有 ~/.dsh 写权限**的人执行；本会话的沙箱只能写 D:\MemoryLib）
#
#   # 0) 先看它要干什么（只读，不改任何东西）
#   pwsh -File D:\MemoryLib\scripts\dsh-memory-capture\deploy.ps1 -Check
#
#   # 1) 备份 + 装插件 + 启用（这一步会写 C:\Users\admin\.dsh\...）
#   pwsh -File D:\MemoryLib\scripts\dsh-memory-capture\deploy.ps1
#
#   # 2) 出事回滚（逐文件恢复最近一次备份；装之前不存在的文件则删掉）
#   pwsh -File D:\MemoryLib\scripts\dsh-memory-capture\deploy.ps1 -Rollback
#
# 历史：IN-PLUGIN-1 首次安装用它；REFINE-TRIGGER-1 把提炼触发搬进插件后，**同一个脚本**再跑一次即可
#       （幂等：patch 已启用就跳过，文件三份全量覆盖）。
#
# 为什么要把文件同时装到**两个地方**：
#   profiles/web/package.json 里写着  "dsh-memory-capture": "file:./local-plugins/dsh-memory-capture"，
#   但 node_modules/dsh-memory-capture 现在是一个**真实目录**（不是链接），内容还和 local-plugins 那份**不一样**。
#   DSH 加载裸包名走 Node 解析 ⇒ 命中的是 node_modules 那份（8,284B / 168 行）；
#   而 local-plugins 那份（12,414B / 241 行）今天是死代码 —— 但只要有人跑一次 pnpm install，
#   链接会被恢复，加载对象就**换成另一份**。所以两份都写成同一份实现，才能"改哪份都不白改"。
#
# 回滚备份后缀：.bak-<Stamp>-<文件>（本脚本）；兼容旧脚本的 <文件>.bak-inplugin1-<Stamp>

[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome 'profiles\web'
$PatchFile  = Join-Path $ProfileDir 'cordis.patch.yml'

$Targets = @(
  (Join-Path $ProfileDir 'node_modules\dsh-memory-capture'),   # ← 今天真正被加载的那份
  (Join-Path $ProfileDir 'local-plugins\dsh-memory-capture')   # ← package.json 里 file: 依赖指向的那份
)

$StagedDir = $PSScriptRoot
$StagedFiles = @('index.js', 'capture-core.mjs', 'status.mjs')

function Get-Sha256([string]$Path) {
  if (-not (Test-Path $Path)) { return '(missing)' }
  return (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower()
}

function Get-LineCount([string]$Path) {
  if (-not (Test-Path $Path)) { return 0 }
  return (Get-Content $Path | Measure-Object -Line).Lines
}

function Show-State([string]$Label) {
  Write-Host "── $Label ──"
  foreach ($t in $Targets) {
    Write-Host ("  {0}" -f $t)
    foreach ($f in $StagedFiles) {
      $p = Join-Path $t $f
      if (Test-Path $p) {
        $item = Get-Item $p
        Write-Host ("     {0,-18} bytes={1,-7} lines={2,-5} sha256={3}" -f $f, $item.Length, (Get-LineCount $p), (Get-Sha256 $p))
      } else {
        Write-Host ("     {0,-18} (不存在)" -f $f)
      }
    }
  }
  Write-Host ("  patch: {0}" -f $PatchFile)
  if (Test-Path $PatchFile) { Write-Host ("     sha256={0}" -f (Get-Sha256 $PatchFile)) }
}

function Get-LatestBackup([string]$Target, [string]$File) {
  $dir = Split-Path -Parent (Join-Path $Target $File)
  if (-not (Test-Path $dir)) { return $null }
  return Get-ChildItem -Path $dir -Filter ("{0}.bak-*" -f $File) -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Write-RollbackHint([string]$Stamp) {
  Write-Host ""
  Write-Host "回滚（一行，逐文件恢复最近一次备份）:"
  Write-Host ("  pwsh -File `"{0}`" -Rollback" -f $PSCommandPath)
  Write-Host ("  本次备份后缀: .bak-{0}" -f $Stamp)
}

# ------------------------------------------------------------------ 前置检查
Write-Host "════════ 插件部署（IN-PLUGIN-1 捕获 / REFINE-TRIGGER-1 提炼 / IN-PLUGIN-2 注入，同一脚本幂等）════════"
Write-Host ("DSH_HOME   : {0}" -f $DshHome)
Write-Host ("profile    : {0}" -f $ProfileDir)
Write-Host ""

foreach ($f in $StagedFiles) {
  $p = Join-Path $StagedDir $f
  if (-not (Test-Path $p)) { throw "缺暂存文件：$p（部署脚本必须和插件源码放在同一个目录）" }
  Write-Host ("  暂存 {0,-18} bytes={1,-7} lines={2,-5} sha256={3}" -f $f, (Get-Item $p).Length, (Get-LineCount $p), (Get-Sha256 $p))
}
Write-Host ""
Show-State "改前"
Write-Host ""
Write-Host "加载哪一份（结论）："
Write-Host "  DSH 的 profile 引导调 boot() 时**没有**传 bareModuleBaseUrl，因此走 cordis 原生 Include，"
Write-Host "  裸包名 'dsh-memory-capture' 按 profiles/web/ 做 Node 解析 ⇒ 命中 node_modules 那份真实目录。"
Write-Host "  local-plugins 那份是 package.json 里 file: 依赖指向的克隆，当前**不被加载**（但 pnpm install 会换掉）。"
Write-Host "  本脚本因此把同一份实现写进两处。"
Write-Host ""

# ------------------------------------------------------------------ 回滚
if ($Rollback) {
  $restored = 0
  foreach ($t in $Targets) {
    foreach ($f in $StagedFiles) {
      $dest = Join-Path $t $f
      $latest = Get-LatestBackup $t $f
      if ($latest) {
        Copy-Item -LiteralPath $latest.FullName -Destination $dest -Force
        Write-Host ("  [ok] 恢复 {0,-18} ← {1}" -f $f, $latest.Name)
        $restored += 1
      } elseif (Test-Path $dest) {
        # 装之前这个文件根本不存在（首次安装新增的兄弟文件）⇒ 删掉，避免残留半套实现
        Remove-Item -LiteralPath $dest -Force
        Write-Host ("  [ok] 删除 {0,-18}（装之前不存在）" -f $f)
      } else {
        Write-Host ("  [skip] {0,-18} 没有备份且当前不存在" -f $f)
      }
    }
  }
  $patchBak = Get-LatestBackup $ProfileDir 'cordis.patch.yml'
  if ($patchBak) {
    Copy-Item -LiteralPath $patchBak.FullName -Destination $PatchFile -Force
    Write-Host ("  [ok] 恢复 patch ← {0}" -f $patchBak.Name)
  } else {
    Write-Host "  [skip] 没有 patch 备份（本次部署没改 patch）"
  }
  Write-Host ""
  Write-Host ("回滚完成（{0} 个文件）。请重启 DSH 让宿主重新加载。" -f $restored)
  Show-State "回滚后"
  exit 0
}

if ($Check) {
  Write-Host "（-Check：只读检查，未改动任何文件）"
  exit 0
}

# ------------------------------------------------------------------ 备份
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Write-Host ("备份后缀: .bak-{0}" -f $Stamp)
foreach ($t in $Targets) {
  foreach ($f in $StagedFiles) {
    $src = Join-Path $t $f
    if (Test-Path $src) {
      Copy-Item -LiteralPath $src -Destination ("{0}.bak-{1}" -f $src, $Stamp) -Force
      Write-Host ("  [bak] {0}" -f $src)
    } else {
      Write-Host ("  [warn] 目标缺失（属首次安装，回滚时会删掉）: {0}" -f $src)
    }
  }
}
Copy-Item -LiteralPath $PatchFile -Destination ("{0}.bak-{1}" -f $PatchFile, $Stamp) -Force
Write-Host ("  [bak] {0}" -f $PatchFile)
Write-Host ""

# ------------------------------------------------------------------ 装文件（两处都写同一份）
foreach ($t in $Targets) {
  if (-not (Test-Path $t)) { New-Item -ItemType Directory -Path $t -Force | Out-Null }
  foreach ($f in $StagedFiles) {
    Copy-Item -LiteralPath (Join-Path $StagedDir $f) -Destination (Join-Path $t $f) -Force
  }
  Write-Host ("  [ok] 已写入 {0}" -f $t)
}
Write-Host ""

# ------------------------------------------------------------------ 启用 patch
$lines = Get-Content -LiteralPath $PatchFile
$out = New-Object System.Collections.Generic.List[string]
$disabled = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]
  # 把 `- id: memory-capture` 紧跟 `disabled: true` 的那一对注释掉
  if ($line -match '^\s*-\s*id:\s*memory-capture\s*$') {
    $next = if ($i + 1 -lt $lines.Count) { $lines[$i + 1] } else { '' }
    if ($next -match '^\s*disabled:\s*true\s*$') {
      $out.Add(('# IN-PLUGIN-1 {0}: 捕获已搬回智能体侧，这里恢复启用' -f $Stamp))
      $out.Add(('# ' + $line))
      $out.Add(('# ' + $next))
      $i += 1
      $disabled = $true
      continue
    }
  }
  $out.Add($line)
}
if (-not $disabled) {
  Write-Host "  [info] patch 里没有找到 'disabled: true' 的 memory-capture 条目（可能已经启用），未改动 patch"
} else {
  Set-Content -LiteralPath $PatchFile -Value $out -Encoding utf8
  Write-Host "  [ok] patch 已启用 memory-capture"
}
Write-Host ""

# ------------------------------------------------------------------ 收尾
Show-State "改后（应两处 sha256 相同）"
Write-Host ""
Write-Host "下一步（IN-PLUGIN-2 的顺序是**硬要求**，别跳步）："
Write-Host "  1) 让宿主重新加载：DSH 会监听 profiles/web/cordis.patch.yml 并热应用；"
Write-Host "     但**插件模块本身不会被热 import** ⇒ 30 秒内没看到新的加载日志，就**重启 DSH**。"
Write-Host ("  2) 先确认插件真的起来了（应看到 捕获 + 提炼触发 + 注入、inject=on、槽位已挂载）：")
Write-Host ("     Get-Content '{0}\memory-capture\realtime.log' -Tail 6" -f $DshHome)
Write-Host ("  3) 发一轮对话，确认**插件注入**真的发生（这一步没通过之前，绝对不要关代理注入）：")
Write-Host ("     Get-Content '{0}\memory-capture\realtime.log' -Tail 10 | Select-String inject" -f $DshHome)
Write-Host "     期望：inject_ok {`"conversationId`":...,`"injectChars`":5xx,`"includedIds`":[...]}"
Write-Host "     （inject_skipped 的话看 blockedBy：throttle/peer-window = 60 秒窗口被占，等一会儿再发）"
Write-Host ("  4) 一条命令看全貌（含「注入」段：最近注入 / 窗口 / 命中 id / 跳过原因）：")
Write-Host ("     node '{0}\status.mjs'" -f (Join-Path $Targets[0] ''))
Write-Host "  5) **确认插件注入稳定后**，才把代理的注入关掉（重启 8899 时加 --inject=off，"
Write-Host "     或设 CAPTURE_PROXY_INJECT=off）。捕获与提炼的开关不用动。"
Write-Host ""
Write-RollbackHint $Stamp
