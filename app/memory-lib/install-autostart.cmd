@echo off
rem 安装 memory-lib core 开机自启（当前用户登录时自动启动，无需管理员）
rem 用法：双击运行，或命令行执行 install-autostart.cmd
setlocal
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
schtasks /create /tn "memory-lib-core" /tr "\"%DIR%\autostart.cmd\"" /sc onlogon /rl limited /f
if %errorlevel%==0 (
  echo.
  echo [OK] 已注册开机自启任务：memory-lib-core
  echo      登录后会自动启动记忆库核心服务（127.0.0.1:8787）
  echo      卸载请双击 uninstall-autostart.cmd
) else (
  echo [FAIL] 注册失败，请检查 schtasks 是否可用
)
pause
