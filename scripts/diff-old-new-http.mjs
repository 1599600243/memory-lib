// 对比 8787（旧代码 504277a）与 8797（新代码）在同一批问句上的 included 数量
// 目的：找出"原本有结果、现在变空"的回归
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const rows = fs.readFileSync("D:\\MemoryLib\\reports\\INDEX-1-acceptance-corpus-176.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function brief(port, q) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/recall/brief`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "pilot-01", role_id: "reader" }, format: "prompt", query: q, memory_only: true, memory_limit_chars: 600 }),
  });
  const j = await r.json().catch(() => ({}));
  const inc = j.included ?? [];
  const first = inc[0];
  const fact = String(first?.fact ?? first?.text ?? JSON.stringify(first ?? ""));
  return { n: inc.length, firstId: first?.id ?? null, fact, source: j.candidate_source ?? "-" };
}

const regressions = [];
const improved = [];
const same = [];
for (const r of rows) {
  const [oldV, newV] = await Promise.all([brief(8787, r.query), brief(8797, r.query)]);
  if (oldV.n > 0 && newV.n === 0) regressions.push({ id: r.id, q: r.query, batch: r.batch, oldN: oldV.n, newSource: newV.source });
  else if (oldV.firstId !== newV.firstId) improved.push({ id: r.id, q: r.query, batch: r.batch, oldN: oldV.n, newN: newV.n, oldFirst: oldV.firstId, newFirst: newV.firstId, newFactHasKw: r.keyword ? newV.fact.includes(r.keyword) : null });
  else same.push(r.id);
}

console.log(`对比 176 问：不变 ${same.length}，首条变化 ${improved.length}，**从有结果变空 ${regressions.length}**`);
console.log("\n== 回归（旧有结果 → 新为空）==");
for (const g of regressions.slice(0, 20)) console.log(`  ${g.id} [${g.batch}] 「${g.q}」 旧命中=${g.oldN} 新source=${g.newSource}`);

console.log("\n== 首条变化的分布 ==");
const byBatch = {};
for (const c of improved) byBatch[c.batch] = (byBatch[c.batch] ?? 0) + 1;
console.log("  " + JSON.stringify(byBatch));
console.log("\n== A 批变化里「新首条含关键词」比例 ==");
const aChanges = improved.filter((c) => c.batch === "A-两字薄池" && c.newFactHasKw !== null);
const hasKw = aChanges.filter((c) => c.newFactHasKw).length;
console.log(`  ${hasKw}/${aChanges.length}`);
for (const c of aChanges.slice(0, 8)) console.log(`  ${c.id} 「${c.q}」 旧=${c.oldN}条 新=${c.newN}条 含词=${c.newFactHasKw ? "✅" : "❌"}`);
