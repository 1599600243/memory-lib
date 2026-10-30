#!/usr/bin/env node
// repair-failed-embeddings.mjs —— 修复 vector_status='failed' 的向量行
//
// 背景（2026-10-29）：health 一直 degraded，index.failed=78，原因全是
// `embedding HTTP 500`（ollama/bge-m3 瞬时失败后被永久记为 failed）。
// index-store 只在文件 sha256 变化时重嵌入，所以这些行**永远不会自愈**。
//
// 做法：逐条重新调用 ollama 嵌入，成功则把 vector_blob / vector_status 原地更新。
// 默认 dry-run（只统计、不写库）；--write 才真改。
//
// 用法：
//   node scripts/repair-failed-embeddings.mjs                 # 干跑
//   node scripts/repair-failed-embeddings.mjs --write         # 真修
//   node scripts/repair-failed-embeddings.mjs --write --limit 5

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const limitFlag = args.indexOf("--limit");
const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Infinity;

const DB = process.env.MEMORY_LIB_INDEX_DB
  ?? "D:/MemoryLib/data/memory/indexes/sqlite/memory-lib-index.sqlite";
const OLLAMA = process.env.OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434";
const MODEL = process.env.EMBEDDING_MODEL ?? "bge-m3";
const DIM = Number(process.env.EMBEDDING_DIMENSION ?? 1024);

if (!existsSync(DB)) { console.error(`找不到索引库: ${DB}`); process.exit(1); }

const db = new DatabaseSync(DB, { readOnly: !write });
const rows = db.prepare(`
  SELECT e.chunk_id, e.model, e.dimension, c.text, f.path
  FROM embeddings e JOIN chunks c ON c.id = e.chunk_id LEFT JOIN files f ON f.id = c.file_id
  WHERE e.vector_status = 'failed'
`).all();

console.log(`索引库: ${DB}`);
console.log(`待修复: ${rows.length} 条  模型=${MODEL} 维度=${DIM}  模式=${write ? "WRITE" : "dry-run"}`);
if (!rows.length) { console.log("没有 failed 行，收工。"); process.exit(0); }

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const vec = body?.embedding ?? body?.embeddings?.[0];
  if (!Array.isArray(vec) || vec.length !== DIM) throw new Error(`维度异常: ${vec?.length ?? "无"}`);
  return vec;
}

const update = write
  ? db.prepare(`UPDATE embeddings SET vector_blob=?, vector_status='active', stale_reason=NULL, indexed_at=?, model=?, dimension=? WHERE chunk_id=?`)
  : null;

let ok = 0;
const failed = [];
let done = 0;
for (const row of rows) {
  if (done >= limit) break;
  done += 1;
  try {
    const vec = await embed(row.text);
    if (write) {
      const blob = Buffer.from(new Float32Array(vec.map(Number)).buffer);
      update.run(blob, new Date().toISOString(), MODEL, DIM, row.chunk_id);
    }
    ok += 1;
    if (done % 10 === 0) console.log(`  进度 ${done}/${Math.min(rows.length, limit)}  成功 ${ok}  失败 ${failed.length}`);
  } catch (err) {
    failed.push({ chunk: row.chunk_id, path: row.path, error: String(err.message ?? err) });
  }
}

console.log("");
console.log(`成功: ${ok}  失败: ${failed.length}`);
for (const f of failed.slice(0, 10)) console.log(`  ✗ ${f.path ?? "?"}  ${f.error}`);
if (!write) console.log("dry-run：没有写库。加 --write 才会真改。");
