import { DatabaseSync } from "node:sqlite";
const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error("usage: node d19-backup.mjs source target");
const db = new DatabaseSync(source);
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
