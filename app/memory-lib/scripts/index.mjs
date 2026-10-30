// memory-lib D5.1 — build/update the owned FTS5 + Ollama index.
// Usage: node scripts/index.mjs --data-root <dir> [--rebuild] [--limit N] [--json]
import { createIndexStore } from "../src/index-store.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const dataRoot = arg("--data-root", "I:\\OpenClaw\\memory-data\\memory");
const endpoint = arg("--ollama-endpoint", "http://127.0.0.1:11434");
const model = arg("--ollama-model", "bge-m3");
const dimension = Number(arg("--ollama-dimension", "1024"));
const limit = Number(arg("--limit", "Infinity"));
const rebuild = process.argv.includes("--rebuild");
const json = process.argv.includes("--json");

try {
  const store = createIndexStore({ dataRoot, ollama: { endpoint, model, dimension }, onError: (entry) => {
    if (!json) console.error(`[index] skipped ${entry.path ?? "<file>"}: ${entry.error?.message ?? entry.error}`);
  } });
  const result = await store.index({ rebuild, limit: Number.isFinite(limit) ? limit : Infinity });
  if (json) console.log(JSON.stringify(result));
  else console.log(`scanned=${result.scanned} changed=${result.changed} chunks=${result.chunks} embedded=${result.embedded} skippedSensitive=${result.skippedSensitive} failed=${result.failed} ms=${result.ms}`);
  process.exit(result.failed > 0 ? 2 : 0);
} catch (error) {
  console.error(`[index] ${error?.message ?? error}`);
  process.exit(1);
}
