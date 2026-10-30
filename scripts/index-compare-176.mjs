// INDEX 系里程碑的**三路对比**脚本（J1 的可复现入口）：
//   全量扫描(621b08f)  vs  INDEX-1(0acc142)  vs  INDEX-2(586c5c1)
// 同一份数据副本、同一个进程、同一批问句，逐条比 recallBrief().included 的 id 序列。
//
// 用法（三个源码目录 + 数据副本都必须显式给，免得跑错代码还不知道）：
//   node scripts/index-compare-176.mjs `
//     --src-full D:\tmp\wt-621b08f\memory-lib\src `
//     --src-i1   D:\tmp\wt-0acc142\memory-lib\src `
//     --src-i2   D:\MemoryLib\app\memory-lib\src `
//     --data-root D:\tmp\data-1445 `
//     [--corpus reports/INDEX-1-acceptance-corpus-176.jsonl] [--out D:\tmp\cmp.json]
//
// ★ 数据规矩（必须遵守）：
//   1. `--data-root` **只能是生产库的副本**（`D:\MemoryLib\index1-data\mem-1445` 或
//      `D:\MemoryLib\data\memory` 的拷贝），绝不要直接指向生产 `data\memory` —— 本脚本对数据只读，
//      但把"只读"寄希望于脚本行为是不设防的做法；拷一份再跑。
//   2. 副本要跑一次索引 refresh，把 `recall_df_docs` / `recall_df_bigrams` / `recall_df_fts`
//      三张表建出来（INDEX-2 的 df 统计就在这三张表里）：
//         node -e "import('./memory-lib/src/index-store.mjs').then(m=>m.indexMemoryRoot({dataRoot:'<副本>'}))"
//      没这三张表时 INDEX-2 会整体回退全量扫描（reason=df-index-missing），跑出来的差异没有意义。
//      本脚本会先检查这三张表并在缺失时打一行 WARN。
//   3. 生产服务（8787）不要重启、不要部署；全程只读。
//
// 输出格式（固定，便于前后对比）：
//   ### 全量 → INDEX-1
//     176 问：首条改变 N 次；序列不同 N 次；其中漏掉含关键词记忆 N 次
//     按批分布：{...}
//     i1 候选来源分布：{"fts":N,"full":N,...}
//     （有差异时逐条列出：基准序列 / 本轮序列 / 漏掉谁 / 新增谁）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  return process.argv[i + 1] ?? dflt;
};

const CORPUS = String(arg("corpus", path.join(REPO, "reports", "INDEX-1-acceptance-corpus-176.jsonl")));
const DATA = arg("data-root", null);
const OUT = arg("out", null);
const PRINCIPAL = {
  tenant_id: "default", framework_id: "deepseek-harness", group_id: "unknown",
  user_id: "unknown", agent_id: "pilot-01", role_id: "reader",
};

const die = (msg) => { console.error(`错误：${msg}`); process.exit(2); };
if (!DATA) die("必须给 --data-root（生产库的**副本**，别指向 D:\\MemoryLib\\data\\memory）");
if (path.resolve(String(DATA)).toLowerCase() === path.resolve(REPO, "data", "memory").toLowerCase()) die("--data-root 不能是生产 data\\memory，先拷副本");
const srcs = { full: arg("src-full", null), i1: arg("src-i1", null), i2: arg("src-i2", null) };
for (const [k, v] of Object.entries(srcs)) if (!v) die(`缺少 --src-${k}（要指向含 recall.mjs 的 memory-lib/src 目录）`);
for (const [k, v] of Object.entries(srcs)) if (!fs.existsSync(path.join(String(v), "recall.mjs"))) die(`--src-${k} 里没有 recall.mjs：${v}`);
if (!fs.existsSync(path.join(String(DATA), "curated", "shared"))) die(`--data-root 下没有 curated/shared：${DATA}`);

const rows = fs.readFileSync(CORPUS, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const corpusSha = crypto.createHash("sha256").update(fs.readFileSync(CORPUS)).digest("hex");

// 副本里 df 三张表在不在（不在 ⇒ INDEX-2 会全量回退，读到的"零差异"是假零差异）
const dfStatus = (() => {
  const dbPath = path.join(String(DATA), "indexes", "sqlite", "memory-lib-index.sqlite");
  if (!fs.existsSync(dbPath)) return "索引库不存在（缺 indexes/sqlite/memory-lib-index.sqlite）";
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => String(r.name)));
    const missing = ["recall_df_docs", "recall_df_bigrams", "recall_df_fts"].filter((t) => !names.has(t));
    if (missing.length) return `缺 ${missing.join("/")}（请先跑一次 index refresh）`;
    const docs = db.prepare("SELECT COUNT(*) AS c FROM recall_df_docs").get().c;
    return `齐备（recall_df_docs ${docs} 行）`;
  } catch (error) {
    return `打不开：${String(error?.message ?? error).slice(0, 120)}`;
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
})();

const runners = {};
for (const [key, dir] of Object.entries(srcs)) {
  const mod = await import(pathToFileURL(path.join(String(dir), "recall.mjs")).href);
  const recall = mod.createRecall({ dataRoot: String(DATA), workspaceRoot: REPO });
  runners[key] = {
    dir: String(dir),
    async ask(query) {
      const t0 = performance.now();
      const res = await recall.recallBrief({
        project: null, days: 7, limit_chars: 2000,
        agent_id: "pilot-01", role_id: "reader", principal: PRINCIPAL,
        format: "prompt", query, memories: 6, memory_limit_chars: 600, memory_only: true,
      });
      return {
        ids: (res.included ?? []).map((x) => x.id),
        source: res.candidate_source ?? null,
        files: res.candidate_files ?? null,
        reason: res.candidate_reason ?? null,
        ms: Math.round((performance.now() - t0) * 100) / 100,
      };
    },
  };
}

