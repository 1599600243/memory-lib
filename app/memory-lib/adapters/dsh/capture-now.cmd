@echo off
rem Trigger one immediate memory capture (agent / human callable).
rem Single-submitter rule: this host has exactly one submitter (this capture
rem channel). To get content indexed right now, call this script instead of
rem building your own capture event or inventing a new event_id.
rem event_id rule (uniform): <conversation_id>#turn-<N>
"node" "%~dp0poll-capture.mjs" %*
