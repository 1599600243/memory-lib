#!/usr/bin/env node
/**
 * RANK-1 C2 回归：拿 `scripts/rank1-facts.json` 里 20 条「有确定答案」的事实，
 * 每条换两种问法去问 brief，断言：
 *   ① 该条记忆进了 injected（included 里有它的 id）；
 *   ② 注入文本里能逐字看到答案（不是"大概相关"）；
 *   ③ 注入文本里没有半句（每行都以句末标点结尾、不含省略号）；
 *   ④ 可数属性问法（几层/几项/几个/几天）时，答案句排第 1（count_unit 认出来且 answer_first === 该 id）。
 *
 *   node scripts/rank1-regress.mjs --api http://127.0.0.1:8788
 *   node scripts/rank1-regress.mjs --api http://127.0.0.1:8788 --json    # 机器读
 *
 * 只读：只调 /v1/recall/brief。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = String(arg("api", "http://127.0.0.1:8788")).replace(/\/+$/, "");
const PATCH = arg("patch", "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml");
const FACTS_FILE = arg("facts", path.join(HERE, "rank1-facts.json"));
const LIMIT = Number(arg("limit", 600));
const TOP = Number(arg("memories", 6));
const AGENT = String(arg("agent", "pilot-01"));
const ROLE = String(arg("role", "reader"));
const JSON_OUT = process.argv.includes("--json");

const yml = await fs.readFile(PATCH, "utf8");
const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
if (!ref || !secret) throw new Error(`拿不到凭据（${PATCH}）`);

const spec = JSON.parse(await fs.readFile(FACTS_FILE, "utf8"));
const facts = Array.isArray(spec.facts) ? spec.facts : [];

async function ask(query) {
  const res = await fetch(`${API}/v1/recall/brief`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential_ref: ref,
      secret,
      principal: { agent_id: AGENT, role_id: ROLE },
      format: "prompt",
      query,
      memories: TOP,
      memory_limit_chars: LIMIT,
      memory_only: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * "半句"的两个可观察特征：行尾不是句末标点；或行尾挂着截断省略号。
 * 注意：省略号只认**行尾**——记忆正文里本来就可能出现 `sha256 d739242b…`、
 * `if (false && ...)` 这种行内省略，那不是截断，不该误判。
 */
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
for (const f of facts) {
  for (const q of f.questions) {
    const b = await ask(q);
    const included = Array.isArray(b.included) ? b.included : [];
    const ids = included.map((x) => x.id);
    const hit = ids.includes(f.id);
    const answerVisible = String(b.text ?? "").includes(f.expected);
    const bad = halfSentences(b.text);
    const isCount = Boolean(f.unit) && new RegExp(`(?:几|多少)\\s*${f.unit}`, "u").test(q);
    const rankFirst = isCount ? b.answer_first === f.id : null;
    const ok = hit && answerVisible && bad.length === 0 && (isCount ? rankFirst === true : true);
    rows.push({
      id: f.id,
      expected: f.expected,
      query: q,
      isCount,
      hit,
      answerVisible,
      halfSentences: bad,
      countUnit: b.count_unit ?? null,
      answerFirst: b.answer_first ?? null,
      rank: hit ? ids.indexOf(f.id) + 1 : null,
      chars: String(b.text ?? "").length,
      dropped: Array.isArray(b.dropped) ? b.dropped.length : null,
      ok,
      text: b.text,
    });
  }
}

const failed = rows.filter((r) => !r.ok);
const degraded = rows.filter((r) => !r.hit || !r.answerVisible);
const half = rows.filter((r) => r.halfSentences.length);
const countRows = rows.filter((r) => r.isCount);

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ api: API, total: rows.length, failed: failed.length, rows }, null, 1)}\n`);
} else {
  console.log(`api=${API}  limit=${LIMIT}  memories=${TOP}  facts=${facts.length}  问法=${rows.length}`);
  console.log("");
  console.log("| # | 源 id | 问法 | 命中 | 答案在文本里 | 可数问法排第1 | 注入字数 | 结论 |");
  console.log("|---|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    console.log(
      `| ${i + 1} | ${r.id.replace("curated-shared-", "")} | ${r.query} | ${r.hit ? "✓" : "✗"} | ${r.answerVisible ? "✓" : "✗"} | ${
        r.isCount ? (r.answerFirst === r.id ? "✓" : `✗(${r.answerFirst ?? "null"})`) : "—"
      } | ${r.chars} | ${r.ok ? "PASS" : "FAIL"} |`,
    );
  });
  console.log("");
  console.log(`合计 ${rows.length} 次问答：命中 ${rows.length - rows.filter((r) => !r.hit).length}，答案可见 ${rows.length - rows.filter((r) => !r.answerVisible).length}，半句 ${half.length}`);
  console.log(`可数问法 ${countRows.length} 次，答案句排第 1 的 ${countRows.filter((r) => r.answerFirst === r.id).length} 次`);
  if (failed.length) {
    console.log("");
    console.log("失败明细：");
    for (const r of failed) {
      console.log(`  ✗ ${r.query}（源 ${r.id}，期望含 ${JSON.stringify(r.expected)}）`);
      console.log(`    hit=${r.hit} answerVisible=${r.answerVisible} countUnit=${r.countUnit} answerFirst=${r.answerFirst} 半句=${JSON.stringify(r.halfSentences)}`);
      console.log(`    注入文本：${JSON.stringify(String(r.text).slice(0, 400))}`);
    }
  }
  console.log("");
  console.log(`结论：20 条事实 × 换问法 = ${rows.length} 次，全部命中且答案可见、无半句 ⇒ ${failed.length === 0 ? "PASS" : "FAIL"}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
