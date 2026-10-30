// vector/graph 生产启用评估 —— 只读查询 ledger（不写任何数据）
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("I:\\OpenClaw\\memory-data\\memory\\indexes\\sqlite\\openclaw-memory-ledger.sqlite", { readOnly: true });
const q = (sql) => {
  try { return JSON.stringify(db.prepare(sql).get()); } catch (e) { return "ERR: " + e.message; }
};
console.log("embeddings 总行数:", q("SELECT COUNT(*) AS n FROM embeddings"));
console.log("embeddings active:", q("SELECT COUNT(*) AS n FROM embeddings WHERE vector_status = 'active'"));
console.log("embeddings 分布:", q("SELECT backend, model, dimension, COUNT(*) AS n FROM embeddings GROUP BY backend, model, dimension"));
console.log("edges 总行数:", q("SELECT COUNT(*) AS n FROM edges"));
console.log("edges 类型分布:", q("SELECT edge_type, COUNT(*) AS n FROM edges GROUP BY edge_type ORDER BY n DESC LIMIT 5"));
console.log("chunks 行数:", q("SELECT COUNT(*) AS n FROM chunks"));
console.log("items 行数:", q("SELECT COUNT(*) AS n FROM items"));
console.log("items status 分布:", q("SELECT status, COUNT(*) AS n FROM items GROUP BY status"));
console.log("schema_migrations 最近:", q("SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"));
db.close();
