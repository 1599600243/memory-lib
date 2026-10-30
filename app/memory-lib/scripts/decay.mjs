// memory-lib — 衰减 CLI（D3.2）。
// 语义记忆 updated_at 超过 180 天 → status=stale（不删除，检索默认不给，可用参数取回）。
// D4.3：可选用召回计数——计数 >0 的旧条目不置 stale。
// 用法：node scripts/decay.mjs --data-root <dir>
import { createConsolidator } from "../src/consolidator.mjs";
import { createRecallStats } from "../src/recall-stats.mjs";
import { createMemoryArchiver } from "../src/archive-memory.mjs";
import fs from "node:fs/promises";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataRoot = arg("--data-root", "I:\\OpenClaw\\memory-data\\memory");
const archive = process.argv.includes("--archive");
const updateCounts = process.argv.includes("--update");

try {
  // decay 不需要 LLM，但 createConsolidator 要求 llm；注入一个 no-op。
  const llm = { async chat() { return "[]"; } };
  const consolidator = createConsolidator({ dataRoot, workspaceRoot: dataRoot, llm });
  const stats = createRecallStats({ dataRoot });
  const counts = updateCounts ? await stats.update() : null;
  if (archive && !updateCounts) {
    try { await fs.access(stats.countsPath); } catch { throw new Error("archive requires recall-stats --update first; recall counts are unavailable"); }
  }
  const result = await consolidator.decay({ countFor: stats.countFor });
  const archived = archive ? await createMemoryArchiver({ dataRoot, countFor: stats.countFor, recallCountsPath: stats.countsPath }).archive() : null;
  console.log(JSON.stringify({ ok: true, ...result, ...(counts ? { recallCounts: counts } : {}), ...(archived ? { archived } : {}) }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(`[decay] ${error?.message ?? error}`);
  process.exit(1);
}
