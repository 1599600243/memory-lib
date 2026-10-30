// DAY-INTERVAL-1 探针：记录修复前两条入口各自的边界语义。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "day-interval-probe-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });
// 边界邻居 + 本地日内两点（Asia/Shanghai = UTC+8）
const FIXTURES = [
  ["local-prev-2330", "2026-10-09T15:30:00.000Z"], // 本地 10-09 23:30（前一日）
  ["local-0030", "2026-10-09T16:30:00.000Z"],      // 本地 10-10 00:30
  ["local-1200", "2026-10-10T04:00:00.000Z"],      // 本地 10-10 12:00
  ["local-2330", "2026-10-10T15:30:00.000Z"],      // 本地 10-10 23:30
  ["local-next-0030", "2026-10-10T16:30:00.000Z"], // 本地 10-11 00:30（次日）
  ["local-next-lastms", "2026-10-10T15:59:59.999Z"], // 本地 10-10 23:59:59.999
];
for (const [id, capturedAt] of FIXTURES) {
  await fs.writeFile(path.join(root, `${id}.md`), [
    "---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`,
    'groupId: "g"', 'userId: "u"', 'calendarDate: "' + capturedAt.slice(0, 10) + '"', 'calendarTimezone: "UTC"',
    "---", "", `body ${id}`,
  ].join("\n"), "utf8");
}

const lib = createMemoryLib({
  dataRoot: tmp, workspaceRoot: tmp,
  principal: { group_id: "g", user_id: "u" },
  resolvedRoots: [root], vectorLane: { probe: false },
});

async function ids(options) {
  const page = await lib.timeline({ limit: 100, ...options });
  return { ids: (page.results ?? []).map((item) => item.id), resolvedRange: page.resolvedRange };
}

console.log(JSON.stringify({
  fixtures: FIXTURES,
  "A) since/until bare dates (UTC day, today's semantics)": await ids({ since: "2026-10-10", until: "2026-10-10" }),
  "B) calendarDate UTC": await ids({ calendarDate: "2026-10-10", calendarTimezone: "UTC" }),
  "B) calendarDate Asia/Shanghai": await ids({ calendarDate: "2026-10-10", calendarTimezone: "Asia/Shanghai" }),
  "A) since/until + calendarTimezone Asia/Shanghai (does the tz reach bare dates?)": await ids({ since: "2026-10-10", until: "2026-10-10", calendarTimezone: "Asia/Shanghai" }),
  "C) until with explicit time (instant upper bound)": await ids({ since: "2026-10-10T00:00:00.000Z", until: "2026-10-10T16:00:00.000Z" }),
}, null, 2));

await fs.rm(tmp, { recursive: true, force: true });
