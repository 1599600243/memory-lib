// 检索评测：对同一组问题跑不同检索配置，输出 recall@5 / recall@10 / MRR@10。
// 用法：node eval/eval-retrieval.mjs [--json] [--eval eval/retrieval-20261031.json]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const evalPath = args.includes("--eval") ? args[args.indexOf("--eval") + 1] : path.join(ROOT, "eval", "retrieval-20261031.json");

const dataRoot = process.env.MEMORY_DATA_ROOT || "D:/MemoryLib/data/memory";
const principal = {
  tenant_id: "default", framework_id: "deepseek-harness", agent_id: "admin-01",
  role_id: "librarian-admin", group_id: "home-circle", user_id: "user-owner",
};

const IDENT = /[A-Za-z][A-Za-z0-9._-]{2,}/gu;

// 尝试性改进：对候选做"标识符命中"重排（MAINT7 / TZ-CONFIG-1 这类词才是区分点）
async function rerankByIdentifier(results, query, dataRoot) {
  const ids = [...new Set((String(query).match(IDENT) ?? []).map((s) => s.toLowerCase()))].filter((s) => !/^(the|and|for|with)$/u.test(s));
  if (!ids.length) return results;
  const scored = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const file = String(result.path ?? result.id ?? "");
    const text = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")).catch(() => "");
    const lower = text.toLowerCase();
    const hits = ids.filter((id) => lower.includes(id)).length;
    scored.push({ result, score: 1 / (i + 1) + hits * 1.0, hits });
  }
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
  return scored.map((entry) => entry.result);
}

const VARIANTS = [
  { id: "baseline", label: "基线：hybrid 但关标识符重排", options: { identifierRerank: false } },
  { id: "hybrid", label: "默认 hybrid（标识符重排已开）", options: {} },
  { id: "no-graph", label: "hybrid 但关图扩展", options: { graphExpand: false } },
  { id: "memories", label: "只看正式记忆（searchMode=memories）", options: { searchMode: "memories" } },
  { id: "no-evidence", label: "正式记忆 + 禁证据/文档配额", options: { searchMode: "memories", rawQuota: 0, documentQuota: 0 } },
  { id: "rerank50", label: "候选 50 + 标识符重排", options: { searchMode: "memories", rawQuota: 0, documentQuota: 0 }, rerank: true, pool: 50 },
];

function norm(value) { return String(value ?? "").replace(/\\/gu, "/"); }

async function runVariant(lib, items, options) {
  const rows = [];
  for (const item of items) {
    let results = [];
    try { results = await lib.search({ query: item.query, limit: 10, ...options }); }
    catch (error) { rows.push({ id: item.id, rank: null, error: error.message }); continue; }
    const paths = (Array.isArray(results) ? results : []).map((result) => norm(result.path ?? result.id));
    const expected = item.expected.map(norm);
    const rank = paths.findIndex((file) => expected.some((want) => file.endsWith(want)));
    rows.push({ id: item.id, query: item.query, rank: rank >= 0 ? rank + 1 : null, top5: paths.slice(0, 5) });
  }
  const hit5 = rows.filter((row) => row.rank !== null && row.rank <= 5).length;
  const hit10 = rows.filter((row) => row.rank !== null && row.rank <= 10).length;
  const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length;
  return { rows, hit5, hit10, mrr, total: rows.length };
}

async function main() {
  const spec = JSON.parse(await fs.readFile(evalPath, "utf8"));
  const items = spec.items;
  const lib = createMemoryLib({ dataRoot, principal });
  const report = { eval: evalPath, dataRoot, items: items.length, variants: [] };
  for (const variant of VARIANTS) {
    let result = await runVariant(lib, items, variant.options);
    if (variant.rerank) {
      const rows = [];
      for (const item of items) {
        let results = [];
        try { results = await lib.search({ query: item.query, limit: variant.pool ?? 20, ...variant.options }); } catch (error) { rows.push({ id: item.id, rank: null, error: error.message }); continue; }
        const reranked = await rerankByIdentifier(Array.isArray(results) ? results : [], item.query, dataRoot);
        const paths = reranked.map((entry) => norm(entry.path ?? entry.id));
        const rank = paths.findIndex((file) => item.expected.map(norm).some((want) => file.endsWith(want)));
        rows.push({ id: item.id, query: item.query, rank: rank >= 0 ? rank + 1 : null });
      }
      const hit5 = rows.filter((row) => row.rank !== null && row.rank <= 5).length;
      const hit10 = rows.filter((row) => row.rank !== null && row.rank <= 10).length;
      const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length;
      result = { rows, hit5, hit10, mrr, total: rows.length };
    }
    report.variants.push({ id: variant.id, label: variant.label, ...result });
  }
  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`  评测集 ${items.length} 条 · ${evalPath}`);
  for (const variant of report.variants) {
    const pct = (n) => `${Math.round((n / variant.total) * 100)}%`;
    console.log(`\n  [${variant.id}] ${variant.label}`);
    console.log(`    recall@5=${variant.hit5}/${variant.total} (${pct(variant.hit5)})  recall@10=${variant.hit10}/${variant.total} (${pct(variant.hit10)})  MRR@10=${variant.mrr.toFixed(3)}`);
    const misses = variant.rows.filter((row) => row.rank === null || row.rank > 5);
    for (const miss of misses.slice(0, 6)) console.log(`      ✗ ${miss.id} rank=${miss.rank ?? "未命中"}  ${miss.query}`);
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
