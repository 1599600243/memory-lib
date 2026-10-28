#!/usr/bin/env node
/** diag-backfill-gap.mjs —— 找出某天"文件系统有、按天枚举却没取回"的条目，并打印它们的 frontmatter **全部键** */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const ident = { credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" } };
const day = process.argv[2] ?? "2026-10-07";
const ROOT = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";

const s = Date.parse(`${day}T00:00:00+08:00`), e = s + 86400000;
const local = [];
for (const name of fs.readdirSync(ROOT)) {
  if (!name.endsWith(".md")) continue;
  const full = path.join(ROOT, name);
  const t = fs.readFileSync(full, "utf8");
  if (!/type:\s*conversation/u.test(t)) continue;
  const at = /capturedAt:\s*(\S+)/u.exec(t)?.[1];
  const ms = Date.parse(at ?? "");
  if (!(ms >= s && ms < e)) continue;
  local.push({ name, full, t });
}

const api = new Set();
let off = 0;
for (let p = 0; p < 60; p += 1) {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ident, since: day, until: day, limit: 100, offset: off }) });
  const b = await r.json();
  for (const it of b.results ?? []) api.add(String(it.path).toLowerCase());
  if (b.next_offset == null) break;
  off = b.next_offset;
}

const missing = local.filter((x) => !api.has(x.full.toLowerCase()));
console.log(`${day}：文件系统 ${local.length} 条，取回 ${local.length - missing.length} 条，**缺 ${missing.length} 条**\n`);

const keysOf = (t) => {
  const head = t.split(/^---$/mu)[1] ?? "";
  return head.split("\n").map((l) => /^([A-Za-z_][A-Za-z0-9_]*):/u.exec(l)?.[1]).filter(Boolean);
};
console.log("=== 缺的那些：frontmatter 键 ===");
for (const x of missing) console.log(`  ${x.name}\n     键 = ${keysOf(x.t).join(", ")}`);

console.log("\n=== 取回的那些：键（抽样对比）===");
for (const x of local.filter((y) => api.has(y.full.toLowerCase())).slice(0, 2)) console.log(`  ${x.name}\n     键 = ${keysOf(x.t).join(", ")}`);

console.log("\n=== 缺失条目的 frontmatter 原文（前 500 字）===");
for (const x of missing.slice(0, 3)) console.log(`--- ${x.name}\n${x.t.slice(0, 500)}`);
