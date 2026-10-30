# 取 DSH Web 认证 Cookie 并验证 /api（自包含：DPAPI → 解密 → 试调 → 落到用户目录外的凭据文件）
# 用法: pwsh -NoProfile -File get-dsh-cookie.ps1 [-Fresh]   # -Fresh 重新建影子副本
param([switch]$Fresh)
$ErrorActionPreference = 'Continue'
$Tmp = 'C:\Users\admin\AppData\Local\Temp\ck-shadow'
$CookieFile = 'C:\Users\admin\.dsh\memory-capture\.dsh-web-cookie'
$Shadow = '\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1'

function Log($m) { Write-Output $m }

# ── 1) 确保有一份可读的 Cookies 副本（Chrome 独占锁 ⇒ 走影子副本）──
if ($Fresh -or -not (Test-Path (Join-Path $Tmp 'Cookies'))) {
  New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
  $existing = Get-CimInstance Win32_ShadowCopy -ErrorAction SilentlyContinue | Sort-Object InstallDate -Descending | Select-Object -First 1
  if (-not $existing) {
    $r = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{ Volume = 'C:\'; Context = 'ClientAccessible' }
    Log "shadow create ReturnValue=$($r.ReturnValue)"
    $existing = Get-CimInstance Win32_ShadowCopy | Sort-Object InstallDate -Descending | Select-Object -First 1
  }
  if (-not $existing) { Log 'FATAL 无法创建影子副本'; exit 1 }
  $Shadow = $existing.DeviceObject
  Log "shadow: $Shadow"
  $src = "$Shadow\Users\admin\AppData\Local\Google\Chrome\User Data\Default\Network\Cookies"
  Copy-Item -LiteralPath $src -Destination (Join-Path $Tmp 'Cookies') -Force -ErrorAction Stop
  Log "copied cookies: $([Math]::Round((Get-Item (Join-Path $Tmp 'Cookies')).Length/1KB))KB"
}

# ── 2) Local State → DPAPI → AES 键 ──
$ls = "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
$b64 = (Get-Content $ls -Raw | ConvertFrom-Json).os_crypt.encrypted_key
$raw = [Convert]::FromBase64String($b64)
$blob = $raw[5..($raw.Length - 1)]
Add-Type -AssemblyName System.Security
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$env:CHROME_KEY = ($plain | ForEach-Object { $_.ToString('x2') }) -join ''
Log "chrome key: $($env:CHROME_KEY.Length / 2) bytes"

# ── 3) 解出 name=value ──
$pair = & node "$PSScriptRoot\chrome-cookie.mjs" $Tmp '127.0.0.1' --pair 2>&1 | Where-Object { $_ -like 'dsh-auth-*' } | Select-Object -First 1
if (-not $pair) { Log 'FATAL 没解出 dsh-auth cookie'; exit 1 }
$pair = $pair.Trim()
$name = $pair.Substring(0, $pair.IndexOf('='))
Log "cookie name: $name"
Log "cookie value len: $($pair.Length - $name.Length - 1)"
Set-Content -Path $CookieFile -Value $pair -Encoding UTF8 -NoNewline
Log "saved to: $CookieFile"

# ── 4) 试调 /api/session.list ──
$body = '{"type":"client-request","rpcId":"' + [guid]::NewGuid().ToString() + '","method":"session.list","payload":{}}'
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:3080/api/session.list' -Method Post -ContentType 'application/json' -Body $body -Headers @{ 'Cookie' = $pair } -TimeoutSec 15 -ErrorAction Stop
  $j = $r.Content | ConvertFrom-Json
  $items = @($j.result.value.items)
  Log "API OK: HTTP $($r.StatusCode), sessions=$($items.Count)"
  $items | Select-Object -First 8 | ForEach-Object { Log ("  " + $_.id + "  " + $_.title) }
} catch {
  Log "API FAIL: $(if ($_.Exception.Response) { 'HTTP ' + $_.Exception.Response.StatusCode.value__ } else { $_.Exception.Message })"
  exit 1
}
