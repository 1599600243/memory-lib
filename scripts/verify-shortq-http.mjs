// 通过 HTTP 验 SHORT-Q-1（真服务，避免 in-process 探针失真）
// 用法: node verify-shortq-http.mjs [port]
import fs from "node:fs";

const port = process.argv[2] ?? "8797";
const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const topical = ["验收", "提炼", "注入", "隔离", "排序", "回滚", "日期", "记录", "状态", "基线", "捕获", "检索"];
const single = ["层", "验", "8"];

async function brief(q) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/recall/brief`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "pilot-01", role_id: "reader" }, format: "prompt", query: q, memory_only: true, memory_limit_chars: 600 }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const snippet = (m) => String(m?.fact ?? m?.text ?? m?.summary ?? JSON.stringify(m)).replace(/\s+/g, "").slice(0, 40);

let hit = 0, topHas = 0;
console.log(`== ${port} 两字主题词 ==`);
for (const q of topical) {
  const { status, json } = await brief(q);
  const inc = json?.included ?? [];
  const has = inc[0] ? String(inc[0]?.fact ?? inc[0]?.text ?? JSON.stringify(inc[0])).includes(q) : false;
  if (inc.length) hit++;
  if (has) topHas++;
  console.log(`  ${q}  HTTP ${status} 命中=${String(inc.length).padStart(2)} source=${String(json?.candidate_source ?? "-").padEnd(10)} 首条含词=${has ? "✅" : "❌"}  ${snippet(inc[0])}`);
}

console.log(`\n== ${port} 8层 ==`);
{
  const { json } = await brief("8层");
  const inc = json?.included ?? [];
  const has = inc[0] ? /8\s*层/.test(String(inc[0]?.fact ?? inc[0]?.text ?? JSON.stringify(inc[0]))) : false;
  if (inc.length) hit++;
  if (has) topHas++;
  console.log(`  命中=${inc.length} source=${json?.candidate_source ?? "-"} 首条含8层=${has ? "✅" : "❌"}  ${snippet(inc[0])}`);
}

console.log(`\n== ${port} 单字（必须为空）==`);
let leaked = 0;
for (const q of single) {
  const { json } = await brief(q);
  const n = (json?.included ?? []).length;
  if (n > 0) leaked++;
  console.log(`  ${q} 命中=${n} ${n === 0 ? "✅" : "❌"}`);
}

console.log(`\n汇总(${port})：13 条里有结果 ${hit}/13，首条含词 ${topHas}/13，单字被放行 ${leaked}/3`);
