// DAY-INTERVAL-1 探针 3：`listMemories` 与 `timeline` 在**多日区间**上是否一致？
// 单日时区间重叠恰好与本地日重合，所以要看跨日范围才暴露差异。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "day-interval-list3-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });
// 判别性夹具：要选**两种规则给出不同答案**的瞬时。
//   上海本地 10-10 的窗口 = [10-09T16:00Z, 10-10T16:00Z)
//   UTC     10-10 的窗口 = [10-10T00:00Z, 10-10T23:59:59.999Z]
// ① 10-09T16:00Z（本地 10-10 00:00）→ 本地窗口**内**、UTC 窗口**外** ← 判别点
// ② 10-10T23:59:59.999Z（UTC 尾部） → UTC 窗口**内**、本地 10-10 **外** ← 判别点
for (const [id, capturedAt] of [
  ["local-first-local-only", "2026-10-09T16:00:00.000Z"],
  ["both", "2026-10-10T04:00:00.000Z"],
  ["local-last-both", "2026-10-10T15:00:00.000Z"],
  ["utc-last-only", "2026-10-10T23:59:59.999Z"],
]) {
  await fs.writeFile(path.join(root, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, 'groupId: "g"', 'userId: "u"', "---", "", id].join("\n"), "utf8");
}
const lib = createMemoryLib({ dataRoot: tmp, workspaceRoot: tmp, principal: { group_id: "g", user_id: "u" }, resolvedRoots: [root], vectorLane: { probe: false } });

// 先确认 `listMemories` 到底有没有在过滤（没有的话下面所有"一致性"结论都是假的）。
const probes = {};
for (const [label, opts] of [
  ["no filters", {}],
  ["UTC day 10-10 (bare dates)", { since: "2026-10-10", until: "2026-10-10" }],
  ["explicit UTC instants", { since: "2026-10-10T00:00:00.000Z", until: "2026-10-10T23:59:59.999Z" }],
  ["only since 2026-06-01", { since: "2026-06-01" }],
]) {
  probes[label] = (await lib.listMemories({ limit: 100, ...opts })).map((i) => i.id).sort();
}
console.log("=== does listMemories filter at all? ===");
console.log(JSON.stringify(probes, null, 2));

const OUT = {};
for (const [label, since, until] of [["单日 10-10", "2026-10-10", "2026-10-10"], ["跨两日 10-10..10-11", "2026-10-10", "2026-10-11"]]) {
  const timeline = await lib.timeline({ since, until, calendarTimezone: "Asia/Shanghai", limit: 100 });
  const list = await lib.listMemories({ since, until, limit: 100 });
  const a = timeline.results.map((i) => i.id).sort();
  const b = list.map((i) => i.id).sort();
  OUT[label] = {
    timeline: a,
    listMemories: b,
    sameSet: JSON.stringify(a) === JSON.stringify(b),
    timelineResolved: { since: timeline.resolvedRange.since, untilExclusive: timeline.resolvedRange.untilExclusive },
    "listMemories 用（UTC 日）": {
      sinceUtc: new Date(`${since}T00:00:00.000Z`).toISOString(),
      untilUtcInclusive: new Date(`${until}T23:59:59.999Z`).toISOString(),
    },
  };
}
console.log(JSON.stringify(OUT, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
