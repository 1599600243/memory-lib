@echo off
rem memory-lib 核心控制台一键启动 (双击运行)
rem 启动后浏览器打开 http://127.0.0.1:8787/console
cd /d "%~dp0"
echo [memory-lib] 启动核心服务 127.0.0.1:8787 ...
node server.mjs
echo.
echo 服务已停止。按任意键退出...
pause >nul
