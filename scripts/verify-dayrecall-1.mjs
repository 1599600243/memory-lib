#!/usr/bin/env node
/**
 * verify-dayrecall-1.mjs —— DAYRECALL-1 的**独立复核探针**（产品岗，非执行者）
 *
 * 与开发自带测试的差异（不是重跑它的测试）：
 *   · 用自己的夹具/日期/条数，**两端边界**都测（本地 00:30 与 23:30 都要在内；两侧邻居都要在外）
 *   · 断言 `calendarDate` 过滤与 `since/until` 枚举**集合与顺序完全一致**
 *   · **跨时区**：同一批数据在 `Asia/Shanghai` 与 `UTC` 下必须给出**不同**的当日集合（且差在预期的那几条）
 *   · **游标完整性**：解出游标内容核对 `(capturedAt,id)` 语义；翻页不重不漏
 *   · **翻页途中插入新条目**：按 keyset 语义核对（已翻过区间的不再出现、未翻区间的新条目会被看到）
 *
 * 用法：node verify-dayrecall-1.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const G = "dr1-group", U = "dr1-user";
const SH = "Asia/Shanghai";
// 本地（+08:00）2026-10-10 的边界：本地 00:30 = 10-09T16:30Z；本地 23:30 = 10-10T15:30Z
const FIX = [
  { id: "prev-day-2330", at: "2026-10-09T15:30:00.000Z", inSH: false },   // 本地 10-09 23:30
  { id: "day-start-0030", at: "2026-10-09T16:30:00.000Z", inSH: true },   // 本地 10-10 00:30
  { id: "mid-1200", at: "2026-10-10T04:00:00.000Z", inSH: true },         // 本地 10-10 12:00
  { id: "day-end-2330", at: "2026-10-10T15:30:00.000Z", inSH: true },     // 本地 10-10 23:30
  { id: "next-day-0030", at: "2026-10-10T16:30:00.000Z", inSH: false },   // 本地 10-11 00:30
  // 再塞 6 条到当天中部，制造翻页需求（合计 9 条属于本地 10-10）
  ...Array.from({ length: 6 }, (_, i) => ({ id: `bulk-${i}`, at: `2026-10-10T0${1 + (i % 5)}:${String(i * 7).padStart(2, "0")}:00.000Z`, inSH: true })),
];

const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };
const conv = (f) => ["---", `id: ${f.id}`, "type: conversation", `capturedAt: ${f.at}`, `groupId: ${G}`, `userId: ${U}`, "---", "", `夹具 ${f.id}`].join("\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dayrecall1-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
for (const f of FIX) await fs.writeFile(path.join(convRoot, `${f.id}.md`), conv(f), "utf8");

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
  const body = (extra) => ({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" }, ...extra });
  const post = async (route, extra) => {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(extra)) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ids = (rs) => (rs ?? []).map((x) => path.basename(String(x.path)).replace(/\.md$/u, ""));
  const full = async (extra) => {
    const first = await post("/v1/search", { limit: 3, ...extra });
    if (first.status !== 200) return { status: first.status, ids: [], total: null, body: first.body };
    let all = [...ids(first.body.results)];
    let cur = first.body.nextCursor ?? null, pages = 1;
    while (cur && pages < 30) { const p = await post("/v1/search", { limit: 3, cursor: cur, ...extra }); all = all.concat(ids(p.body?.results)); cur = p.body?.nextCursor ?? null; pages += 1; }
    return { status: 200, ids: all, total: first.body.total_count, pages };
  };

  console.log("== ① calendarDate 与 since/until 必须等价（集合 + 顺序）==");
  const byRange = await full({ since: "2026-10-10", until: "2026-10-10" });
  const byCal = await full({ calendarDate: "2026-10-10", calendarTimezone: SH });
  const expectIn = FIX.filter((f) => f.inSH).length;
  note(byRange.status === 200 && byCal.status === 200, `两者都 200（${byRange.status}/${byCal.status}）`);
  note(byCal.ids.length === expectIn, `calendarDate 取回 ${expectIn} 条（实际 ${byCal.ids.length}）`);
  note(JSON.stringify(byCal.ids) === JSON.stringify(byRange.ids), `与 since/until 的**集合与顺序一致**（${byCal.ids.length} vs ${byRange.ids.length}）`);
  note(byCal.total === byRange.total, `total_count 一致（${byCal.total} vs ${byRange.total}）`);

  console.log("\n== ② 两端边界 ==");
  const has = (x) => byCal.ids.includes(x);
  note(has("day-start-0030"), "本地 10/10 00:30 在内（左边界内）");
  note(has("day-end-2330"), "本地 10/10 23:30 在内（右边界内）");
  note(!has("prev-day-2330"), "本地 10/09 23:30 **不在**内（左邻被挡）");
  note(!has("next-day-0030"), "本地 10/11 00:30 **不在**内（右邻被挡）");

  console.log("\n== ③ 跨时区：同一批数据在 UTC 下当日集合必须不同 ==");
  const byUTC = await full({ calendarDate: "2026-10-10", calendarTimezone: "UTC" });
  const expectInUTC = FIX.filter((f) => f.at.startsWith("2026-10-10")).length;
  note(byUTC.ids.length === expectInUTC, `UTC 下的 10-10 取回 ${expectInUTC} 条（实际 ${byUTC.ids.length}）`);
  note(JSON.stringify(byUTC.ids) !== JSON.stringify(byCal.ids), "与 Asia/Shanghai 的集合**不同**（证明按查询时区重算）");
  note(!byUTC.ids.includes("day-start-0030") && byCal.ids.includes("day-start-0030"), "那条 10-09T16:30Z：在 UTC 下不属于 10-10，在 +08:00 下属于 10-10 ✔");

  console.log("\n== ④ 游标语义：解出来应是 (capturedAt,id)，且严格向前 ==");
  const p1 = await post("/v1/search", { calendarDate: "2026-10-10", calendarTimezone: SH, limit: 3 });
  const cur = p1.body?.nextCursor;
  let decoded = null;
  try { decoded = JSON.parse(Buffer.from(String(cur), "base64url").toString("utf8")); } catch {}
  note(Boolean(decoded), `游标可解析（${JSON.stringify(decoded)?.slice(0, 90)}）`);
  note(Boolean(decoded?.capturedAt && decoded?.id), "游标里带 capturedAt 与 id（keyset 而非纯偏移）");

  console.log("\n== ⑤ 翻页途中插入新条目：不重不漏（keyset 语义）==");
  const before = byCal.ids.length;
  // 翻第 1 页
  const page1 = await post("/v1/search", { calendarDate: "2026-10-10", calendarTimezone: SH, limit: 3 });
  const seen = [...ids(page1.body.results)];
  let cursor = page1.body?.nextCursor ?? null;
  // 插入两条：一条落在**已翻过**区间（比 page1 最后一条更早），一条落在**未翻**区间（比 page1 最后一条更晚）
  const sorted = [...FIX].filter((f) => f.inSH).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const early = { id: "inserted-early", at: sorted[0].at.slice(0, 11) + "00:00:01.000Z" };   // 与第一条同小时但更晚一点点 → 仍在已翻区间
  const late = { id: "inserted-late", at: "2026-10-10T14:00:00.000Z" };                      // 未翻区间
  await fs.writeFile(path.join(convRoot, `${early.id}.md`), conv({ ...early, inSH: true }), "utf8");
  await fs.writeFile(path.join(convRoot, `${late.id}.md`), conv({ ...late, inSH: true }), "utf8");
  // 触发一次增量索引（捕获一条当天之外的条目，避免污染当天集合）
  await post("/v1/conversations/capture", { source: "verify-dayrecall1", conversation_id: "verify-idx", event_id: "verify-idx", messages: [{ role: "user", content: "force index" }] });
  await new Promise((r) => setTimeout(r, 2000));
  let pages = 1;
  while (cursor && pages < 30) { const p = await post("/v1/search", { calendarDate: "2026-10-10", calendarTimezone: SH, limit: 3, cursor }); seen.push(...ids(p.body?.results)); cursor = p.body?.nextCursor ?? null; pages += 1; }
  const dupes = seen.filter((x, i) => seen.indexOf(x) !== i);
  const preExisting = sorted.map((f) => f.id);
  const missing = preExisting.filter((x) => !seen.includes(x));
  note(dupes.length === 0, `翻页过程**无重复**（重复 ${dupes.length} 条${dupes.length ? "：" + dupes.join(",") : ""}）`);
  note(missing.length === 0, `原有 ${preExisting.length} 条**一条不漏**（缺 ${missing.length}${missing.length ? "：" + missing.join(",") : ""}）`);
  console.log(`     [观察] 插入的两条是否被本轮看到：early=${seen.includes("inserted-early")} late=${seen.includes("inserted-late")}（keyset 语义下 late 应可见、early 不应出现）`);
  note(!seen.includes("inserted-early"), "已翻过区间插入的条目**没有**被重复带出（无跳行/重复）");

  console.log("\n== ⑥ 不认得的输入必须明确失败（不许退化成枚举一切）==");
  const bad = await post("/v1/search", { calendarDate: "2026-13-45", calendarTimezone: SH, limit: 3 });
  note(bad.status >= 400 || bad.body?.ok === false, `非法日历日被拒（status=${bad.status} code=${bad.body?.error?.code ?? "-"}）`);
  const none = await post("/v1/search", { limit: 3 });
  note(none.status === 400, `无 query 也无任何时间条件 ⇒ 400（实际 ${none.status}）`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— DAYRECALL-1 独立复核通过（日历日↔范围等价 / 两端边界 / 跨时区重算 / keyset 游标不重不漏 / 非法输入被拒）");
