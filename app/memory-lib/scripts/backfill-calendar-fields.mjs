import fs from "node:fs/promises";
import path from "node:path";
import { calendarFields } from "../src/conversation-memory.mjs";
import { atomicWriteFile } from "../src/atomic-write.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const root = args.find((arg) => !arg.startsWith("--"));
const timezone = args.find((arg) => arg.startsWith("--timezone="))?.slice("--timezone=".length) || "UTC";
let invalidTimezone = false;
try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { invalidTimezone = true; }
// 校验失败必须**当场退出**：只设 exitCode 而不 return 会让 main() 继续跑，
// 然后把 RangeError 抛到顶层（非受控堆栈、退出码 1），校验形同虚设。
if (invalidTimezone) { console.error(`invalid IANA timezone: ${timezone}`); process.exit(2); }
if (!root) { console.error("usage: node scripts/backfill-calendar-fields.mjs <data-root> [--timezone=UTC] [--apply]"); process.exit(2); }

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}
function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  return match ? match[1] : null;
}
function value(block, key) { return block.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?$`, "mu"))?.[1]?.trim() || null; }
async function main() {
  const files = await walk(path.join(root, "evidence", "conversations"));
  const report = { apply, timezone, scanned: files.length, changed: 0, backups: [] };
  for (const file of files) {
    const original = await fs.readFile(file, "utf8");
    const block = frontmatter(original);
    const capturedAt = block && value(block, "capturedAt");
    if (!block || !capturedAt) continue;
    const fields = calendarFields(capturedAt, timezone);
    const dateLine = `calendarDate: ${fields.calendarDate}`;
    const zoneLine = `calendarTimezone: ${JSON.stringify(fields.calendarTimezone)}`;
    let updated = original;
    updated = /^calendarDate:/mu.test(updated) ? updated.replace(/^calendarDate:.*$/mu, dateLine) : updated.replace(/^capturedAt:.*$/mu, (line) => `${line}\n${dateLine}`);
    updated = /^calendarTimezone:/mu.test(updated) ? updated.replace(/^calendarTimezone:.*$/mu, zoneLine) : updated.replace(/^calendarDate:.*$/mu, (line) => `${line}\n${zoneLine}`);
    if (updated === original) continue;
    report.changed += 1;
    if (!apply) continue;
    const backup = `${file}.dayrecall-backup`;
    await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL).catch(() => {});
    // ATOMICWRITE-1：收敛到统一助手（同目录临时文件 + rename 重试）。
    // 备份仍在此前完成，因此重试期间磁盘上始终有可回退的副本。
    await atomicWriteFile(file, updated);
    report.backups.push(backup);
  }
  console.log(JSON.stringify(report, null, 2));
}
if (root) await main();
