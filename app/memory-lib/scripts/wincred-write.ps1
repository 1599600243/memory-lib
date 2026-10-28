<#
  wincred-write.ps1 —— 把 secret 写入 Windows 凭据管理器（Generic 类型）
  用法: secret 通过 stdin 输入，再运行 powershell -NoProfile -ExecutionPolicy Bypass -File wincred-write.ps1 -Target <名称>
  说明: secret 不经过命令行参数，也不需要明文临时文件
#>
param(
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$secret = ([Console]::In.ReadToEnd()).Trim()
if (-not $secret) { throw "secret stdin empty" }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CredWriteHelper {
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
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  public static bool Write(string target, byte[] blob) {
    CREDENTIAL cred = new CREDENTIAL();
    cred.Type = 1; // GENERIC
    cred.Persist = 2; // LOCAL_MACHINE (persists across reboots)
    cred.TargetName = Marshal.StringToCoTaskMemUni(target);
    cred.CredentialBlobSize = (uint)blob.Length;
    cred.CredentialBlob = Marshal.AllocCoTaskMem(blob.Length);
    Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);
    cred.UserName = Marshal.StringToCoTaskMemUni("memory-lib");
    bool ok = CredWrite(ref cred, 0);
    Marshal.FreeCoTaskMem(cred.TargetName);
    Marshal.FreeCoTaskMem(cred.CredentialBlob);
    Marshal.FreeCoTaskMem(cred.UserName);
    return ok;
  }
}
"@
$bytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
if ([CredWriteHelper]::Write($Target, $bytes)) {
  Write-Host "WINCRED_WRITE_OK target=$Target"
} else {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "CredWrite failed (Win32 error $err)"
}
