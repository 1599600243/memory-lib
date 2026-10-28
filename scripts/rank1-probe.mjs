#!/usr/bin/env node
/**
 * RANK-1 现象探针（只读）：对**指定**记忆服务连问同一件事的多种问法，
 * 打印每次 brief 的命中清单、排名、以及"含数字答案的那条"排第几。
 *
 *   node scripts/rank1-probe.mjs                       # 默认打 8788（隔离实例）
 *   node scripts/rank1-probe.mjs --api http://127.0.0.1:8788 --limit 600 --format prompt --memory-only
 *   node scripts/rank1-probe.mjs --queries "记忆库几层,记忆库是几层,记忆库有几层？"
 *   node scripts/rank1-probe.mjs --expect-curated-shared-466787238d86faef   # 看某条 id 的位次（探针，不是特判）
 *
 * 只调 /v1/recall/brief，不写任何东西。
 */
import fs from "node:fs/promises";
import path from "node:path";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const API = String(arg("api", "http://127.0.0.1:8788")).replace(/\/+$/, "");
const PATCH = arg("patch", "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml");
const LIMIT = Number(arg("limit", 600));
const TOP = Number(arg("memories", 6));
const FORMAT = String(arg("format", "prompt"));
const MEMORY_ONLY = arg("memory-only", true) !== false && !process.argv.includes("--no-memory-only");
const PROBE_ID = String(arg("expect", "curated-shared-466787238d86faef"));
const AGENT = String(arg("agent", "pilot-01"));
const ROLE = String(arg("role", "reader"));

const DEFAULT_QUERIES = ["记忆库几层", "记忆库是几层", "记忆库有几层？", "我们记忆库分几层", "记忆库一共几层"];
const QUERIES = String(arg("queries", DEFAULT_QUERIES.join(","))).split(",").map((s) => s.trim()).filter(Boolean);

const yml = await fs.readFile(PATCH, "utf8");
const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
if (!ref || !secret) throw new Error(`拿不到凭据（${PATCH}）`);

async function brief(query) {
  const res = await fetch(`${API}/v1/recall/brief`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential_ref: ref,
      secret,
      principal: { agent_id: AGENT, role_id: ROLE },
      format: FORMAT,
      query,
      memories: TOP,
      memory_limit_chars: LIMIT,
      memory_only: MEMORY_ONLY,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return body;
}

/** "含数字+量词"的句子（通用判定，不针对任何 id/数字）。 */
function looksCountableAnswer(text, unit) {
  if (!text) return false;
  return new RegExp(`(\\d+|[一二三四五六七八九十百千万零两]+)\\s*${unit}`, "u").test(text);
}

console.log(`api=${API}  limit=${LIMIT}  memories=${TOP}  format=${FORMAT}  memory_only=${MEMORY_ONLY}`);
console.log("");
const rows = [];
for (const q of QUERIES) {
  const b = await brief(q);
  const included = Array.isArray(b?.included) ? b.included : [];
  const ids = included.map((x) => x.id);
  const pos = ids.indexOf(PROBE_ID);
  const answering = included.map((x) => looksCountableAnswer(String(x.excerpt ?? ""), "层"));
  const answerPos = answering.findIndex(Boolean);
  rows.push({
    query: q,
    hits: ids.length,
    probeRank: pos >= 0 ? pos + 1 : null,
    firstAnswerRank: answerPos >= 0 ? answerPos + 1 : null,
    chars: String(b?.text ?? "").length,
    truncated: b?.memory_truncated ?? null,
    dropped: Array.isArray(b?.dropped) ? b.dropped.length : null,
    text: String(b?.text ?? ""),
    ids,
    excerpts: included.map((x) => x.excerpt),
  });
}

console.log("| 问法 | 命中条数 | 含数字答案那条的位次 | 注入字数 | truncated |");
console.log("|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.query} | ${r.hits} | ${r.firstAnswerRank ?? (r.probeRank ? `(探针条)${r.probeRank}` : "未命中")} | ${r.chars} | ${r.truncated} |`);
}
console.log("");
for (const r of rows) {
  console.log(`── ${r.query} ──  injected=${r.chars} chars  hits=${r.hits}  dropped=${r.dropped}`);
  r.ids.forEach((id, i) => {
    const mark = looksCountableAnswer(r.excerpts[i], "层") ? " ★数字" : "";
    console.log(`  ${i + 1}. ${id}${mark}`);
    console.log(`     ${r.excerpts[i]}`);
  });
  console.log("");
}
const allAnsweredFirst = rows.every((r) => r.firstAnswerRank === 1);
console.log(`结论：所有问法都把「数字+层」那句排到第 1 = ${allAnsweredFirst}  ⇒ ${allAnsweredFirst ? "PASS" : "FAIL"}`);
process.exitCode = allAnsweredFirst ? 0 : 1;
