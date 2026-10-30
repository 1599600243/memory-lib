@echo off
rem 卸载 memory-lib core 开机自启任务
cd /d "%~dp0"
schtasks /delete /tn "memory-lib-core" /f
if %errorlevel%==0 (
  echo [OK] 已删除开机自启任务：memory-lib-core
) else (
  echo [INFO] 任务不存在或已删除
)
pause
