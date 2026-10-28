// 核实"可读"的质量：向量/语义检索是否真的覆盖了新增的 1000+ 条原文？
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("D:\\MemoryLib\\data\\memory\\indexes\\sqlite\\memory-lib-index.sqlite", { readOnly: true });
const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ err: e.message }]; } };

console.log("=== embeddings 按状态 ===");
console.table(q("SELECT vector_status, COUNT(*) AS n FROM embeddings GROUP BY 1"));

console.log("=== 向量覆盖：原文 vs 正式记忆 ===");
console.table(q(`SELECT CASE WHEN f.path LIKE 'evidence/conversations/%' THEN '原文' ELSE '其它' END AS kind,
                        e.vector_status, COUNT(*) AS n
                 FROM embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN files f ON f.id=c.file_id
                 GROUP BY 1,2`));

console.log("=== 原文文件里：有向量的 / 完全没有向量的 ===");
console.table(q(`SELECT
    (SELECT COUNT(DISTINCT f.id) FROM files f WHERE f.status='active' AND f.path LIKE 'evidence/conversations/%') AS 原文文件数,
    (SELECT COUNT(DISTINCT f.id) FROM files f JOIN chunks c ON c.file_id=f.id JOIN embeddings e ON e.chunk_id=c.id
      WHERE f.status='active' AND f.path LIKE 'evidence/conversations/%' AND e.vector_status='active') AS 有活跃向量,
    (SELECT COUNT(*) FROM chunks c JOIN files f ON f.id=c.file_id
      WHERE f.status='active' AND f.path LIKE 'evidence/conversations/%') AS 原文分块数`));

console.log("=== FTS 是否覆盖原文 ===");
console.table(q(`SELECT COUNT(*) AS fts行数 FROM fts_chunks`));

console.log("=== 向量模型 ===");
console.table(q("SELECT model, dimension, COUNT(*) AS n FROM embeddings GROUP BY 1,2"));
db.close();
