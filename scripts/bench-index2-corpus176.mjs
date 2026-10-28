// 用 176 问语料量 INDEX-2 当前 HEAD 的延迟（in-process，只读副本）
import fs from "node:fs";

const CORPUS = "D:\\MemoryLib\\reports\\INDEX-1-acceptance-corpus-176.jsonl";
const SRC = "D:\\MemoryLib\\app\\memory-lib\\src\\recall.mjs";
const DATA = "D:\\MemoryLib\\index1-data\\mem-1445";
const WORKSPACE = "D:\\MemoryLib\\index1-data";

const rows = fs.readFileSync(CORPUS, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const mod = await import("file:///" + SRC.replace(/\\/g, "/") + "?v=" + Date.now());
const lib = mod.createRecall({ dataRoot: DATA, workspaceRoot: WORKSPACE });

const times = [];
const bySource = {};
const slow = [];
for (const r of rows) {
  const t0 = performance.now();
  const out = await lib.recallBrief({ query: r.query, format: "prompt", memoryOnly: true, memoryLimitChars: 600 });
  const ms = performance.now() - t0;
  times.push(ms);
  const src = out?.candidate_source ?? "-";
  bySource[src] = (bySource[src] ?? 0) + 1;
  if (ms > 200) slow.push({ id: r.id, q: r.query.slice(0, 26), ms: Math.round(ms), src });
}
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1);
console.log(`176 问（in-process，副本 ${DATA}）`);
console.log(`  p50=${p(0.5)}ms  p90=${p(0.9)}ms  p95=${p(0.95)}ms  max=${times[times.length - 1].toFixed(1)}ms  mean=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}ms`);
console.log(`  候选来源: ${JSON.stringify(bySource)}`);
console.log(`  >200ms 的问句: ${slow.length} 条`);
for (const s of slow.slice(0, 8)) console.log(`    ${s.id} ${String(s.ms).padStart(5)}ms ${s.src} 「${s.q}」`);
