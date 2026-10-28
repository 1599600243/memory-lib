#!/usr/bin/env node
/**
 * verify-day-interval-1.mjs —— DAY-INTERVAL-1 的**独立复核探针**（产品岗，非执行者）
 *
 * 这一单要证明的只有一件事：**"取某一天"的两条入口语义完全一致**，且**不许漏掉正好落在本地零点的条目**
 * （开发自己测出旧 `since/until` 路径会漏 `00:00.000` 那条）。
 *
 * 判据（都是我自己的夹具，不用它那份）：
 *   ① 夹具里**故意放一条正好在本地 00:00:00.000** 的条目 —— 两条入口都必须包含它
 *   ② `{since,until}` 纯日期 与 `{calendarDate}` 的**集合与顺序完全一致**
 *   ③ 两端边界：本地 00:30 与 23:30 都在内；本地 10/09 23:30 与 10/11 00:30 都在外
 *   ④ **带时间的上界仍是"瞬时"**：不许被当成"整天"扩展开（给一个 1 小时窗口，只应取回窗口内那条）
 *   ⑤ 两条入口的 `total_count` 一致
 *
 * 用法：node verify-day-interval-1.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const G = "di1-group", U = "di1-user", SH = "Asia/Shanghai";
// 本地 2026-10-10 = UTC [10-09T16:00, 10-10T16:00)
const FIX = [
  ["exact-midnight", "2026-10-09T16:00:00.000Z"],   // ← **正好本地 00:00:00.000**（旧 since/until 漏的就是这种）
  ["edge-0030", "2026-10-09T16:30:00.000Z"],
  ["mid-1200", "2026-10-10T04:00:00.000Z"],
  ["edge-2330", "2026-10-10T15:30:00.000Z"],
  ["prev-day-2330", "2026-10-09T15:30:00.000Z"],
  ["next-day-0030", "2026-10-10T16:30:00.000Z"],
];
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };
const conv = (id, at) => ["---", `id: ${id}`, "type: conversation", `capturedAt: ${at}`, `groupId: ${G}`, `userId: ${U}`, "---", "", `夹具 ${id}`].join("\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "di1-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
for (const [id, at] of FIX) await fs.writeFile(path.join(convRoot, `${id}.md`), conv(id, at), "utf8");

const auth = await createTestAuth(REPO, tmp);
const reg = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const role = reg.frameworks[0].agents.find((a) => a.agent_id === "pilot-01").roles.find((r) => r.role_id === "researcher");
role.group_id = G; role.user_id = U;
await fs.writeFile(auth.registryPath, `${JSON.stringify(reg, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: SH,
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});

try {
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = async (extra) => {
    const r = await fetch(base + "/v1/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" }, limit: 50, offset: 0, ...extra }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const idsOf = (b) => (b?.results ?? []).map((x) => path.basename(String(x.path)).replace(/\.md$/u, ""));

  console.log("== ① 正好落在本地 00:00:00.000 的条目：两条入口都必须包含 ==");
  const byRange = await post({ since: "2026-10-10", until: "2026-10-10" });
  const byCal = await post({ calendarDate: "2026-10-10", calendarTimezone: SH });
  note(byRange.status === 200 && byCal.status === 200, `两条入口都 200（${byRange.status}/${byCal.status}）`);
  const rIds = idsOf(byRange.body), cIds = idsOf(byCal.body);
  note(rIds.includes("exact-midnight"), `since/until 路径**包含** exact-midnight（实际 ${rIds.length} 条：${rIds.slice(0, 4).join(",")}）`);
  note(cIds.includes("exact-midnight"), `calendarDate 路径**包含** exact-midnight（实际 ${cIds.length} 条）`);

  console.log("\n== ② 两条入口的集合与顺序必须完全一致 ==");
  note(JSON.stringify(rIds) === JSON.stringify(cIds), `集合与顺序一致（${rIds.length} vs ${cIds.length}）`);
  note(byRange.body?.total_count === byCal.body?.total_count, `total_count 一致（${byRange.body?.total_count} vs ${byCal.body?.total_count}）`);

  console.log("\n== ③ 两端边界 ==");
  const expectIn = ["exact-midnight", "edge-0030", "mid-1200", "edge-2330"];
  note(expectIn.every((x) => rIds.includes(x)), `应在本日的 4 条全在内（缺 ${expectIn.filter((x) => !rIds.includes(x)).join(",") || "无"}）`);
  note(!rIds.includes("prev-day-2330") && !rIds.includes("next-day-0030"), "两侧邻居（10/09 23:30、10/11 00:30）都在外");

  console.log("\n== ④ 带时间的上界仍是「瞬时」，不许被当成整天扩展 ==");
  // 本地 10-10 12:00(+08) = 04:00Z；给 04:00Z→05:00Z 一小时窗口，只应有 mid-1200
  const windowed = await post({ since: "2026-10-10T04:00:00.000Z", until: "2026-10-10T05:00:00.000Z" });
  const wIds = idsOf(windowed.body);
  note(windowed.status === 200, `带时间窗口查询 200（实际 ${windowed.status}）`);
  note(wIds.length === 1 && wIds[0] === "mid-1200", `一小时窗口只取回 1 条（实际 ${wIds.length} 条：${wIds.join(",")}）`);
  note(!wIds.includes("exact-midnight") && !wIds.includes("edge-2330"), "窗口外的当天其它条目**没有**被带进来（说明带时间的上界没被扩展成整天）");

  console.log("\n== ⑤ 跨天查询不会漏掉第二天的零点条目 ==");
  const twoDays = await post({ since: "2026-10-10", until: "2026-10-11" });
  const twoIds = idsOf(twoDays.body);
  note(twoIds.includes("exact-midnight") && twoIds.includes("next-day-0030"), `10/10~10/11 两天：两天的零点条目都在（${twoIds.length} 条）`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— DAY-INTERVAL-1 独立复核通过（零点条目不漏 / 两条入口等价 / 两端边界 / 带时间上界不扩展 / 跨天不漏）");
