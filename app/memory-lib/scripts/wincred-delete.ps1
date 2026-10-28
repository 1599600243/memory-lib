<#
  wincred-delete.ps1 —— 从 Windows 凭据管理器删除某 target（轮换/清理用）
  用法: powershell -NoProfile -ExecutionPolicy Bypass -File wincred-delete.ps1 -Target <名称>
#>
param(
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CredDeleteHelper {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
if ([CredDeleteHelper]::CredDelete($Target, 1, 0)) {
  Write-Host "WINCRED_DELETE_OK target=$Target"
} else {
  Write-Host "WINCRED_DELETE_NOT_FOUND target=$Target (可能不存在)"
}
