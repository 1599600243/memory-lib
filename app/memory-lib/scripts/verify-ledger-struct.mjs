// 验证 ledger 只读查询结构（FTS + chunks/files 路径连接）
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("I:\\OpenClaw\\memory-data\\memory\\indexes\\sqlite\\openclaw-memory-ledger.sqlite", { readOnly: true });
console.log("fts_chunks 行数:", JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM fts_chunks").get()));
try {
  const r = db.prepare("SELECT fts.rowid, fts.chunk_id, fts.item_id, substr(fts.text_excerpt,1,40) AS ex FROM fts_chunks fts LIMIT 1").all();
  console.log("fts 样例:", JSON.stringify(r));
} catch (e) { console.log("fts 直查错误:", e.message); }
const join = db.prepare("SELECT c.id AS chunk_id, c.item_id, f.path FROM chunks c JOIN files f ON f.id = c.file_id LIMIT 1").all();
console.log("chunks/files join 样例:", JSON.stringify(join));
const emb = db.prepare("SELECT id, chunk_id, item_id, length(vector_blob) AS blob_len, dimension FROM embeddings LIMIT 1").all();
console.log("embeddings blob 样例:", JSON.stringify(emb));
db.close();
