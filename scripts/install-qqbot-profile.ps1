# install-qqbot-profile.ps1 —— 把记忆库接到 DSH 的 qqbot profile
# 默认只预览；-Write 才落盘。密钥只在写入瞬间注入，不进仓库。
#
# 用法:
#   pwsh -NoProfile -File scripts\install-qqbot-profile.ps1
#   pwsh -NoProfile -File scripts\install-qqbot-profile.ps1 -Write -FromWebProfile
#   pwsh -NoProfile -File scripts\install-qqbot-profile.ps1 -Write -SecretFile D:\secret.txt

[CmdletBinding()]
param(
  [switch]$Write,
  [switch]$FromWebProfile,
  [string]$SecretFile,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$template = Join-Path $repoRoot 'adapters\dsh\qqbot-profile\cordis.patch.template.yml'
$profileDir = Join-Path $DshHome 'profiles\qqbot'
$target = Join-Path $profileDir 'cordis.patch.yml'
$baseProfile = Join-Path $DshHome 'profiles\headless'
$webPatch = Join-Path $DshHome 'profiles\web\cordis.patch.yml'

function Say($m) { Write-Output "  $m" }
function Die($m) { Write-Error $m; exit 1 }

Say "仓库:   $repoRoot"
Say "模板:   $template"
Say "目标:   $target"
Say "模式:   $(if ($Write) { '写入' } else { '干跑（不写任何文件）' })"

if (-not (Test-Path $template)) { Die "找不到模板: $template" }

# ── 1) 取密钥（三种来源，优先 -SecretFile）──────────────────────────────
$secret = $null
if ($SecretFile) {
  if (-not (Test-Path $SecretFile)) { Die "密钥文件不存在: $SecretFile" }
  $secret = (Get-Content $SecretFile -TotalCount 1).Trim()
  if (-not $secret) { Die "密钥文件为空: $SecretFile" }
  Say "密钥来源: 文件 $SecretFile"
} elseif ($FromWebProfile) {
  if (-not (Test-Path $webPatch)) { Die "web profile 不存在: $webPatch" }
  $m = Select-String -Path $webPatch -Pattern "X-MCP-Secret:\s*['`"]?([^'`"\r\n]+)" | Select-Object -First 1
  if ($m) { $secret = $m.Matches[0].Groups[1].Value.Trim() }
  if (-not $secret) { Die "没从 web profile 里读到 X-MCP-Secret" }
  Say "密钥来源: web profile（只读取，不打印）"
} elseif ($env:MEMORY_LIB_SECRET) {
  $secret = $env:MEMORY_LIB_SECRET.Trim()
  Say "密钥来源: 环境变量 MEMORY_LIB_SECRET"
} else {
  Die "没有密钥来源：请用 -FromWebProfile、-SecretFile <路径>，或设置 MEMORY_LIB_SECRET"
}
Say ("密钥长度: " + $secret.Length + " 字符（不显示内容）")

# ── 2) profile 目录与基础文件 ─────────────────────────────────────────
Say ""
Say "[1/3] profile 目录"
if (Test-Path $profileDir) {
  Say "  已存在: $profileDir"
} else {
  Say "  将创建: $profileDir"
}
foreach ($f in @('cordis.yml', 'package.json', 'pnpm-workspace.yaml')) {
  $src = Join-Path $baseProfile $f
  $dst = Join-Path $profileDir $f
  if ((Test-Path $src) -and -not (Test-Path $dst)) {
    Say "  复制基础文件: $f （来自 headless profile）"
    if ($Write) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null; Copy-Item $src $dst -Force }
  } elseif (Test-Path $dst) {
    Say "  基础文件已存在，跳过: $f"
  } else {
    Say "  ⚠️ headless profile 里也没有 $f —— DSH 可能起不来，请手补"
  }
}

# ── 3) 渲染并写入 cordis.patch.yml ────────────────────────────────────
Say ""
Say "[2/3] 渲染 cordis.patch.yml"
$content = Get-Content $template -Raw -Encoding UTF8
if ($content -notmatch '__MEMORY_LIB_SECRET__') { Die "模板里没有 __MEMORY_LIB_SECRET__ 占位符，拒绝继续" }
$rendered = $content.Replace('__MEMORY_LIB_SECRET__', $secret)

$existing = $null
if (Test-Path $target) {
  $existing = Get-Content $target -Raw -Encoding UTF8
  # 只有注释 + 空数组 [] 视为"空 patch"：整体替换，避免追加出非法 YAML
  $stripped = ($existing -split "`n" | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }) -join ''
  if ($stripped.Trim() -eq '[]' -or -not $stripped.Trim()) {
    Say "  目标存在但是空 patch（[]）→ 按新建处理"
    $existing = $null
  }
  Say "  目标已存在: $target"
  if ($existing -match 'id:\s*mcp-memory' -and -not $Force) {
    Say "  已包含我们的记忆块（mcp-memory）→ 本次不改（要重写用 -Force，会先备份）"
    $existing = 'SKIP'
  }
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $bak = "$target.bak-qqbot-$stamp"
  Say "  备份到: $bak"
  if ($Write) { Copy-Item $target $bak -Force }
}

