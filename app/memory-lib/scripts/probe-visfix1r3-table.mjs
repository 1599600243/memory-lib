// VISIBILITY-FIX-1-REJECT3 —— 由 BEFORE/AFTER 探针产物生成「修前 vs 修后」对照表。
// 用法：node scripts/probe-visfix1r3-table.mjs <BEFORE.json> <AFTER.json>
import fs from "node:fs/promises";

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error("用法：node scripts/probe-visfix1r3-table.mjs <BEFORE.json> <AFTER.json>");
  process.exit(2);
}
const before = new Map(JSON.parse(await fs.readFile(beforePath, "utf8")).map((r) => [r.entry, r]));
const after = JSON.parse(await fs.readFile(afterPath, "utf8"));
const esc = (s) => String(s).replace(/\|/gu, "\\|");

const rows = after.map((a) => {
  const b = before.get(a.entry);
  const changed = !b || b.reading !== a.reading;
  return { ...a, before: b?.reading ?? "(无记录)", verdict: changed ? "**有变化**" : "未受影响" };
});
const md = [
  "| 入口 | 消费者 | 调用方 | 修前实测读数 | 修后实测读数 | 判定 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${esc(r.entry)} | ${esc(r.consumer)} | ${esc(r.caller)} | ${esc(r.before)} | ${esc(r.reading)} | ${r.verdict} |`),
].join("\n");
console.log(md);
console.log("");
console.log(`条目数：${rows.length}；有变化 ${rows.filter((r) => r.verdict !== "未受影响").length} 条；未受影响 ${rows.filter((r) => r.verdict === "未受影响").length} 条。`);
