#!/usr/bin/env node
/**
 * verify-m21b2.mjs —— M2.1-B2（更开放的时间表达，纯规则）的**独立复核探针**（产品岗，非执行者）
 *
 * 与开发自带测试的差异：
 *   · 用**自己的参照时刻**逐条核对**绝对区间**（不是只看 ok:true）
 *   · 覆盖它这一单新开的语法：N天前（含中文数字）/ 最近N天 / 大前天 / 上周 / 上上周 / 上个月N号 /
 *     区间（上周一到上周三、10月1号到10月7号）/ 未来（明天、后天、下周三、下个月）/ 口语尾巴（10/10 那天）
 *   · **反例**：它报告里说刻意拒绝的输入（"我3天前买的"、"大概三天前吧"、"下下周一下班"）必须仍然失败
 *   · 统一的硬规则：所有区间都是**本地半开区间**（起点本地零点、终点次日零点），不是 23:59:59.999
 *   · 确定性：同输入同 now 重放一致
 *   · 端到端：解析"昨天"→ 按天枚举 → 取回那一天夹具的全部条目
 *
 * 用法：node verify-m21b2.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const G = "b2-group", U = "b2-user", SH = "Asia/Shanghai";
// 参照时刻：本地 2026-10-15（周四）12:00 ⇒ 昨天 = 10-14，前天 = 10-13，大前天 = 10-12
const NOW = "2026-10-15T04:00:00.000Z";
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };
const localDayStart = (y, m, d) => { // 本地 y-m-d 00:00 → UTC ISO
  const ms = Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600000;
  return new Date(ms).toISOString();
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "m21b2-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
// 昨天（本地 10-14）放 4 条，用于端到端
const YESTERDAY = ["2026-10-13T16:30:00.000Z", "2026-10-14T02:00:00.000Z", "2026-10-14T10:00:00.000Z", "2026-10-14T15:30:00.000Z"];
for (const [i, at] of YESTERDAY.entries()) {
  await fs.writeFile(path.join(convRoot, `y-${i}.md`), ["---", `id: y-${i}`, "type: conversation", `capturedAt: ${at}`, `groupId: ${G}`, `userId: ${U}`, "---", "", `夹具 y-${i}`].join("\n"), "utf8");
}
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
  const post = async (route, extra) => {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" }, ...extra }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const res = (text, extra = {}) => post("/v1/date/resolve", { text, now: NOW, timezone: SH, ...extra });
  const R = (b) => b?.resolvedRange ?? b?.range ?? null;
  const days = (r) => (r ? (Date.parse(r.untilExclusive ?? r.until) - Date.parse(r.since)) / 86400000 : null);
  const okRange = (label, r, expectSince, expectDays) => {
    if (!r) return note(false, `${label}：没返回范围`);
    note(r.since === expectSince, `${label}：起点 = ${expectSince}（实际 ${r.since}）`);
    if (expectDays !== null) note(Math.abs(days(r) - expectDays) < 0.01, `${label}：跨度 ${expectDays} 天（实际 ${days(r)} 天）`);
    if (r.untilExclusive) note(!String(r.untilExclusive).includes("23:59:59"), `${label}：终点是次日零点（半开），不是 23:59:59.999`);
  };

  console.log("== ① 相对日：N天前（含中文数字）/ 大前天 / 最近N天 ==");
  const d3 = await res("三天前");           // now 本地 10-15 ⇒ 10-12
  note(d3.status === 200, `「三天前」解析成功（status=${d3.status}）`);
  okRange("三天前", R(d3.body), localDayStart(2026, 10, 12), 1);
  const d3a = await res("3天前");
  note(JSON.stringify(R(d3a.body)) === JSON.stringify(R(d3.body)), "「3天前」与「三天前」结果一致");
  const d30 = await res("三十天前");
  okRange("三十天前", R(d30.body), localDayStart(2026, 9, 15), 1);
  const dq = await res("大前天");
  okRange("大前天", R(dq.body), localDayStart(2026, 10, 12), 1);
  const recent = await res("最近三天");
  note(recent.status === 200, `「最近三天」解析成功（status=${recent.status}）`);
  note(Math.abs((days(R(recent.body)) ?? 0) - 3) < 0.01, `「最近三天」跨度 3 天（实际 ${days(R(recent.body))} 天）`);
  note(R(recent.body)?.untilExclusive === localDayStart(2026, 10, 16), `「最近三天」右端到"明天零点"（实际 ${R(recent.body)?.untilExclusive}）`);

  console.log("\n== ② 相对周 / 月 ==");
  const lastWeek = await res("上周");     // now 本地 10-15（周四）⇒ 上周 = 本地 10-05(周一) ~ 10-12(周一)
  note(lastWeek.status === 200, `「上周」解析成功（status=${lastWeek.status}）`);
  note(Math.abs((days(R(lastWeek.body)) ?? 0) - 7) < 0.01, `「上周」跨度 7 天（实际 ${days(R(lastWeek.body))} 天）`);
  const lw2 = await res("上上周");
  note(lw2.status === 200 && (days(R(lw2.body)) ?? 0) === 7, `「上上周」也是 7 天（status=${lw2.status}）`);
  const lm = await res("上个月15号");
  note(lm.status === 200, `「上个月15号」解析成功（status=${lm.status}）`);
  okRange("上个月15号", R(lm.body), localDayStart(2026, 9, 15), 1);

  console.log("\n== ③ 区间 ==");
  const span1 = await res("上周一到上周三");
  note(span1.status === 200, `「上周一到上周三」解析成功（status=${span1.status}）`);
  note(Math.abs((days(R(span1.body)) ?? 0) - 3) < 0.01, `区间跨度 3 天（实际 ${days(R(span1.body))} 天）`);
  const span2 = await res("10月1号到10月7号");
  note(span2.status === 200 && Math.abs((days(R(span2.body)) ?? 0) - 7) < 0.01, `「10月1号到10月7号」跨度 7 天（实际 ${days(R(span2.body))} 天）`);

  console.log("\n== ④ 未来表达（记忆检索多问过去，但未来必须算对）==");
  const tmr = await res("明天");
  okRange("明天", R(tmr.body), localDayStart(2026, 10, 16), 1);
  const dy = await res("后天");
  okRange("后天", R(dy.body), localDayStart(2026, 10, 17), 1);
  const nw = await res("下周三");           // 本地 10-15 是周四 ⇒ 下周三 = 10-21
  note(nw.status === 200, `「下周三」解析成功（status=${nw.status}）`);
  note(Date.parse(R(nw.body)?.since ?? 0) > Date.parse(NOW), `「下周三」确实在 now 之后（${R(nw.body)?.since}）`);
  const nm = await res("下个月");
  note(nm.status === 200, `「下个月」解析成功（status=${nm.status}）`);
  note(Math.abs((days(R(nm.body)) ?? 0) - 30) < 1.01, `「下个月」跨度约一个月（实际 ${days(R(nm.body))} 天）`);

  console.log("\n== ⑤ 口语尾巴 ==");
  const tail1 = await res("10/10 那天");
  const bare = await res("10/10");
  note(tail1.status === 200, `「10/10 那天」解析成功（status=${tail1.status}）`);
  note(JSON.stringify(R(tail1.body)) === JSON.stringify(R(bare.body)), "「10/10 那天」与裸「10/10」结果一致");
  const tail2 = await res("10 月 10 号那天聊了什么");
  note(tail2.status === 200 && JSON.stringify(R(tail2.body)) === JSON.stringify(R(bare.body)), "「10 月 10 号那天聊了什么」也一致");

  console.log("\n== ⑥ 反例：它报告里说刻意拒绝的，必须仍然失败 ==");
  for (const s of ["我3天前买的", "大概三天前吧", "下下周一下午", "上个月那件大事", "2/30"]) {
    const r = await res(s);
    note(r.status === 422, `「${s}」必须失败（status=${r.status}）`);
    note(!R(r.body), `「${s}」失败时**没有范围**`);
  }

  console.log("\n== ⑦ 确定性：同输入同 now 重放一致 ==");
  const r1 = await res("最近三天");
  const r2 = await res("最近三天");
  note(JSON.stringify(R(r1.body)) === JSON.stringify(R(r2.body)), "重放一致");

  console.log("\n== ⑧ 端到端：昨天 → 按天枚举 → 取回该日全部条目 ==");
  const y = await res("昨天");
  const cal = y.body?.calendarDate ?? null;
  const q = await post("/v1/search", cal ? { calendarDate: cal, calendarTimezone: SH, limit: 50 } : { since: "2026-10-14", until: "2026-10-14", limit: 50 });
  const got = (q.body?.results ?? []).filter((x) => /evidence[\\/]conversations/u.test(String(x.path)));
  note(got.length === YESTERDAY.length, `「昨天」解析出的 ${cal} 取回全部 ${YESTERDAY.length} 条（实际 ${got.length}）`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— M2.1-B2 独立复核通过（相对日/周/月 · 区间 · 未来 · 口语尾巴 · 反例不误判 · 半开区间 · 确定性 · 端到端）");
