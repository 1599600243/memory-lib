// DAY-INTERVAL-1 探针：确认 `listMemories`（/v1/memory/list）是否也统一了。
// 单子只点名 /v1/search 的两个入口，但"没统一的地方"必须**核实过**再写进报告。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "day-interval-list-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });
// 夹具刻意做到**判别性**：UTC 日窗口 [10-10T00:00Z, 10-11T00:00Z) 与
// 上海本地日窗口 [10-09T16:00Z, 10-10T16:00Z) 必须选出**不同**的集合，否则等于没测。
for (const [id, capturedAt] of [
  ["utc-inside-local-outside", "2026-10-09T18:00:00.000Z"], // UTC 10-09（UTC 窗口外）；上海本地 10-10 02:00（本地窗口内）
  ["in-both", "2026-10-10T04:00:00.000Z"],                  // 两个窗口都算 10-10
  ["local-inside-utc-outside", "2026-10-10T15:00:00.000Z"], // UTC 仍是 10-10（UTC 窗口内）；上海本地已是 10-10 23:00（本地窗口内）
  ["utc-inside-local-outside-2", "2026-10-10T00:30:00.000Z"], // UTC 10-10 00:30（UTC 窗口内）；上海本地 10-10 08:30（本地窗口内）
]) {
  await fs.writeFile(path.join(root, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, 'groupId: "g"', 'userId: "u"', "---", "", id].join("\n"), "utf8");
}
const lib = createMemoryLib({ dataRoot: tmp, workspaceRoot: tmp, principal: { group_id: "g", user_id: "u" }, resolvedRoots: [root], vectorLane: { probe: false } });

const viaTimeline = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai", limit: 100 });
const viaList = await lib.listMemories({ since: "2026-10-10", until: "2026-10-10", limit: 100 });

console.log(JSON.stringify({
  timeline_search: {
    ids: viaTimeline.results.map((i) => i.id),
    resolvedRange: viaTimeline.resolvedRange,
  },
  memory_list: {
    ids: viaList.map((i) => i.id),
    note: "listMemories 没有 resolvedRange 回显，也没有 calendarTimezone 参数",
  },
  consistent: JSON.stringify(viaTimeline.results.map((i) => i.id).sort()) === JSON.stringify(viaList.map((i) => i.id).sort()),
}, null, 2));

await fs.rm(tmp, { recursive: true, force: true });
