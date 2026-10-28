// 验 SHORT-Q-1：裸两字问句是否有结果、首条是否含该词、单字是否仍为空
// 用法: node verify-shortq.mjs [src 目录] [data 副本]
import fs from "node:fs";

const SRC = (process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib\\src").replace(/\\/g, "/");
const DATA = process.argv[3] ?? "D:\\MemoryLib\\index1-data\\mem-1445";

const mod = await import(`file:///${SRC}/recall.mjs?v=${Date.now()}`);
const lib = mod.createRecall({ dataRoot: DATA, workspaceRoot: "D:\\MemoryLib\\index1-data" });

const topical = ["验收", "提炼", "注入", "隔离", "排序", "回滚", "日期", "记录", "状态", "基线", "捕获", "检索"];
const single = ["层", "验", "8"];

function textOf(m) {
  return String(m?.text ?? m?.summary ?? m?.content ?? m?.body ?? JSON.stringify(m)).replace(/\s+/g, "");
}

console.log("== 两字主题词（裸词）==");
let hitCount = 0, topHas = 0;
for (const q of topical) {
  const out = await lib.recallBrief({ query: q, format: "prompt", memoryOnly: true, memoryLimitChars: 600 });
  const inc = out?.included ?? [];
  const top = inc[0];
  const has = top ? textOf(top).includes(q) : false;
  if (inc.length > 0) hitCount++;
  if (has) topHas++;
  console.log(`  ${q}  命中=${String(inc.length).padStart(2)}  source=${out?.candidate_source ?? "-"}  首条含词=${has ? "✅" : "❌"}  ${top ? textOf(top).slice(0, 34) : ""}`);
}

console.log("\n== 8层（混合词）==");
{
  const out = await lib.recallBrief({ query: "8层", format: "prompt", memoryOnly: true, memoryLimitChars: 600 });
  const inc = out?.included ?? [];
  const has = inc[0] ? /8\s*层/.test(textOf(inc[0])) : false;
  console.log(`  命中=${inc.length} source=${out?.candidate_source ?? "-"} 首条含8层=${has ? "✅" : "❌"}  ${inc[0] ? textOf(inc[0]).slice(0, 40) : ""}`);
  if (has) topHas++;
  if (inc.length > 0) hitCount++;
}

console.log("\n== 单字（必须为空）==");
let singleNonEmpty = 0;
for (const q of single) {
  const out = await lib.recallBrief({ query: q, format: "prompt", memoryOnly: true, memoryLimitChars: 600 });
  const n = (out?.included ?? []).length;
  if (n > 0) singleNonEmpty++;
  console.log(`  ${q}  命中=${n}  source=${out?.candidate_source ?? "-"}  ${n === 0 ? "✅" : "❌ 应放行不了"}`);
}

console.log(`\n汇总：两字/混合 有结果 ${hitCount}/13，首条含词 ${topHas}/13，单字被放行 ${singleNonEmpty}/3`);
