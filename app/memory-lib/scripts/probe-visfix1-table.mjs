#!/usr/bin/env node
// VISIBILITY-FIX-1 —— 报告表格生成器（报告里的表**一律由它产出**，不手打、不改写）。
// 输入：reports/VISIBILITY-FIX-1-audit-{BEFORE,AFTER}.json
//   BEFORE 由 `probe-visfix1-before.mjs`（对**修前源码**跑，id = S1..S9）
//   AFTER  由 `probe-visfix1-audit.mjs`（对**当前源码**跑，id = A1..A5/C1..C2/D1/E1）
// 两份探针的 id 不同，这里显式映射；报告只贴本生成器的输出。
import fs from "node:fs/promises";

const DIR = "D:\\MemoryLib\\reports";
const before = JSON.parse(await fs.readFile(`${DIR}\\VISIBILITY-FIX-1-audit-BEFORE.json`, "utf8"));
const after = JSON.parse(await fs.readFile(`${DIR}\\VISIBILITY-FIX-1-audit-AFTER.json`, "utf8"));

// afterId -> beforeId
const MAP = { A1: "S1", A2: "S2", A3: "S3", A4: "S4", A5: "S5", C1: "S6", C2: "S7", D1: "S9", E1: "S8" };

const brief = (v) => {
  if (v === null || v === undefined) return "—";
  const s = String(v);
  if (s.startsWith("抛错:")) return "**抛错拒绝**";
  if (s === "object") return "1 个对象";
  return `${s} 条`;
};
const verdict = (v) => {
  if (typeof v !== "string") return "—";
  if (v.startsWith("— 抛错")) return "✅ 默认拒绝";
  if (v.startsWith("❌")) return "❌ 放行";
  return v;
};
const beforeById = new Map(before.rows.map((r) => [r.id, r]));

const lines = [];
lines.push("| 嫌疑点 | 位置 | 修前：无身份时 | 修前判定 | 修后：无身份时 | 修后判定 |");
lines.push("|---|---|---|---|---|---|");
for (const a of after.rows) {
  const b = beforeById.get(MAP[a.id] ?? a.id) ?? {};
  lines.push(`| ${a.id} ${a.what} | \`${a.site}\` | ${brief(b.无身份时)} | ${verdict(b.判定)} | ${brief(a.无身份时)} | ${verdict(a.判定)} |`);
}
console.log(lines.join("\n"));
