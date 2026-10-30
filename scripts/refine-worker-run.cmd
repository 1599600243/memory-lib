@echo off
SETLOCAL
REM REFINE-LOOP-1 production entry. Every invocation = a brand new node process (stateless).
REM Progress lives only in D:\MemoryLib\state\refine-state.json.
REM Install as a 5-minute scheduled task (needs an account that may create tasks):
REM   schtasks /Create /TN "MemoryLibRefineWorker" /SC MINUTE /MO 5 /F /TR "D:\MemoryLib\scripts\refine-worker-run.cmd"
REM Check:  schtasks /Query /TN "MemoryLibRefineWorker" /FO LIST
REM Status: node D:\MemoryLib\scripts\refine-worker.mjs --status
SET LOGDIR=D:\MemoryLib\logs
IF NOT EXIST "%LOGDIR%" MKDIR "%LOGDIR%"
ECHO [%DATE% %TIME%] refine-worker start >> "%LOGDIR%\refine-worker.log"
node "D:\MemoryLib\scripts\refine-worker.mjs" --limit 20 >> "%LOGDIR%\refine-worker.log" 2>&1
SET RC=%ERRORLEVEL%
ECHO [%DATE% %TIME%] refine-worker end exit=%RC% >> "%LOGDIR%\refine-worker.log"
ENDLOCAL & EXIT /B %RC%
