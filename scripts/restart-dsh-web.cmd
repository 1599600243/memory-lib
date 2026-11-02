@echo off
REM 重启 DSH Web（3080）—— 双击本文件即可
REM 作用：停掉当前 dsh web → 用原命令重新启动 → 等端口恢复 → 写日志
REM 日志：.\logs\dsh-web-restart.log

powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\restart-dsh-web.ps1"
echo.
echo 如果 3080 没恢复，手动启动：
echo Start-Process -FilePath "node" -ArgumentList "D:\AI\deepseek-harness\node_modules\@deepseek-ai\dsh\lib\bin.js","web" -WorkingDirectory "D:\AI\deepseek-harness" -WindowStyle Hidden
pause
