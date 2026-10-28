# memory-lib 核心控制台启动脚本 (PowerShell)
# 用法: .\start-console.ps1  （或直接 node server.mjs）
# 启动后浏览器打开 http://127.0.0.1:8787/console
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "[memory-lib] 启动核心服务 127.0.0.1:8787 ..."
Write-Host "[memory-lib] 浏览器打开: http://127.0.0.1:8787/console"
node server.mjs
