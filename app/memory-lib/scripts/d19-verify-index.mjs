import { DatabaseSync } from "node:sqlite";
const [file] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: true });
try {
  console.log(JSON.stringify({
    embeddings: db.prepare("SELECT model,dimension,vector_status,COUNT(*) n FROM embeddings GROUP BY model,dimension,vector_status").all(),
    chunks: db.prepare("SELECT COUNT(*) n FROM chunks").get(),
    failed: db.prepare("SELECT COUNT(*) n FROM embeddings WHERE vector_status='failed'").get(),
    meta: db.prepare("SELECT key,value FROM index_meta").all(),
    integrity: db.prepare("PRAGMA integrity_check").get(),
  }));
} finally { db.close(); }
