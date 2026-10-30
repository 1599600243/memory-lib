// M2.1-B2 探针：打印关键表达的实际解析结果，用于定位失败。
import { resolveDateText } from "../src/date-query.mjs";

const NOW = "2026-10-12T04:00:00.000Z";
const TZ = "Asia/Shanghai";
const CASES = [
  "最近三天", "近三天", "最近五天", "最近一天",
  "近一个月", "近三个月", "最近两个月",
  "上周一到上周三", "这周一到这周三", "周一到周三",
  "10月1号到10月7号", "10/1 到 10/7", "2026-10-01到2026-10-07", "10月1号到10月1号",
  "10/10 那天", "10/10那天", "10 月 10 号那天", "10月10日那天", "10/10 那天我们聊了什么", "三天前那天",
  "三天前到今天", "上个月15号",
];
for (const text of CASES) {
  const r = resolveDateText({ text, now: NOW, timezone: TZ });
  const range = r.ok ? `${r.range.since} .. ${r.range.untilExclusive}` : "—";
  console.log(`${(r.ok ? "OK  " : "FAIL")} ${text.padEnd(24)} ${r.ok ? String(r.grain).padEnd(7) + range : r.reason + " | " + String(r.message).slice(0, 60)}`);
}
// 上个月 30 号（2026-03 的上一月没有 30 号）
for (const [text, now] of [["上个月30号", "2026-03-12T04:00:00.000Z"], ["上个月29号", "2026-03-12T04:00:00.000Z"], ["上个月29号", "2024-03-12T04:00:00.000Z"], ["上个月31号", "2026-10-12T04:00:00.000Z"]]) {
  const r = resolveDateText({ text, now, timezone: TZ });
  console.log(`${(r.ok ? "OK  " : "FAIL")} ${text.padEnd(24)} now=${now.slice(0, 10)} -> ${r.ok ? r.calendarDate : r.reason}`);
}
