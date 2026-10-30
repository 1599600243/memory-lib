// 基线(8798) vs 新版(8797)：176 问逐条比首条与 source（真 HTTP，同一份数据副本）
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const rows = fs.readFileSync("D:\\MemoryLib\\reports\\INDEX-1-acceptance-corpus-176.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function call(port, q) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/recall/brief`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "pilot-01", role_id: "reader" }, format: "prompt", query: q, memory_only: true, memory_limit_chars: 600 }),
  });
  const j = await r.json().catch(() => ({}));
  const inc = j.included ?? [];
  return { first: inc[0]?.id ?? null, n: inc.length, src: String(j.candidate_source ?? "-") };
}

const byBatch = {};
const regress = [];
for (const r of rows) {
  const [b, n] = await Promise.all([call(8798, r.query), call(8797, r.query)]);
  const bKey = r.batch ?? "?";
  byBatch[bKey] ??= { total: 0, firstChanged: 0, emptied: 0 };
  byBatch[bKey].total++;
  if (b.first !== n.first) byBatch[bKey].firstChanged++;
  if (b.n > 0 && n.n === 0) { byBatch[bKey].emptied++; regress.push({ id: r.id, q: r.query, batch: bKey }); }
}
console.log("基线 d6944ab(8798) vs 新版 44ec808(8797)，同一份 mem-1445：\n");
for (const [k, v] of Object.entries(byBatch)) {
  console.log(`  ${k.padEnd(14)} 共 ${String(v.total).padStart(3)} 条  首条改变 ${String(v.firstChanged).padStart(3)}  从有结果变空 ${v.emptied}`);
}
console.log(`\n回归（旧有→新空）：${regress.length} 条`);
for (const g of regress.slice(0, 10)) console.log(`  ${g.id} [${g.batch}] 「${g.q}」`);
