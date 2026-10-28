// SCENARIO-2-FOLLOWUP 探针：这条 `layer:role` + `occurred_at:""` + 无 `type` 的经验条
// 到底被哪一层判据挡掉了？
//
// 方法：造一个**最小夹具**，逐字复刻争议条目的形状（只改 id 与正文以免与真实文件混淆），
// 放进与生产相同的容器路径 `curated/agents/pilot-01/`，然后：
//   ① 用 timeline()（按天枚举）看它在不在；
//   ② 若不在，逐个把上游判据单独跑一遍，指出是哪一层。
//
// 只读、自建临时 dataRoot，不碰生产。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const SH = "Asia/Shanghai";
// 争议文件正好落在这两个边界之间：本地 09-24 = [09-23T16:00Z, 09-24T16:00Z)
const WINDOW = { since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z" };
const DISPUTED_UPDATED_AT = "2026-09-23T19:04:46.615Z"; // 本地 09-24 03:04

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "s2f-membership-"));
const dataRoot = path.join(tmp, "memory");
const roleDir = path.join(dataRoot, "curated", "agents", "pilot-01");
await fs.mkdir(roleDir, { recursive: true });

// 逐字复刻争议条目的 frontmatter（含 omitted type、空 occurred_at、空 evidence_refs）
const disputed = [
  "---",
  'id: "role-probe-disputed"',
  'layer: "role"',
  'agent_id: "pilot-01"',
  'role_id: "researcher"',
  'kind: "lesson"',
  'confidence: "high"',
  'status: "active"',
  "superseded_by: null",
  'occurred_at: ""',
  `updated_at: "${DISPUTED_UPDATED_AT}"`,
  "tags: []",
  "evidence_refs: []",
  'tenant_id: "default"',
  'container: "role"',
  'visibility: "role"',
  "---",
  "",
  "## 经验",
  "",
  "PROBE-DISPUTED-ENTRY",
  "",
].join("\n");
await fs.writeFile(path.join(roleDir, "role-probe-disputed.md"), disputed, "utf8");

// 对照组 A：同目录、有 type: conversation、capturedAt 落在同一窗口（应被召回）
const withType = [
  "---", 'id: "role-probe-withtype"', 'type: conversation', 'layer: "role"',
  'capturedAt: "2026-09-24T02:00:00.000Z"', 'agent_id: "pilot-01"', 'role_id: "researcher"',
  'groupId: "home-circle"', 'userId: "user-owner"', 'status: "active"',
  'tenant_id: "default"', 'container: "role"', 'visibility: "role"', "---", "", "PROBE-WITH-TYPE", "",
].join("\n");
await fs.writeFile(path.join(roleDir, "role-probe-withtype.md"), withType, "utf8");

// 对照组 B：同目录、无 type、但有非空 occurred_at
const withOccurredAt = disputed
  .replace('id: "role-probe-disputed"', 'id: "role-probe-occurred"')
  .replace('occurred_at: ""', 'occurred_at: "2026-09-24T02:30:00.000Z"')
  .replace("PROBE-DISPUTED-ENTRY", "PROBE-WITH-OCCURRED-AT");
await fs.writeFile(path.join(roleDir, "role-probe-occurred.md"), withOccurredAt, "utf8");

const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: "researcher", group_id: "home-circle", user_id: "user-owner" };
const lib = createMemoryLib({
  dataRoot, workspaceRoot: tmp, principal,
  resolvedRoots: [dataRoot], vectorLane: { probe: false },
});

const page = await lib.timeline({ ...WINDOW, calendarTimezone: SH, limit: 100 });
const ids = page.results.map((item) => item.id);
console.log(JSON.stringify({
  window: WINDOW,
  total_count: page.total_count,
  returnedIds: ids,
  disputedReturned: ids.includes("role-probe-disputed"),
  withTypeReturned: ids.includes("role-probe-withtype"),
  withOccurredAtReturned: ids.includes("role-probe-occurred"),
}, null, 2));

await fs.rm(tmp, { recursive: true, force: true });
