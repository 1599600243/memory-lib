// 自测：notifySettledRevisions 的两条判据（复刻逻辑，不依赖触发器运行）
// 目的：确认"刚变化的那一轮不通知"，只有"距最后一次变化 >= 一个扫描周期 且 大小未再变"才通知
const NOW = Date.now();
const INTERVAL_MS = 30000;

function shouldNotify(v, size) {
  if (!v.revision_pending || v.revision_notified === true) return false;
  const sinceLastChange = NOW - Number(v.revised_at_ms ?? 0);
  if (sinceLastChange < INTERVAL_MS) return false;
  if (Number(v.revision_pending.size) !== size) return false;
  return true;
}

const cases = [
  ["刚变化（同一轮扫描）", { revision_pending: { size: 9308 }, revised_at_ms: NOW }, 9308, false],
  ["变化后 10 秒", { revision_pending: { size: 9308 }, revised_at_ms: NOW - 10000 }, 9308, false],
  ["变化后 35 秒且大小一致", { revision_pending: { size: 9308 }, revised_at_ms: NOW - 35000 }, 9308, true],
  ["变化后 35 秒但大小又变了", { revision_pending: { size: 9308 }, revised_at_ms: NOW - 35000 }, 9400, false],
  ["已通知过", { revision_pending: { size: 9308 }, revised_at_ms: NOW - 35000, revision_notified: true }, 9308, false],
  ["没有 pending（从未改过）", { revised_at_ms: NOW - 35000 }, 9308, false],
];

let ok = true;
for (const [name, v, size, want] of cases) {
  const got = shouldNotify(v, size);
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  期望=${want} 实际=${got}`);
}
console.log(ok ? "全部通过" : "有失败");
process.exit(ok ? 0 : 1);
