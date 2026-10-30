// 查索引库是否已有 INDEX-2 的 df 表（决定部署后是否会一直走 full 回退）
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x) => x.name);
console.log("表:", tables.join(", "));
for (const n of ["files", "chunks", "embeddings", "fts_chunks", "recall_df_docs", "recall_df_bigrams", "recall_df_fts"]) {
  if (tables.includes(n)) {
    const c = db.prepare(`SELECT COUNT(*) c FROM ${n}`).get().c;
    console.log(`  ${n.padEnd(18)} = ${c} 行`);
  } else {
    console.log(`  ${n.padEnd(18)} = 【不存在】`);
  }
}
try {
  const meta = db.prepare("SELECT key, value FROM index_meta").all();
  console.log("index_meta:", JSON.stringify(meta).slice(0, 300));
} catch (e) {
  console.log("index_meta 读取失败:", e.message);
}
