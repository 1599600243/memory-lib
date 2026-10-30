#!/usr/bin/env node
// memory-stats.mjs —— 记忆库全库概览（只读，不改任何东西）
//
// 解决什么问题：库里到底有多少条记忆、分别属于谁、哪些层是空的、索引有没有漏。
// 之前只能靠猜（前端 memory/list 曾对 QQ 身份返回 0 条，就是没人能看到概览）。
//
// 用法：
//   node scripts/memory-stats.mjs
//   node scripts/memory-stats.mjs --top 20        # 按 user_id 分组显示前 20
//   node scripts/memory-stats.mjs --json          # 机器可读

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:/MemoryLib/data/memory";
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const topFlag = args.indexOf("--top");
const topN = topFlag >= 0 ? Number(args[topFlag + 1] ?? 15) || 15 : 15;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].replace(/^"|"$/g, "").trim();
  }
  return fm;
}

const stats = {
  generatedAt: new Date().toISOString(),
  roots: {},
  byUserId: {},
  byVisibility: {},
  byLayer: {},
  bySource: {},
  newest: null,
  oldest: null,
  total: 0,
};

function addCount(bucket, key) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

// 1) curated/shared —— 长期记忆主库
const curatedDir = path.join(ROOT, "curated", "shared");
const curatedFiles = walk(curatedDir);
stats.roots["curated/shared"] = curatedFiles.length;
for (const f of curatedFiles) {
  const text = readFileSync(f, "utf8");
  const fm = frontmatter(text);
  stats.total += 1;
  addCount(stats.byUserId, fm.user_id || "(无 user_id)");
  addCount(stats.byVisibility, fm.visibility || "(无)");
  addCount(stats.byLayer, fm.layer || "(无)");
  const ev = (fm.evidence_refs || "").replace(/[\[\]"]/g, "");
  const source = ev.includes("napcat-group") ? "群聊" : ev.includes("napcat") ? "私聊(QQ)" : ev.includes("session-") ? "DSH 会话" : ev.includes("soul") ? "灵魂包" : "其他";
  addCount(stats.bySource, source);
  const t = fm.occurred_at || fm.updated_at;
  if (t) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) {
      if (!stats.newest || d > stats.newest.d) stats.newest = { d, id: fm.id ?? path.basename(f) };
      if (!stats.oldest || d < stats.oldest.d) stats.oldest = { d, id: fm.id ?? path.basename(f) };
    }
  }
}

// 2) evidence —— 原始对话
const evDir = path.join(ROOT, "evidence", "conversations");
const evFiles = walk(evDir);
stats.roots["evidence/conversations"] = evFiles.length;
const bySourceRaw = {};
for (const f of evFiles) {
  const head = readFileSync(f, "utf8").slice(0, 600);
  const m = head.match(/source:\s*"?([^"\n]+)"?/);
  addCount(bySourceRaw, (m ? m[1] : "未知").trim());
}
stats.roots.byEvidenceSource = bySourceRaw;

// 3) 目录体积
const dirSize = (dir) => walk(dir).reduce((n, f) => n + (statSync(f).size || 0), 0);
stats.roots["curated/shared 体积MB"] = Math.round((dirSize(curatedDir) / 1024 / 1024) * 10) / 10;
stats.roots["evidence 体积MB"] = Math.round((dirSize(evDir) / 1024 / 1024) * 10) / 10;

if (asJson) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n, " ");
console.log("═".repeat(64));
console.log("记忆库概览  " + stats.generatedAt);
console.log("═".repeat(64));
console.log("\n【文件数】");
for (const [k, v] of Object.entries(stats.roots)) {
  if (typeof v === "object") continue;
  console.log("  " + pad(k, 28) + v);
}
console.log("\n【证据来源】");
for (const [k, v] of Object.entries(stats.roots.byEvidenceSource ?? {}).sort((a, b) => b[1] - a[1])) {
  console.log("  " + pad(k, 28) + v);
}
console.log(`\n【长期记忆 ${stats.total} 条】按 user_id`);
const users = Object.entries(stats.byUserId).sort((a, b) => b[1] - a[1]);
for (const [k, v] of users.slice(0, topN)) console.log("  " + pad(k, 28) + v);
if (users.length > topN) console.log("  … 另有 " + (users.length - topN) + " 个 user_id");
console.log("\n【可见性】");
for (const [k, v] of Object.entries(stats.byVisibility).sort((a, b) => b[1] - a[1])) console.log("  " + pad(k, 20) + v);
console.log("\n【层】");
for (const [k, v] of Object.entries(stats.byLayer).sort((a, b) => b[1] - a[1])) console.log("  " + pad(k, 20) + v);
console.log("\n【内容来源】");
for (const [k, v] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) console.log("  " + pad(k, 20) + v);
if (stats.newest) console.log("\n最新: " + stats.newest.d.toISOString().slice(0, 19) + "  " + stats.newest.id);
if (stats.oldest) console.log("最老: " + stats.oldest.d.toISOString().slice(0, 19) + "  " + stats.oldest.id);
console.log("");
