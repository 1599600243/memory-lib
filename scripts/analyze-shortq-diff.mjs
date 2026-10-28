// 分析 compare 输出：按批次分类差异，并判断 A 批（两字问句）改后首条是否含关键词
import fs from "node:fs";

const j = JSON.parse(fs.readFileSync("D:\\MemoryLib\\_wt\\cmp-shortq.json", "utf8"));
const key = "全量 → INDEX-2";
const block = j[key];
console.log(`总差异: 首条 ${block.firstChanged} / 序列 ${block.seqChanged}`);
console.log("按批:", JSON.stringify(block.byBatch));

const diffs = block.diffs ?? [];
const byBatch = {};
for (const d of diffs) {
  const b = d.rec?.batch ?? "?";
  byBatch[b] ??= { n: 0, firstChanged: 0, topHasKeyword: 0, samples: [] };
  byBatch[b].n++;
  const baseFirst = d.rec?.full?.ids?.[0] ?? null;
  const newFirst = d.rec?.i2?.ids?.[0] ?? null;
  if (baseFirst !== newFirst) byBatch[b].firstChanged++;
  const kw = d.rec?.keyword ?? "";
  // i2 的 fact 文本不在 compare json 里，只能靠 id；这里统计"首条是否与关键词相关"需要文本，留待 HTTP 复核
  if (byBatch[b].samples.length < 3) byBatch[b].samples.push({ id: d.rec?.id, q: d.rec?.query, base: baseFirst, now: newFirst, kw });
}

for (const [b, v] of Object.entries(byBatch)) {
  console.log(`\n【${b}】差异 ${v.n} 条，其中首条被改变 ${v.firstChanged} 条`);
  for (const s of v.samples) console.log(`   ${s.id} 「${s.q}」\n      基准首条=${String(s.base).slice(0, 24)}\n      新首条  =${String(s.now).slice(0, 24)}`);
}

// 单独看长问句（B 批 + i1 批）是否被动到——这是"冻结集"
const frozen = diffs.filter((d) => ["B-噪声句式", "i1-可数-几层", "i1-按天问", "i1-模糊问"].includes(d.rec?.batch));
console.log(`\n冻结集（长问句 B + i1）差异: ${frozen.length} 条`);
for (const d of frozen.slice(0, 8)) {
  console.log(`   ${d.rec.id} 「${d.rec.query}」`);
  console.log(`      基准: ${JSON.stringify((d.rec.full?.ids ?? []).slice(0, 4))}`);
  console.log(`      新  : ${JSON.stringify((d.rec.i2?.ids ?? []).slice(0, 4))}`);
}
