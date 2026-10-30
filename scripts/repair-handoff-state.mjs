// 修补 handoff 状态：把"历史已结案但状态被清掉"的 dev 报告登记为已交接，避免看门狗重启后重派给验收岗
// 用法: node repair-handoff-state.mjs [--apply]
import fs from "node:fs";

const STATE = "D:\\MemoryLib\\reports\\.handoff-state.json";
const APPLY = process.argv.includes("--apply");

const missing = [
  "ATOMICWRITE-1-dev-report.md",
  "DAY-INTERVAL-1-dev-report.md",
  "DAYRECALL-1-dev-report.md",
  "M2.1-A-dev-report.md",
  "M2.1-B1-dev-report.md",
  "M2.1-B2-dev-report.md",
  "RETRIEVAL-1-FIX4-dev-report.md",
  "SCENARIO-1-dev-report.md",
  "SCENARIO-2-dev-report.md",
];

const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
const now = new Date().toISOString();
let added = 0;
for (const name of missing) {
  if (state[name]) { console.log(`= 已有，跳过: ${name}`); continue; }
  const p = `D:\\MemoryLib\\reports\\${name}`;
  if (!fs.existsSync(p)) { console.log(`! 文件不存在，跳过: ${name}`); continue; }
  const size = fs.statSync(p).size;
  state[name] = {
    seen_at: now,
    size,
    action: "handoff-to-acceptance",
    note: "backfill 2026-10-20：历史已结案单，状态在 21:59 清理时丢失；补登以防看门狗重派",
  };
  added++;
  console.log(`+ 补登: ${name} (${size}B)`);
}
console.log(`\n共补 ${added} 条；APPLY=${APPLY}`);
if (APPLY) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8");
  console.log("已写入 " + STATE);
}
