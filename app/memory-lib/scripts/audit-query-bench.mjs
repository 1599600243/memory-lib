import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import { queryAudit } from "../src/admin.mjs";

const auditPath = process.argv[2] ?? "I:\\OpenClaw\\memory-data\\runtime\\audit\\access.jsonl";
const before = v8.getHeapStatistics().used_heap_size;
const started = performance.now();
const events = await queryAudit(auditPath, { limit: 100 });
const elapsedMs = performance.now() - started;
const after = v8.getHeapStatistics().used_heap_size;
console.log(JSON.stringify({ auditPath, events: events.length, elapsed_ms: Number(elapsedMs.toFixed(2)), heap_delta_bytes: after - before, heap_delta_mb: Number(((after - before) / 1024 / 1024).toFixed(2)), truncated: events.truncated === true, scanned_bytes: events.scanned_bytes ?? null }, null, 2));
