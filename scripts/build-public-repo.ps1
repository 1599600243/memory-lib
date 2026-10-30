# 建公开开源仓库：I:\memory-lib（robocopy 避开 node_modules 里的坏 junction）
$ErrorActionPreference = 'Stop'
$dest = 'I:\memory-lib'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$jobs = @(
  @{ from = 'D:\MemoryLib\app\memory-lib'; to = (Join-Path $dest 'app\memory-lib') },
  @{ from = 'D:\MemoryLib\scripts';        to = (Join-Path $dest 'scripts') },
  @{ from = 'D:\MemoryLib\docs';           to = (Join-Path $dest 'docs') }
)
foreach ($j in $jobs) {
  New-Item -ItemType Directory -Path $j.to -Force | Out-Null
  $args = @($j.from, $j.to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1',
            '/XD', 'node_modules', '.git', 'data', 'logs', 'indexes', 'runtime', 'dist')
  $null = robocopy @args
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败: $($j.from) → $($j.to) (code $LASTEXITCODE)" }
}

# ---- 裁剪 ----
$prune = @(
  'scripts\dsh-control', 'scripts\dsh-memory-capture', 'scripts\adapters',
  'scripts\agent-spec-openclaw.test.mjs', 'scripts\agent-spec-permission.test.mjs',
  'scripts\build-public-repo.ps1'
)
foreach ($p in $prune) {
  $full = Join-Path $dest $p
  if (Test-Path $full) { Remove-Item $full -Recurse -Force; Write-Output "  pruned: $p" }
}
Get-ChildItem (Join-Path $dest 'docs') -File | Where-Object { $_.Name -match 'INCIDENT|CLOSEOUT|BACKLOG' } | ForEach-Object {
  Remove-Item $_.FullName -Force; Write-Output ("  pruned doc: " + $_.Name)
}

# ---- 脱敏 ----
$textExt = @('.md','.mjs','.js','.json','.toml','.yml','.yaml','.cmd','.ps1','.txt','.html')
$rules = @(
  @{ p = 'D:\\MemoryLib\\app\\memory-lib'; r = 'app/memory-lib' },
  @{ p = 'D:\\MemoryLib';                  r = '.' },
  @{ p = 'F:\\ZHONGYAO\\nodejs\\node\.exe'; r = 'node' },
  @{ p = 'C:\\Users\\admin';               r = '~' },
  @{ p = '1599600243/openclaw-memory-portable'; r = 'your-org/your-memory-lib' }
)
$changed = 0
foreach ($f in (Get-ChildItem $dest -Recurse -File | Where-Object { $textExt -contains $_.Extension })) {
  $t = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
  $orig = $t
  foreach ($ru in $rules) { $t = $t -replace $ru.p, $ru.r }
  if ($t -ne $orig) { Set-Content -LiteralPath $f.FullName -Value $t -Encoding UTF8 -NoNewline; $changed++ }
}
Write-Output "  脱敏改写文件数: $changed"

# ---- 复查 ----
$bad = @()
foreach ($f in (Get-ChildItem $dest -Recurse -File | Where-Object { $textExt -contains $_.Extension })) {
  $t = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
  foreach ($k in @('D:\MemoryLib','F:\ZHONGYAO','C:\Users\admin','1599600243')) {
    if ($t -and $t.Contains($k)) { $bad += ($f.FullName.Replace($dest,'') + ' → ' + $k) }
  }
}
if ($bad.Count) { Write-Output "  ⚠️ 仍有本机痕迹:"; $bad | Select-Object -First 10 | ForEach-Object { "    $_" } } else { Write-Output "  ✅ 无本机绝对路径痕迹" }
Write-Output ("  文件数: " + (Get-ChildItem $dest -Recurse -File | Measure-Object).Count + "  体积: " + [Math]::Round((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum/1MB,1) + " MB")
