<#
  wincred-read.ps1 —— 从 Windows 凭据管理器读取 secret 并输出到 stdout（仅 secret 内容）
  用法: powershell -NoProfile -ExecutionPolicy Bypass -File wincred-read.ps1 -Target <名称>
#>
param(
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CredReadHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type;
    public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
  public static byte[] Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null; // GENERIC, no flags
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] blob = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
      return blob;
    } finally { CredFree(ptr); }
  }
}
"@
$bytes = [CredReadHelper]::Read($Target)
if ($null -eq $bytes) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Host "WINCRED_READ_NOT_FOUND target=$Target err=$err"
  exit 1
}
[System.Text.Encoding]::UTF8.GetString($bytes)
