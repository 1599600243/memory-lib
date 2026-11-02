#!/usr/bin/env node
/**
 * RANK-1 改前/改后对照：拿 `scripts/rank1-facts.json` 里的 20 条事实 × 40 个问法，
 * 直接调 `createRecall().recallBrief()`（不起服务、不写东西），比对两个版本的
 * 「命中 / 答案可见 / 半句」三个指标。
 *
 *   # 改后（当前工作树）
 *   node scripts/rank1-baseline.mjs
 *
 *   # 改前（先检出改前代码，用它的 recall.mjs）
 *   git -C .\app worktree add .\rank1-work\pre d03e40b
 *   node scripts/rank1-baseline.mjs --module .\rank1-work\pre\memory-lib\src\recall.mjs --label pre
 *   git -C .\app worktree remove --force .\rank1-work\pre
 *
 * 只读：只读 data root 下的记忆文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = arg("module", path.join(HERE, "..", "app", "memory-lib", "src", "recall.mjs"));
const LABEL = String(arg("label", "now"));
const DATA_ROOT = arg("data-root", "D:\\MemoryLib\\inject1-work\\copy\\memory");
const FACTS_FILE = arg("facts", path.join(HERE, "rank1-facts.json"));
const LIMIT = Number(arg("limit", 600));
const TOP = Number(arg("memories", 6));

const PRINCIPAL = { framework_id: "f1", tenant_id: "default", agent_id: "agent-1", role_id: "role-1", group_id: "g1", user_id: "u1" };

const { createRecall } = await import(pathToFileURL(path.resolve(MODULE)).href);
const recall = createRecall({ dataRoot: DATA_ROOT, workspaceRoot: path.dirname(DATA_ROOT) });
const spec = JSON.parse(await fs.readFile(FACTS_FILE, "utf8"));

/** 半句的两个可观察特征：行尾不是句末标点；或行尾挂着截断省略号（行内省略不算）。 */
function halfSentences(text) {
  const bad = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t === "（明确的无）") continue;
    if (!/[。；！？!?;]$/u.test(t)) bad.push(t);
    else if (/(…|\.{3,})$/u.test(t)) bad.push(t);
  }
  return bad;
}

const rows = [];
for (const f of spec.facts) {
  for (const q of f.questions) {
    const b = await recall.recallBrief({
      principal: PRINCIPAL,
      format: "prompt",
      memory_only: true,
      memory_limit_chars: LIMIT,
      memories: TOP,
      query: q,
    });
    const included = Array.isArray(b.included) ? b.included : [];
    const ids = included.map((x) => x.id);
    const hit = ids.includes(f.id);
    const answerVisible = String(b.text ?? "").includes(f.expected);
    const bad = halfSentences(b.text);
    const isCount = Boolean(f.unit) && new RegExp(`(?:几|多少)\\s*${f.unit}`, "u").test(q);
    const answerFirst = b.answer_first ?? null;
    const ok = hit && answerVisible && bad.length === 0 && (isCount ? answerFirst === f.id : true);
    rows.push({ q, id: f.id, hit, answerVisible, bad: bad.length, isCount, answerFirst, ok, rank: hit ? ids.indexOf(f.id) + 1 : null, chars: String(b.text ?? "").length });
  }
}

const n = (pred) => rows.filter(pred).length;
const countRows = rows.filter((r) => r.isCount);

console.log(`== ${LABEL} ==  module=${MODULE}`);
console.log("");
console.log("| # | 问法 | 命中 | 答案可见 | 位次 | 半句 | 注入字数 | 结论 |");
console.log("|---|---|---|---|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.q} | ${r.hit ? "✓" : "✗"} | ${r.answerVisible ? "✓" : "✗"} | ${r.rank ?? "—"} | ${r.bad} | ${r.chars} | ${r.ok ? "PASS" : "FAIL"} |`));
console.log("");
console.log(`小结 ${LABEL}：PASS ${n((r) => r.ok)}/${rows.length} ｜ 命中 ${n((r) => r.hit)}/40 ｜ 答案可见 ${n((r) => r.answerVisible)}/40 ｜ 半句 ${n((r) => r.bad > 0)} 次 ｜ 可数问法答案排第1 ${countRows.filter((r) => r.answerFirst === r.id).length}/${countRows.length}`);
const fails = rows.filter((r) => !r.ok);
if (fails.length) {
  console.log("");
  console.log("不过的：" + fails.map((r) => `${r.q}（${r.id.replace("curated-shared-", "")}${r.hit ? "" : " 未命中"}${r.answerVisible ? "" : " 答案不可见"}${r.bad ? ` 半句${r.bad}` : ""}）`).join(" · "));
}
process.exitCode = fails.length === 0 ? 0 : 1;
