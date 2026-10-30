// DAY-INTERVAL-1 探针：改完后直接看两条入口各自的输出。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const FIXTURES = [
  ["prev-local-2330", "2026-10-09T15:30:00.000Z"],
  ["local-0000", "2026-10-09T16:00:00.000Z"],
  ["local-0030", "2026-10-09T16:30:00.000Z"],
  ["local-1200", "2026-10-10T04:00:00.000Z"],
  ["local-2330", "2026-10-10T15:30:00.000Z"],
  ["local-lastms", "2026-10-10T15:59:59.999Z"],
  ["next-local-0000", "2026-10-10T16:00:00.000Z"],
  ["next-local-0030", "2026-10-10T16:30:00.000Z"],
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "day-interval-probe2-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });
for (const [id, capturedAt] of FIXTURES) {
  await fs.writeFile(path.join(root, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, 'groupId: "g"', 'userId: "u"', "---", "", id].join("\n"), "utf8");
}
const lib = createMemoryLib({ dataRoot: tmp, workspaceRoot: tmp, principal: { group_id: "g", user_id: "u" }, resolvedRoots: [root], vectorLane: { probe: false } });

async function show(label, options) {
  const page = await lib.timeline({ limit: 100, ...options });
  console.log(`${label}\n  ids      = ${JSON.stringify((page.results ?? []).map((i) => i.id))}\n  resolved = ${JSON.stringify(page.resolvedRange)}`);
}
for (const tz of ["Asia/Shanghai", "UTC"]) {
  console.log(`──── ${tz} ────`);
  await show("A since/until bare", { since: "2026-10-10", until: "2026-10-10", calendarTimezone: tz });
  await show("B calendarDate", { calendarDate: "2026-10-10", calendarTimezone: tz });
}
await fs.rm(tmp, { recursive: true, force: true });
