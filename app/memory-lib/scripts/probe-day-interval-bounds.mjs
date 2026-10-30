// DAY-INTERVAL-1 探针 4：把 `parseBoundary` / `filterByOccurredTime` 的真实取值打出来，
// 弄清 `listMemories` 的纯日期到底是什么口径。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "probe-bounds-"));
const root = path.join(tmp, "evidence", "conversations");
await fs.mkdir(root, { recursive: true });
const rows = [
  ["local-first", "2026-10-09T16:00:00.000Z"],
  ["both", "2026-10-10T04:00:00.000Z"],
  ["utc-last", "2026-10-10T23:59:59.999Z"],
];
for (const [id, at] of rows) {
  await fs.writeFile(path.join(root, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${at}`, 'groupId: "g"', 'userId: "u"', "---", "", id].join("\n"), "utf8");
}
const lib = createMemoryLib({ dataRoot: tmp, workspaceRoot: tmp, principal: { group_id: "g", user_id: "u" }, resolvedRoots: [root], vectorLane: { probe: false } });

// 直接看 Node 对几种写法的解析（这是 parseBoundary 用的同一套）
const parse = (text) => Date.parse(text);
console.log("=== Date.parse（与 parseTimestamp 同源） ===");
for (const text of [
  "2026-10-10",
  "2026-10-10T00:00:00.000",
  "2026-10-10T00:00:00.000Z",
  "2026-10-10T23:59:59.999",
  "2026-10-10T23:59:59.999Z",
]) {
  const ms = parse(text);
  console.log(`  ${text.padEnd(28)} -> ${Number.isFinite(ms) ? new Date(ms).toISOString() : "NaN"}`);
}
console.log("  process.env.TZ =", process.env.TZ ?? "(unset)");
console.log("  new Date().getTimezoneOffset() =", new Date().getTimezoneOffset(), "(分钟；-480 = UTC+8)");

console.log("\n=== listMemories 实测 ===");
for (const [label, opts] of [
  ["no filters", {}],
  ["bare 2026-10-10..2026-10-10", { since: "2026-10-10", until: "2026-10-10" }],
  ["explicit UTC instants", { since: "2026-10-10T00:00:00.000Z", until: "2026-10-10T23:59:59.999Z" }],
]) {
  const ids = (await lib.listMemories({ limit: 100, ...opts })).map((i) => i.id).sort();
  console.log(`  ${label.padEnd(32)} -> ${JSON.stringify(ids)}`);
}
await fs.rm(tmp, { recursive: true, force: true });
