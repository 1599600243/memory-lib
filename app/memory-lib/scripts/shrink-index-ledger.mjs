import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function flag(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = flag("--db-path");
const backupDir = flag("--backup-dir");
const apply = process.argv.includes("--apply");
if (!dbPath || !backupDir) {
  console.error("usage: node scripts/shrink-index-ledger.mjs --db-path <sqlite> --backup-dir <dir> [--apply]");
  process.exit(2);
}

async function fileSize(file) {
  try { return (await fs.stat(file)).size; } catch { return 0; }
}
async function copyIfPresent(source, target) {
  try { await fs.copyFile(source, target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function snapshotActive(db) {
  return db.prepare("SELECT id,path,sha256,status FROM files WHERE status='active' ORDER BY id").all();
}
function dbBytes(db) {
  const row = db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get();
  return Number(row?.bytes ?? 0);
}

const sidecars = ["", "-wal", "-shm"];
try { await fs.access(dbPath); } catch { console.error(`database file not found: ${dbPath}`); process.exit(2); }
const beforeBytes = await fileSize(dbPath);
const db = new DatabaseSync(dbPath, { readOnly: !apply });
let beforeActive;
let beforeDeleted;
let beforePending;
try {
  beforeActive = snapshotActive(db);
  beforeDeleted = Number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE status='deleted'").get()?.n ?? 0);
  beforePending = Number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE status NOT IN ('active','deleted')").get()?.n ?? 0);
  const beforePagesBytes = dbBytes(db);
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", dbPath, files: { active: beforeActive.length, deleted: beforeDeleted, other: beforePending }, bytes: { filesystem: beforeBytes, sqlitePages: beforePagesBytes }, planned: { deleteDeletedRows: beforeDeleted, vacuum: true, markdownChanged: false }, backupRequired: true }, null, 2));
    process.exit(0);
  }
  await fs.mkdir(backupDir, { recursive: true });
  const backedUp = [];
  for (const suffix of sidecars) if (await copyIfPresent(`${dbPath}${suffix}`, path.join(backupDir, `${path.basename(dbPath)}${suffix}`))) backedUp.push(suffix || "main");
  if (!backedUp.includes("main")) throw new Error("database file missing; no changes made");
  db.exec("BEGIN IMMEDIATE");
  try {
    const deletedFiles = db.prepare("SELECT id FROM files WHERE status='deleted'").all().map((row) => row.id);
    for (const fileId of deletedFiles) {
      const chunkIds = db.prepare("SELECT id FROM chunks WHERE file_id=?").all(fileId).map((row) => row.id);
      for (const chunkId of chunkIds) {
        db.prepare("DELETE FROM fts_chunks WHERE chunk_id=?").run(chunkId);
        db.prepare("DELETE FROM embeddings WHERE chunk_id=?").run(chunkId);
      }
      db.prepare("DELETE FROM chunks WHERE file_id=?").run(fileId);
    }
    db.prepare("DELETE FROM files WHERE status='deleted'").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.exec("VACUUM");
  const afterActive = snapshotActive(db);
  const afterDeleted = Number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE status='deleted'").get()?.n ?? 0);
  const afterOther = Number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE status NOT IN ('active','deleted')").get()?.n ?? 0);
  if (JSON.stringify(afterActive) !== JSON.stringify(beforeActive) || afterDeleted !== 0 || afterOther !== beforePending) throw new Error("postcondition failed: active rows changed or non-deleted rows were altered");
  console.log(JSON.stringify({ mode: "apply", dbPath, backupDir, backupFiles: backedUp, before: { active: beforeActive.length, deleted: beforeDeleted, other: beforePending, bytes: beforeBytes }, after: { active: afterActive.length, deleted: afterDeleted, other: afterOther, bytes: await fileSize(dbPath) }, markdownChanged: false }, null, 2));
} finally {
  db.close();
}
