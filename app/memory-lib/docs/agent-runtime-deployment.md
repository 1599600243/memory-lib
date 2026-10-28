# Agent runtime deployment

The production agent configuration is runtime state, not source-controlled memory data.

```powershell
$source = "D:\AI\deepseek-harness\agentgongz\repo-portable\memory-lib\runtime-agents.example.json"
$target = "I:\OpenClaw\memory-data\memory\runtime\agents\config.json"
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
Copy-Item $source $target
```

The steward template defaults to the locally verified `qwen3:4b` model because steward adjudication requires tool calling. This does not change the DSH model route (`gpt-5.6-sol`).

Locally measured Ollama capabilities (September 2026):

| Model | Tool calling | Schema structured output | JSON mode | Observed single-call time |
| --- | --- | --- | --- | --- |
| `qwen3:4b` | yes | no | yes | 65.7 s |
| `qwen3-vl:4b` | yes | no | yes | 66.3 s |
| `qwen3:latest` | yes | no | yes | 73.4 s |
| `qwen3-vl:8b` | yes | no | yes | 113.1 s |
| `gemma3:4b` | no | no | yes | rejected immediately for tools |
| `deepseek-r1:8b` | no | no | yes | 83.7 s |

Capability metadata is explicit in the steward config. Do not set `toolCalling: true` for a model that Ollama rejects for tools; the text/JSON path remains a compatibility fallback, not the production steward default.

Verify configuration and run once:

```powershell
node scripts/agent.mjs --help
node scripts/agent.mjs --agent steward --once --limit 5
```

The CLI and enabled in-process scheduler fail immediately when the configuration is absent. Set `MEMORY_AGENT_CONFIG` to use a different path.

The in-process scheduler is disabled by default. Enable or disable it by restarting the existing service with or without these flags:

```text
--steward-schedule
--steward-interval-minutes 30
--steward-batch-size 50
--steward-max-failures 3
--agent-config I:\OpenClaw\memory-data\memory\runtime\agents\config.json
```

After the configured consecutive failure threshold, scheduling stops. `/v1/health` exposes `steward.consecutive_failures`, `steward.last_error`, and `steward.stopped`; each attempt also emits one structured JSON log line.
