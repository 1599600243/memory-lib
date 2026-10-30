@echo off
rem memory-lib core autostart wrapper (no pause; used by Task Scheduler / Startup folder).
rem Reads production credentials from wincred. Exits quietly when the port is already busy.
rem
rem 2026-10-04: code + data MOVED. Code now lives in D:\MemoryLib\app (this file is inside it),
rem   data in D:\MemoryLib\data. I:\OpenClaw\memory-data is kept as a junction pointing at
rem   D:\MemoryLib\data so existing consumers (openclaw.json, clawdbot.json,
rem   Memory-Archive-Daily / snapshot.ps1) keep resolving. New starts use the real D: paths
rem   and must not depend on that junction.
rem
rem 2026-10-04: --consolidation-schedule and --consolidation-interval-minutes were REMOVED.
rem   server.mjs now rejects them (the whole consolidation chain was deleted in D29), so
rem   keeping them here made autostart fail: the service would NOT come back after a reboot.
rem   Do NOT re-add them, nor --episode-mechanical / steward switches.
rem
rem 2026-10-04: args below mirror the command line that was verified running in production.
rem   The old --pet-* / --summary-index <json> args were dropped to match it; re-add the
rem   --pet-* triple only together with a verified pet-console check.
rem
rem 2026-10-16: --calendar-timezone Asia/Shanghai is REQUIRED here.
rem   A bare since/until (a plain YYYY-MM-DD with no explicit timezone) is interpreted in
rem   the DEPLOYMENT default timezone. Without this flag that default is UTC, so a local
rem   day such as 2026-10-07 came back as 146 entries instead of 177 -- the day silently
rem   shifted by 8 hours for every caller that omits timezone, which is exactly what the
rem   MCP memory_search description promises the deployment default will cover.
rem   Asia/Shanghai is the timezone this deployment's users mean when they say "10/10".
rem   Do NOT remove it, and do NOT change the server's unconfigured default instead:
rem   the flag is the documented, per-deployment knob.
rem
rem ASCII-only with CRLF on purpose: cmd.exe cannot read this file as UTF-8 without a
rem BOM, and a non-ASCII revision of this file silently failed to start the service.
cd /d "%~dp0"
node server.mjs --host 127.0.0.1 --port 8787 --data-root "D:\MemoryLib\data\memory" --workspace-root "D:\MemoryLib\data" --registry "D:\MemoryLib\data\runtime\identity.json" --secrets-dir "D:\MemoryLib\data\runtime\secrets" --audit "D:\MemoryLib\data\runtime\audit\access.jsonl" --secret-store wincred --calendar-timezone Asia/Shanghai --summary-index none --capture-agent-id pilot-01 --capture-role-id capture-ingest