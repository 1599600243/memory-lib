// VISIBILITY-FIX-1-REJECT2 —— 由 BEFORE/AFTER 探针产物自动生成「这次改动可能影响的既有行为」表。
// 用法：node scripts/probe-visfix1r2-table.mjs <BEFORE.json> <AFTER.json>
import fs from "node:fs/promises";

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error("用法：node scripts/probe-visfix1r2-table.mjs <BEFORE.json> <AFTER.json>");
  process.exit(2);
}
const before = JSON.parse(await fs.readFile(beforePath, "utf8"));
const after = JSON.parse(await fs.readFile(afterPath, "utf8"));
const byEntry = (rows) => new Map(rows.map((r) => [r.entry, r]));
const b = byEntry(before);
const a = byEntry(after);
const esc = (s) => String(s).replace(/\|/gu, "\\|");

const rows = [];
for (const [entry, after] of a) {
  const before = b.get(entry);
  const changed = !before || before.reading !== after.reading;
  rows.push({
    entry,
    consumer: after.consumer,
    caller: after.caller,
    before: before?.reading ?? "(无记录)",
    after: after.reading,
    verdict: changed ? "**有变化**" : "未受影响",
  });
}
const md = [
  "| 入口 | 消费者 | 调用方 | 修前实测读数 | 修后实测读数 | 判定 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${esc(r.entry)} | ${esc(r.consumer)} | ${esc(r.caller)} | ${esc(r.before)} | ${esc(r.after)} | ${r.verdict} |`),
].join("\n");
console.log(md);
console.log("");
console.log(`条目数：${rows.length}；有变化 ${rows.filter((r) => r.verdict !== "未受影响").length} 条；未受影响 ${rows.filter((r) => r.verdict === "未受影响").length} 条。`);
