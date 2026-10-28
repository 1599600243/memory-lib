import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveAudit, rotateAuditArchives } from "../src/audit-archive.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d22-archive-"));
after(async () => fs.rm(root, { recursive: true, force: true }));

function line(ts, text) { return `${JSON.stringify({ ts, text })}\n`; }

test("archive dry-run does not write and execute preserves raw rows with backup", async () => {
  const audit = path.join(root, "audit", "access.jsonl");
  const archive = path.join(root, "audit", "archive");
  const backups = path.join(root, "backups");
  const raw = line("2026-08-23T00:00:00Z", "保留字段   ") + line("2026-09-28T00:00:00Z", "old") + line("2026-09-29T00:00:00Z", "new");
  await fs.mkdir(path.dirname(audit), { recursive: true });
  await fs.writeFile(audit, raw, "utf8");
  const dry = await archiveAudit(audit, { cutoff: "2026-09-29T00:00:00Z", archiveDir: archive, backupDir: backups, dryRun: true });
  assert.equal(dry.archived_lines, 2);
  assert.equal(await fs.readFile(audit, "utf8"), raw);
  assert.equal(await fs.stat(archive).then(() => true, () => false), false);
  const executed = await archiveAudit(audit, { cutoff: "2026-09-29T00:00:00Z", archiveDir: archive, backupDir: backups, dryRun: false });
  assert.equal(executed.original_lines, 3);
  assert.equal(executed.archived_lines + executed.remaining_lines, 3);
  assert.ok(executed.backup);
  assert.equal(await fs.readFile(executed.backup, "utf8"), raw);
  assert.equal(await fs.readFile(path.join(archive, "access-2026-08.jsonl"), "utf8"), line("2026-08-23T00:00:00Z", "保留字段   "));
  assert.equal(await fs.readFile(path.join(archive, "access-2026-09.jsonl"), "utf8"), line("2026-09-28T00:00:00Z", "old"));
  assert.equal(await fs.readFile(audit, "utf8"), line("2026-09-29T00:00:00Z", "new"));
});

test("archive rotation dry-runs and gzip compression is additive", async () => {
  const archive = path.join(root, "rotate");
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(archive, "access-2025-01.jsonl"), "old\n");
  const dry = await rotateAuditArchives({ archiveDir: archive, retainMonths: 1, now: new Date("2026-10-01T00:00:00Z"), dryRun: true });
  assert.deepEqual(dry.compressed, ["access-2025-01.jsonl"]);
  assert.equal(await fs.stat(path.join(archive, "access-2025-01.jsonl.gz")).then(() => true, () => false), false);
  await rotateAuditArchives({ archiveDir: archive, retainMonths: 1, now: new Date("2026-10-01T00:00:00Z"), dryRun: false });
  assert.equal(await fs.readFile(path.join(archive, "access-2025-01.jsonl"), "utf8"), "old\n");
  assert.ok((await fs.stat(path.join(archive, "access-2025-01.jsonl.gz"))).size > 0);
});
