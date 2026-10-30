// DAY-INTERVAL-1 探针：`listMemories`（/v1/memory/list）到底是不是也统一了？
// 方法：把 4 条夹具分两类打印 —— 谁的答案会因"UTC 日 vs 上海本地日"而不同。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "day-interval-list2-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });

// 四个关键瞬时，各自说明它在两种解释下的归属：
const CASES = [
  ["A 10-09T18:00Z", "2026-10-09T18:00:00.000Z", "UTC日10-10=否 / 上海本地日10-10=是"],
  ["B 10-10T04:00Z", "2026-10-10T04:00:00.000Z", "UTC日10-10=是 / 上海本地日10-10=是"],
  ["C 10-10T15:00Z", "2026-10-10T15:00:00.000Z", "UTC日10-10=是 / 上海本地日10-10=是"],
  ["D 10-10T16:00Z", "2026-10-10T16:00:00.000Z", "UTC日10-10=是(恰在上界) / 上海本地日10-10=否"],
];
for (const [id, capturedAt] of CASES) {
  await fs.writeFile(path.join(root, `${id.split(" ")[0]}.md`), ["---", `id: ${id.split(" ")[0]}`, "type: conversation", `capturedAt: ${capturedAt}`, 'groupId: "g"', 'userId: "u"', "---", "", id].join("\n"), "utf8");
}
const lib = createMemoryLib({ dataRoot: tmp, workspaceRoot: tmp, principal: { group_id: "g", user_id: "u" }, resolvedRoots: [root], vectorLane: { probe: false } });

const timeline = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai", limit: 100 });
const list = await lib.listMemories({ since: "2026-10-10", until: "2026-10-10", limit: 100 });
const searchEvidence = await lib.search({ query: "", since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai", limit: 100, searchMode: "evidence" });

console.log(JSON.stringify({
  cases: CASES.map(([id, at, note]) => ({ id: id.split(" ")[0], capturedAt: at, note })),
  "search() 空 query（HTTP /v1/search 实际走的路径）": { ids: (searchEvidence ?? []).map((i) => i.id) },
  "timeline()": { ids: timeline.results.map((i) => i.id), resolvedRange: timeline.resolvedRange },
  "listMemories()（/v1/memory/list）": { ids: list.map((i) => i.id) },
}, null, 2));

await fs.rm(tmp, { recursive: true, force: true });
