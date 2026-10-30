#!/usr/bin/env node
// SCENARIO-2 —— 真实大日子压测（**只读**，零模型）。
//
// 它回答三个必须用**实测数字**回答的问题：
//   ① 大日子能不能**取全**？（取回条数 == total_count，逐日给出）
//   ② 取全要**多少次往返、多久**？（冷/热各一次；每页耗时）
//   ③ 取全之后素材**多大**？（excerpt 字符数合计、切几块）
//
// 只读：只调 `/v1/date/resolve` 与 `/v1/search`（空 query 按时间枚举），不发任何写请求。
// 不碰生产 8787；请指向一个指向生产 memory 的**只读临时实例**（见报告 §4）。
//
// 用法：
//   node scripts/scenario-bench.mjs --base-url http://127.0.0.1:8799 \
//        --credential-ref memory-lib/deepseek-harness --secret-file <path> \
//        --days 2026-10-07,2026-10-05,2026-09-24 --now 2026-10-15T08:00:00.000Z
//
// ⚠️ CALLSHAPE-1：**身份会改变读数**，所以复现契约表时必须显式给 `--role`。
//    契约文档 §5.1 那张表是 **--role researcher**（默认值是 reader，两者在 09-24 差 1 条）：
//      researcher → 09-24 = 106 条 / 41,085 字符 / 6 块
//      reader     → 09-24 = 105 条 / 40,944 字符 / 6 块
//    本脚本走 HTTP，因此用的是**服务端**装配（server.mjs → src/server-wiring.mjs），
//    与生产同一套；不要为了省事在别处另造一份 libFactory 去量数字（那正是 CALLSHAPE-1 的成因）。
import fs from "node:fs/promises";
import { recallScenario, chunkItems } from "../src/scenario-recall.mjs";

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const withEquals = argv.find((item) => item.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return fallback;
}

const BASE_URL = arg("base-url", "http://127.0.0.1:8799");
const NOW = arg("now", new Date().toISOString());
const TIMEZONE = arg("timezone", "Asia/Shanghai");
const CREDENTIAL_REF = arg("credential-ref", null);
const SECRET_FILE = arg("secret-file", null);
const AGENT = arg("agent", "pilot-01");
const ROLE = arg("role", "reader");
const PAGE_SIZE = Number(arg("page-size", "100"));
const CHUNK_CHARS = Number(arg("chunk-chars", "8000"));
const DAYS = (arg("days", "2026-10-07,2026-10-05,2026-09-24") ?? "").split(",").map((day) => day.trim()).filter(Boolean);

const secret = SECRET_FILE ? (await fs.readFile(SECRET_FILE, "utf8")).replace(/\r?\n$/u, "") : arg("secret", null);
const credentials = CREDENTIAL_REF && secret ? { credential_ref: CREDENTIAL_REF, secret } : {};
const principal = CREDENTIAL_REF ? { agent_id: AGENT, role_id: ROLE } : null;

// 每次请求的耗时：把 fetch 包一层计时（不改被测代码）。
let timings = [];
function timedFetch(url, init) {
  const started = Date.now();
  return globalThis.fetch(url, init).then((response) => { timings.push({ url: String(url).replace(BASE_URL, ""), ms: Date.now() - started }); return response; });
}

async function measureDay(day, label) {
  timings = [];
  const startedAt = Date.now();
  const result = await recallScenario({
    text: day, now: NOW, timezone: TIMEZONE, baseUrl: BASE_URL, credentials, principal,
    pageSize: PAGE_SIZE, chunkChars: CHUNK_CHARS, fetchImpl: timedFetch,
  });
  const elapsedMs = Date.now() - startedAt;
  if (result.kind !== "answer") {
    return { day, label, outcome: result.kind, reason: result.reason ?? null, message: result.message ?? null, elapsedMs };
  }
  const pageCalls = timings.filter((entry) => entry.url.endsWith("/v1/search"));
  return {
    day,
    label,
    outcome: "answer",
    returned: result.count,
    total_count: result.totalCount,
    complete: result.complete,
    pages: result.pages,
    resolve_ms: timings.find((entry) => entry.url.endsWith("/v1/date/resolve"))?.ms ?? null,
    page_max_ms: pageCalls.length ? Math.max(...pageCalls.map((entry) => entry.ms)) : null,
    page_avg_ms: pageCalls.length ? Math.round(pageCalls.reduce((sum, entry) => sum + entry.ms, 0) / pageCalls.length) : null,
    elapsed_ms: elapsedMs,
    total_chars: result.totalChars,
    chunks: result.chunks.length,
    chunk_max_chars: result.chunks.length ? Math.max(...result.chunks.map((chunk) => chunk.chars)) : 0,
    problems: result.problems,
  };
}

const rows = [];
for (const day of DAYS) {
  rows.push(await measureDay(day, "cold"));   // 冷（第一次，没有缓存/温度）
  rows.push(await measureDay(day, "warm"));   // 热（紧接着再来一次）
}

// 分批口径的实测：把最大的一天按不同预算切，看块数
const biggest = rows.filter((row) => row.outcome === "answer").sort((a, b) => b.returned - a.returned)[0] ?? null;
let chunkSweep = [];
if (biggest) {
  const full = await recallScenario({ text: biggest.day, now: NOW, timezone: TIMEZONE, baseUrl: BASE_URL, credentials, principal, pageSize: PAGE_SIZE, chunkChars: Number.MAX_SAFE_INTEGER, fetchImpl: timedFetch });
  for (const budget of [2000, 4000, 8000, 16000, 32000]) {
    const chunks = chunkItems(full.items, { maxCharsPerChunk: budget });
    chunkSweep.push({ budget, chunks: chunks.length, maxChunkChars: Math.max(...chunks.map((chunk) => chunk.chars)), oversized: chunks.filter((chunk) => chunk.oversized).length });
  }
}

console.log(JSON.stringify({
  script: "scenario-bench.mjs",
  readOnly: true,
  baseUrl: BASE_URL,
  now: NOW,
  timezone: TIMEZONE,
  pageSize: PAGE_SIZE,
  chunkChars: CHUNK_CHARS,
  days: rows,
  chunkSweepForBiggestDay: biggest ? { day: biggest.day, items: biggest.returned, totalChars: biggest.total_chars, sweep: chunkSweep } : null,
}, null, 2));
