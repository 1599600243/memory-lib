import fs from "node:fs/promises";
import fscb from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { renameWithRetry } from "./atomic-write.mjs";

function monthFor(event, fallback = new Date()) {
  const date = new Date(event?.ts ?? fallback);
  return Number.isNaN(date.getTime()) ? `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, "0")}` : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fsyncFile(filePath) {
  const handle = await fs.open(filePath, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

function tempPath(target) { return path.join(path.dirname(target), `.tmp-${crypto.randomUUID()}-${path.basename(target)}`); }

async function* rawLines(filePath) {
  let carry = Buffer.alloc(0);
  for await (const chunk of fscb.createReadStream(filePath)) {
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    let newline;
    while ((newline = data.indexOf(10, start)) !== -1) {
      yield data.subarray(start, newline + 1);
      start = newline + 1;
    }
    carry = data.subarray(start);
  }
  if (carry.length) yield carry;
}

function parseRawLine(raw) {
  let end = raw.length;
  if (end && raw[end - 1] === 10) end -= 1;
  if (end && raw[end - 1] === 13) end -= 1;
  if (!end) return null;
  try { return JSON.parse(raw.subarray(0, end).toString("utf8")); } catch { return null; }
}

export async function archiveAudit(auditPath, { cutoff = "2026-09-29T00:00:00Z", archiveDir = path.join(path.dirname(auditPath), "archive"), backupDir = path.join(path.dirname(path.dirname(auditPath)), "backups"), dryRun = true } = {}) {
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) throw new Error(`invalid cutoff: ${cutoff}`);
  const report = { auditPath, cutoff, dry_run: dryRun, original_lines: 0, archived_lines: 0, remaining_lines: 0, archives: {}, backup: null, changed: false };
  let backup = null;
  let mainTemp = null;
  const archiveTemps = new Map();
  const handles = new Map();
  try {
    if (!dryRun) {
      await fs.mkdir(archiveDir, { recursive: true });
      await fs.mkdir(backupDir, { recursive: true });
      backup = path.join(backupDir, `access-pre-archive-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
      await fs.copyFile(auditPath, backup);
      await fsyncFile(backup);
      report.backup = backup;
      mainTemp = tempPath(auditPath);
      handles.set("main", await fs.open(mainTemp, "w"));
    }
    for await (const raw of rawLines(auditPath)) {
      if (raw.length === 0) continue;
      report.original_lines += 1;
      const event = parseRawLine(raw);
      const archived = event && Date.parse(event.ts ?? "") < cutoffMs;
      if (!archived) {
        report.remaining_lines += 1;
        if (!dryRun) await handles.get("main").write(raw);
        continue;
      }
      const month = monthFor(event);
      report.archived_lines += 1;
      report.archives[month] = (report.archives[month] ?? 0) + 1;
      if (dryRun) continue;
      if (!handles.has(month)) {
        const target = path.join(archiveDir, `access-${month}.jsonl`);
        const temp = tempPath(target);
        archiveTemps.set(month, { temp, target });
        try { await fs.copyFile(target, temp); } catch { await fs.writeFile(temp, Buffer.alloc(0)); }
        handles.set(month, await fs.open(temp, "a"));
      }
      await handles.get(month).write(raw);
    }
    if (dryRun || report.archived_lines === 0) return report;
    for (const handle of handles.values()) await handle.sync();
    for (const handle of handles.values()) await handle.close();
    handles.clear();
    // ATOMICWRITE-1：归档的落地同样是 rename（把追加好的临时档覆盖回目标），
    // 走 renameWithRetry 以免一次瞬时 EPERM 让整轮归档失败（且此前失败会留下 temp 残档）。
    for (const { temp, target } of archiveTemps.values()) await renameWithRetry(temp, target);
    await renameWithRetry(mainTemp, auditPath);
    mainTemp = null;
    report.changed = true;
    return report;
  } finally {
    for (const handle of handles.values()) await handle.close().catch(() => {});
    if (mainTemp) await fs.unlink(mainTemp).catch(() => {});
    for (const { temp } of archiveTemps.values()) await fs.unlink(temp).catch(() => {});
  }
}

export async function rotateAuditArchives({ archiveDir, maxBytes = 64 * 1024 * 1024, retainMonths = 12, dryRun = true, now = new Date() }) {
  const entries = await fs.readdir(archiveDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((entry) => /^access-\d{4}-\d{2}\.jsonl$/.test(entry.name)).map((entry) => entry.name).sort();
  const report = { dry_run: dryRun, compressed: [], oversized: [], retained: candidates.slice(-retainMonths) };
  let total = 0;
  for (const name of candidates) total += (await fs.stat(path.join(archiveDir, name))).size;
  if (total > maxBytes) report.oversized = candidates.slice(0, Math.max(0, candidates.length - retainMonths));
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retainMonths + 1, 1));
  for (const name of candidates) {
    const source = path.join(archiveDir, name);
    const month = name.slice(7, 14);
    if (new Date(`${month}-01T00:00:00Z`) >= cutoff && !report.oversized.includes(name)) continue;
    const target = `${source}.gz`;
    report.compressed.push(name);
    if (dryRun || await fs.stat(target).then(() => true, () => false)) continue;
    await pipeline(fscb.createReadStream(source), zlib.createGzip(), fscb.createWriteStream(target));
    await fsyncFile(target);
    // Compression is additive: the source JSONL remains until an explicit backed-up purge exists.
  }
  return report;
}
