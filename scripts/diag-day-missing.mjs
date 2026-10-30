#!/usr/bin/env node
/**
 * diag-day-missing.mjs —— 那 90 个"按天没取回"的文件，到底在哪？
 * 逐条回答：① 它的 frontmatter 全貌 ② 不带时间范围的关键词检索能不能找到它 ③ 它是不是根本没进索引
 * **只读**。
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };
const search = async (b) => {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, ...b }) });
  return await r.json().catch(() => null);
};

const ROOT = "D:\\MemoryLib\\data\\memory";
const day = process.argv[2] ?? "2026-10-07";
const startMs = Date.parse(`${day}T00:00:00+08:00`);
const endMs = startMs + 86400000;

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".md")) files.push(f); } };
walk(ROOT);

const fmAll = (file) => {
  const txt = fs.readFileSync(file, "utf8");
  const head = txt.slice(0, 1600);
  const keys = {};
  for (const line of head.split("\n")) { const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(line); if (m) keys[m[1]] = m[2].trim(); }
  return { txt, keys };
};

// 取回集合（按天，翻页取全）
const api = new Set();
let off = 0;
for (let p = 0; p < 60; p += 1) { const b = await search({ since: day, until: day, limit: 100, offset: off }); for (const it of b.results ?? []) api.add(String(it.path).toLowerCase()); if (b.next_offset == null) break; off = b.next_offset; }

// 该日文件系统条目
const dayFiles = [];
for (const f of files) {
  const { keys } = fmAll(f);
  const t = keys.capturedAt ?? keys.updatedAt;
  const ms = Date.parse(t ?? "");
  if (Number.isFinite(ms) && ms >= startMs && ms < endMs && keys.type === "conversation") dayFiles.push({ f, keys });
}
const missing = dayFiles.filter((x) => !api.has(x.f.toLowerCase()));
const returned = dayFiles.filter((x) => api.has(x.f.toLowerCase()));
console.log(`该日 conversation 文件 ${dayFiles.length} 个：取回 ${returned.length}，未取回 ${missing.length}\n`);

console.log("=== 取回的那批：frontmatter 有哪些键 ===");
const keyCount = (arr) => { const c = new Map(); for (const x of arr) for (const k of Object.keys(x.keys)) c.set(k, (c.get(k) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]); };
console.log("取回批：" + keyCount(returned).map(([k, n]) => `${k}:${n}`).join(" "));
console.log("未取回：" + keyCount(missing).map(([k, n]) => `${k}:${n}`).join(" "));

console.log("\n=== 未取回样本：全文 frontmatter ===");
for (const x of missing.slice(0, 3)) {
  console.log(`--- ${x.f.replace(ROOT, "")}`);
  console.log(fs.readFileSync(x.f, "utf8").slice(0, 420).replace(/\n/gu, " ⏎ "));
}

console.log("\n=== 拿它们正文里的话做关键词检索（不带时间范围），看能不能找到 ===");
for (const x of missing.slice(0, 4)) {
  const body = x.txt.split("---").slice(2).join("---").replace(/\s+/gu, " ").trim();
  const probe = body.slice(0, 30).replace(/["'\\]/gu, "");
  const r = await search({ query: probe, limit: 5 });
  const found = (r?.results ?? []).some((it) => String(it.path).toLowerCase() === x.f.toLowerCase());
  console.log(`  ${found ? "找得到" : "**找不到**"}  关键词「${probe.slice(0, 24)}…」 返回 ${(r?.results ?? []).length} 条  ← ${x.f.split("\\").pop()}`);
}
