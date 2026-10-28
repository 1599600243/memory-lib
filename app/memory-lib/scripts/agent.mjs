#!/usr/bin/env node
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createStewardBatch } from "../src/steward-batch.mjs";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { loadAgentConfig, defaultAgentConfigPath } from "../src/agent-config.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/agent.mjs --agent steward --once [--batch-size N] [--limit N] [--trigger NAME]");
  console.log("       node scripts/agent.mjs --agent steward --schedule [--interval-minutes N]");
  console.log("Environment: MEMORY_DATA_ROOT, MEMORY_WORKSPACE_ROOT, MEMORY_AGENT_CONFIG");
  process.exit(0);
}
const value = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback; };
const agent = value("--agent", "steward");
const once = args.includes("--once");
const requestedLimit = value("--limit", null);
const requestedBatchSize = value("--batch-size", null);
const trigger = value("--trigger", "cli-once");
const intervalMinutes = Number(value("--interval-minutes", "30"));
const dataRoot = process.env.MEMORY_DATA_ROOT ?? "I:/OpenClaw/memory-data/memory";
const workspaceRoot = process.env.MEMORY_WORKSPACE_ROOT ?? path.dirname(dataRoot);
const configPath = process.env.MEMORY_AGENT_CONFIG ?? defaultAgentConfigPath(dataRoot);
const config = await loadAgentConfig(configPath, {}, { required: true });
if (!config[agent]) throw new Error(`agent not configured: ${agent}; expected entry in ${configPath}`);
const memoryFactory = (identity) => createMemoryLib({ dataRoot, workspaceRoot, scopes: identity.scopes ?? null, principal: identity.principal ?? identity });
const runtime = createAgentRuntime({ dataRoot, workspaceRoot, memoryFactory, agents: config });
const stewardConfig = config.steward ?? {};
const batchSize = requestedBatchSize == null ? Number(stewardConfig.batchSize ?? 5) : Number(requestedBatchSize);
if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 500) throw new Error(`invalid --batch-size: ${requestedBatchSize}`);
const limit = requestedLimit == null ? batchSize : Number(requestedLimit);
const batch = createStewardBatch({ dataRoot, memoryFactory, runtime, batchSize, contentChars: Number(stewardConfig.contentChars ?? 300), neighborTopK: Number(stewardConfig.neighborTopK ?? 3) });
if (!once) {
  const timer = setInterval(() => batch.run({ trigger: "scheduled", limit }).catch((error) => console.error(error.message)), Math.max(1, intervalMinutes) * 60_000);
  timer.unref?.();
  console.log(JSON.stringify({ agent, status: "scheduled", interval_minutes: intervalMinutes, threshold: 50 }));
} else {
  console.log(JSON.stringify(await batch.run({ trigger, limit }), null, 2));
}
