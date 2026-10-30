// 找出"改了但没被重新索引"的那个文件（比对磁盘 mtime 与账本 mtime）
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const ROOT = "D:\\MemoryLib\\data\\memory";
const DB = path.join(ROOT, "indexes", "sqlite", "memory-lib-index.sqlite");
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare("SELECT path, status, mtime, sha256 FROM files WHERE status='active'").all();
const byPath = new Map(rows.map((r) => [r.path.replaceAll("\\", "/"), r]));
const mismatches = [];
for (const [rel, row] of byPath) {
  const full = path.join(ROOT, rel.replaceAll("/", path.sep));
  let st = null;
  try { st = fs.statSync(full); } catch { mismatches.push({ rel, why: "磁盘上已不存在（但账本仍 active）" }); continue; }
  if (row.mtime != null && Math.abs(Number(row.mtime) - st.mtimeMs) > 1) {
    mismatches.push({ rel, why: `mtime 不同：账本=${new Date(Number(row.mtime)).toISOString()} 磁盘=${new Date(st.mtimeMs).toISOString()}` });
  }
}
console.log(`账本 active 行: ${rows.length}`);
console.log(`mtime 不一致 / 缺失: ${mismatches.length}`);
for (const m of mismatches) console.log(`  - ${m.rel}\n      ${m.why}`);
db.close();