Say "  内容自检:"
$selfCheck = @(
  @{ name = '包含 mcp-memory'; ok = ($rendered -match 'id: mcp-memory') },
  @{ name = '包含 memory-capture'; ok = ($rendered -match 'id: memory-capture') },
  @{ name = '不主动插入 dsh-qqbot（避免与官方安装冲突）'; ok = -not ($rendered -match '(?m)^\s*-\s*id:\s*dsh-qqbot\s*$') },
  @{ name = '读身份是 reader（不是 admin）'; ok = ($rendered -match "X-MCP-Role:\s*'reader'") },
  @{ name = '头里没有 librarian-admin/admin-01'; ok = (-not ($rendered -match "X-MCP-Role:\s*'librarian-admin'")) -and (-not ($rendered -match "X-MCP-Agent:\s*'admin-01'")) },
  @{ name = '占位符已替换'; ok = -not ($rendered -match '__MEMORY_LIB_SECRET__') },
  @{ name = '群聊要求白名单'; ok = ($rendered -match 'groupMode:\s*allowlist') }
)
$bad = 0
foreach ($c in $selfCheck) {
  if ($c.ok) { Say ("   ✅ " + $c.name) } else { Say ("   ❌ " + $c.name); $bad++ }
}
if ($bad -gt 0) { Die "自检未通过（$bad 项），未写入任何文件" }

if ($Write) {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  if ($existing -eq 'SKIP') {
    Say ""
    Say "[3/3] 跳过：目标里已经有我们的记忆块"
  } elseif ($existing) {
    # 追加：保留你（或插件安装）已有的配置，只在末尾加我们的三块
    $merged = $existing.TrimEnd() + "`n`n# === memory-lib 记忆接线（qqbot profile，由 install-qqbot-profile.ps1 追加） ===" + "`n" + $rendered
    Set-Content -Path $target -Value $merged -Encoding UTF8 -NoNewline
    Say ""
    Say "[3/3] 已追加到: $target（原有内容保留）"
  } else {
    Set-Content -Path $target -Value $rendered -Encoding UTF8 -NoNewline
    Say ""
    Say "[3/3] 已写入: $target"
  }
} else {
  Say ""
  Say "[3/3] 干跑：未写入（加 -Write 才落盘）"
}

# ── 4) 下一步 ─────────────────────────────────────────────────────────
Say ""
Say "下一步:"
Say "  1) 按官方流程装好 @tencent-connect/dsh-qqbot（视频流程即可，首启扫码绑定）："
Say "       `$env:QQBOT_APPID='...'; `$env:QQBOT_SECRET='...'"
Say "       npx @deepseek-ai/dsh --profile qqbot"
Say "  2) 按 adapters\dsh\qqbot-profile\README.md 的四步验收（含两号隔离测试）"
Say "  3) 回滚：删掉 $target 或用同目录下的 .bak-qqbot-* 覆盖回去"




