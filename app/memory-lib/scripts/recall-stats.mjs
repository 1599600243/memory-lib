// memory-lib — 召回计数 CLI（D4.3）。
// 检索命中不写盘；本命令把 pending 命中合并进 runtime/recall-counts.json。
// 用法：
//   node scripts/recall-stats.mjs --data-root <dir> --record <path1> [<path2> ...]   # 显式记录命中（追加 pending）
//   node scripts/recall-stats.mjs --data-root <dir> --update                         # 合并 pending → counts
import { createRecallStats } from "../src/recall-stats.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataRoot = arg("--data-root", "I:\\OpenClaw\\memory-data\\memory");

try {
  const stats = createRecallStats({ dataRoot });
  if (process.argv.includes("--record")) {
    const idx = process.argv.indexOf("--record");
    const hits = process.argv.slice(idx + 1).filter((a) => !a.startsWith("--"));
    const r = await stats.recordHits(hits);
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
    process.exit(0);
  }
  if (process.argv.includes("--update")) {
    const result = await stats.update();
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    process.exit(0);
  }
  console.error("recall-stats: use --record <path...> or --update");
  process.exit(1);
} catch (error) {
  console.error(`[recall-stats] ${error?.message ?? error}`);
  process.exit(1);
}