// 记忆 id → 一句话事实（判"漏掉的到底是不是含关键词的那条"）
// 只看事实的**前 N 字**（`--keyword-window`，默认 120，与 2026-10-22 验收报告 §2 的口径一致）。
// 这个数字只影响"漏掉含关键词记忆 N 次"这个**诊断子计数**，不影响"首条改变/序列不同"。
const KEYWORD_WINDOW = Math.max(20, Number(arg("keyword-window", 120)) || 120);
const factMod = await import(pathToFileURL(path.join(String(srcs.full), "recall.mjs")).href);
const facts = new Map();
const curatedRoot = path.join(String(DATA), "curated", "shared");
for (const name of fs.readdirSync(curatedRoot)) {
  if (!name.endsWith(".md")) continue;
  const text = fs.readFileSync(path.join(curatedRoot, name), "utf8");
  const body = text.split(/^---$/mu).slice(2).join("---");
  facts.set(name.slice(0, -3), String(factMod.memoryFactOf(body)).replace(/\s+/gu, " ").slice(0, KEYWORD_WINDOW));
}

const results = [];
for (const row of rows) {
  const rec = { id: row.id, query: row.query, batch: row.batch, keyword: row.keyword ?? null };
  for (const key of ["full", "i1", "i2"]) rec[key] = await runners[key].ask(row.query);
  results.push(rec);
  process.stderr.write(".");
}
process.stderr.write("\n");

const short = (id) => String(id).replace(/^curated-shared-/u, "");
const kwTest = (rec) => (rec.keyword ? (id) => String(facts.get(id) ?? "").toLowerCase().includes(String(rec.keyword).toLowerCase()) : null);

function judge(base, next) {
  let firstChanged = 0;
  let seqChanged = 0;
  let keywordLost = 0;
  const byBatch = {};
  const diffs = [];
  for (const rec of results) {
    const b = rec[base].ids;
    const n = rec[next].ids;
    if ((b[0] ?? null) !== (n[0] ?? null)) firstChanged += 1;
    if (JSON.stringify(b) === JSON.stringify(n)) continue;
    seqChanged += 1;
    byBatch[rec.batch] = (byBatch[rec.batch] ?? 0) + 1;
    const lost = b.filter((x) => !n.includes(x));
    const gained = n.filter((x) => !b.includes(x));
    const test = kwTest(rec);
    const kwLost = test ? lost.filter((id) => test(id)) : [];
    if (kwLost.length) keywordLost += 1;
    diffs.push({ rec, b, n, lost, gained, kwLost });
  }
  const dist = {};
  for (const rec of results) {
    const s = rec[next].source ?? "-";
    dist[s] = (dist[s] ?? 0) + 1;
  }
  return { firstChanged, seqChanged, keywordLost, byBatch, dist, diffs };
}

const lines = [];
lines.push(`语料 ${CORPUS}`);
lines.push(`  sha256 ${corpusSha}   行数 ${rows.length}`);
lines.push(`数据副本 ${DATA}`);
lines.push(`  recall_df_* 三张表：${dfStatus}`);
lines.push(`源码 全量=${srcs.full}`);
lines.push(`     INDEX-1=${srcs.i1}`);
lines.push(`     INDEX-2=${srcs.i2}`);
lines.push(`关键词判定窗口 ${KEYWORD_WINDOW} 字（--keyword-window 可调；只影响"漏掉含关键词"这个子计数）`);
lines.push("");

const report = { corpus: CORPUS, corpusSha, rows: rows.length, dataRoot: String(DATA), dfStatus, sources: srcs };
for (const [base, next, label] of [["full", "i1", "全量 → INDEX-1"], ["full", "i2", "全量 → INDEX-2"], ["i1", "i2", "INDEX-1 → INDEX-2"]]) {
  const r = judge(base, next);
  report[label] = r;
  lines.push(`### ${label}`);
  lines.push(`  ${rows.length} 问：首条改变 ${r.firstChanged} 次；序列不同 ${r.seqChanged} 次；其中漏掉含关键词记忆 ${r.keywordLost} 次`);
  lines.push(`  按批分布：${JSON.stringify(r.byBatch)}`);
  lines.push(`  ${next} 候选来源分布：${JSON.stringify(r.dist)}`);
  for (const d of r.diffs) {
    lines.push(`  - ${d.rec.id} [${d.rec.batch}] ${JSON.stringify(d.rec.query)} source=${d.rec[next].source} files=${d.rec[next].files}${d.rec[next].reason ? ` reason=${d.rec[next].reason}` : ""}`);
    lines.push(`      基准 ${JSON.stringify(d.b.map(short))}`);
    lines.push(`      本轮 ${JSON.stringify(d.n.map(short))}`);
    lines.push(`      漏 ${d.lost.map(short).join(",") || "-"} / 新增 ${d.gained.map(short).join(",") || "-"}${d.kwLost.length ? `  ← 漏掉含关键词的 ${d.kwLost.length} 条` : ""}`);
  }
  lines.push("");
}
const text = lines.join("\n");
console.log(text);
if (OUT) {
  fs.writeFileSync(String(OUT), JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(String(OUT).replace(/\.json$/u, ".txt"), text, "utf8");
  fs.writeFileSync(String(OUT).replace(/\.json$/u, ".jsonl"), `${results.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  console.log(`\n已写 ${OUT}（+.txt/.jsonl）`);
}
