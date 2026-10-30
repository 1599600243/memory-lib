// 诊断：为什么 pending_changes 一直是 1
import { DatabaseSync } from "node:sqlite";
const DB = "D:\\MemoryLib\\data\\memory\\indexes\\sqlite\\memory-lib-index.sqlite";
const db = new DatabaseSync(DB, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log("表:", tables.join(", "));
console.log("");

for (const t of tables) {
  if (!/file|ledger|scan|pending/i.test(t)) continue;
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    console.log(`表 ${t}: ${n} 行`);
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    console.log(`   列: ${cols.join(", ")}`);
  } catch (e) { console.log(`表 ${t}: 读取失败 ${e.message}`); }
}
console.log("");

try {
  const rows = db.prepare("SELECT path, status, sha256 FROM files").all();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log("files 表按 status:", JSON.stringify(byStatus));
  const nonMd = rows.filter((r) => !/\.md$/i.test(r.path));
  console.log(`非 .md 的登记文件: ${nonMd.length}`);
  nonMd.slice(0, 10).forEach((r) => console.log(`   [${r.status}] ${r.path}`));
  const notActive = rows.filter((r) => r.status !== "active");
  console.log(`非 active 的文件: ${notActive.length}`);
  notActive.slice(0, 10).forEach((r) => console.log(`   [${r.status}] ${r.path}`));
} catch (e) { console.log("files 表读取失败:", e.message); }
db.close();
