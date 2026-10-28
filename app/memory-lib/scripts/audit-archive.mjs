import path from "node:path";
import { archiveAudit, rotateAuditArchives } from "../src/audit-archive.mjs";

function value(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const auditPath = value("--audit", "I:\\OpenClaw\\memory-data\\runtime\\audit\\access.jsonl");
const archiveDir = value("--archive-dir", path.join(path.dirname(auditPath), "archive"));
const backupDir = value("--backup-dir", path.join(path.dirname(path.dirname(auditPath)), "backups"));
const cutoff = value("--cutoff", "2026-09-29T00:00:00Z");
const execute = process.argv.includes("--execute");
const report = await archiveAudit(auditPath, { cutoff, archiveDir, backupDir, dryRun: !execute });
if (execute && report.changed) await rotateAuditArchives({ archiveDir, maxBytes: Number(value("--max-bytes", 64 * 1024 * 1024)), retainMonths: Number(value("--retain-months", 12)), dryRun: false });
console.log(JSON.stringify(report, null, 2));
