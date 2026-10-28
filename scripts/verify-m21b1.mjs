#!/usr/bin/env node
/**
 * verify-m21b1.mjs —— M2.1-B1（纯规则日期归一）的**独立复核探针**（产品岗，非执行者）
 *
 * 与开发自带测试的差异（不是重跑它的测试）：
 *   · 用**自己的参照时刻与日期**，并**逐条核对绝对区间**（不是只看 ok:true）
 *   · 重点打它可能偷懒的地方：`now` 必填、缺年必须标 yearInferred、半开区间必须精确到次日零点、
 *     `2/30` 必须失败、`10/11` 必须给候选而不许合并两天、普通数字不许被当日期
 *   · 端到端：把解析出的范围**真的拿去查库**（夹具日 9 条必须全取回）
 *
 * 用法：node verify-m21b1.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const G = "b1-group", U = "b1-user", SH = "Asia/Shanghai";
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "m21b1-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
// 本地 2026-10-10 那天放 9 条（含两端边界），用于端到端
const DAY = [
  ["d-0030", "2026-10-09T16:30:00.000Z"], ["d-1200", "2026-10-10T04:00:00.000Z"], ["d-2330", "2026-10-10T15:30:00.000Z"],
  ...Array.from({ length: 6 }, (_, i) => [`d-bulk-${i}`, `2026-10-10T0${1 + i}:00:00.000Z`]),
];
for (const [id, at] of DAY) {
  await fs.writeFile(path.join(convRoot, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${at}`, `groupId: ${G}`, `userId: ${U}`, "---", "", `夹具 ${id}`].join("\n"), "utf8");
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
    const r = await fetch(base + route, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" }, ...extra }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const resolveAt = (text, now, extra = {}) => post("/v1/date/resolve", { text, now, timezone: SH, ...extra });
  const rangeOf = (b) => b?.resolvedRange ?? b?.range ?? null;

  console.log("== ① `now` 必填（平台不许猜“现在”）==");
  const noNow = await post("/v1/date/resolve", { text: "今天", timezone: SH });
  note(noNow.status === 400, `不给 now ⇒ 400（实际 ${noNow.status}）`);
  const noText = await post("/v1/date/resolve", { now: "2026-10-10T02:00:00.000Z", timezone: SH });
  note(noText.status === 400, `不给 text ⇒ 400（实际 ${noText.status}）`);

  console.log("\n== ② 绝对日期：区间必须精确到本地日零点（半开）==");
  const abs = await resolveAt("2026-10-10", "2026-06-01T00:00:00.000Z");
  note(abs.status === 200 && abs.body?.ok === true, `2026-10-10 → 200（实际 ${abs.status}）`);
  const r1 = rangeOf(abs.body);
  note(r1?.since === "2026-10-09T16:00:00.000Z", `since = 本地 10/10 00:00（实际 ${r1?.since}）`);
  note(r1?.untilExclusive === "2026-10-10T16:00:00.000Z", `untilExclusive = 次日 00:00（实际 ${r1?.untilExclusive}）`);
  note(!String(r1?.untilExclusive ?? "").includes("23:59:59"), "**不是** 23:59:59.999（半开区间 ✔）");
  note(abs.body?.yearInferred === false, `yearInferred = false（实际 ${abs.body?.yearInferred}）`);

  console.log("\n== ③ 缺年必须标出来，且取 now 所在年份 ==");
  const noYear = await resolveAt("10/10", "2026-06-01T00:00:00.000Z");
  note(noYear.status === 200, `10/10 → 200（实际 ${noYear.status}）`);
  note(noYear.body?.yearInferred === true, `yearInferred = true（实际 ${noYear.body?.yearInferred}）`);
  note(rangeOf(noYear.body)?.since === "2026-10-09T16:00:00.000Z", `补出的年份 = now 的年份 2026（实际 ${rangeOf(noYear.body)?.since}）`);
  // 换一个 now（2027 年）应补成 2027
  const noYear27 = await resolveAt("10/10", "2027-03-01T00:00:00.000Z");
  note(rangeOf(noYear27.body)?.since === "2027-10-09T16:00:00.000Z", `换 now=2027 后补成 2027（实际 ${rangeOf(noYear27.body)?.since}）`);

  console.log("\n== ④ 相对日期：昨天 / 前天 ==");
  const yest = await resolveAt("昨天", "2026-10-10T15:30:00.000Z");   // 本地 10-10 23:30
  note(rangeOf(yest.body)?.since === "2026-10-08T16:00:00.000Z", `昨天（now=本地10/10 23:30）⇒ 本地 10/09（实际 ${rangeOf(yest.body)?.since}）`);
  const before = await resolveAt("前天", "2026-10-10T02:00:00.000Z"); // 本地 10-10 10:00
  note(rangeOf(before.body)?.since === "2026-10-07T16:00:00.000Z", `前天 ⇒ 本地 10/08（实际 ${rangeOf(before.body)?.since}）`);

  console.log("\n== ⑤ 严格日历：非法日期必须失败，不许滚动 ==");
  for (const bad of ["2/30", "2026-02-30", "13/45", "2026-13-45"]) {
    const r = await resolveAt(bad, "2026-06-01T00:00:00.000Z");
    note(r.status === 422 && r.body?.ok === false, `「${bad}」被拒（status=${r.status} code=${r.body?.error?.code ?? "-"}）`);
    note(!rangeOf(r.body), `「${bad}」的失败响应里**没有 range**（不会退化成全库检索）`);
  }

  console.log("\n== ⑥ 歧义：不许替用户合并两天 ==");
  const amb = await resolveAt("10/11", "2026-06-01T00:00:00.000Z", { locale: null });
  if (amb.status === 200) {
    const spans = rangeOf(amb.body);
    const days = spans ? (Date.parse(spans.untilExclusive) - Date.parse(spans.since)) / 86400000 : 0;
    note(days <= 1.01, `locale 未知时若仍返回范围，跨度必须只有 1 天（实际 ${days} 天）—— 不许把两天合并`);
    console.log(`     [观察] 它选择了解释：${JSON.stringify(spans)?.slice(0, 110)}`);
  } else {
    note(amb.status === 422 && Boolean(amb.body?.error?.ambiguous), `locale 未知 ⇒ 422 并给出候选（status=${amb.status} ambiguous=${JSON.stringify(amb.body?.error?.ambiguous)?.slice(0, 60)}）`);
  }

  console.log("\n== ⑦ 普通数字不许被当日期 ==");
  for (const s of ["我买了 3 个苹果", "版本 2.5 发布了", "第 8 项任务"]) {
    const r = await resolveAt(s, "2026-06-01T00:00:00.000Z");
    note(r.status === 422, `「${s}」必须失败（status=${r.status}）`);
  }

  console.log("\n== ⑧ Windows 时区名要被归一 ==");
  const win = await resolveAt("2026-10-10", "2026-06-01T00:00:00.000Z", { timezone: "China Standard Time" });
  note(win.status === 200 && rangeOf(win.body)?.since === "2026-10-09T16:00:00.000Z",
    `"China Standard Time" 归一到 +08:00（status=${win.status} since=${rangeOf(win.body)?.since}）`);

  console.log("\n== ⑨ 端到端：把解析出的范围拿去查库（夹具日 9 条必须全取回）==");
  const resolvedDay = await resolveAt("10/10 我们聊了什么", "2026-06-01T00:00:00.000Z");
  const rDay = rangeOf(resolvedDay.body);
  note(resolvedDay.status === 200 && Boolean(rDay), `「10/10 我们聊了什么」解析成功（status=${resolvedDay.status}）`);
  const cal = resolvedDay.body?.calendarDate ?? null;
  const byCal = cal ? await post("/v1/search", { calendarDate: cal, calendarTimezone: SH, limit: 50 }) : await post("/v1/search", { since: "2026-10-10", until: "2026-10-10", limit: 50 });
  const convs = (byCal.body?.results ?? []).filter((x) => /evidence[\\\\/]conversations/u.test(String(x.path)));
  note(convs.length === DAY.length, `按解析结果取回该日全部 ${DAY.length} 条（实际 ${convs.length}，calendarDate=${cal}）`);

  console.log("\n== ⑩ 同一个请求重放必须得到同一个范围（可审计）==");
  const a1 = await resolveAt("上周三", "2026-10-10T02:00:00.000Z");
  const a2 = await resolveAt("上周三", "2026-10-10T02:00:00.000Z");
  note(JSON.stringify(rangeOf(a1.body)) === JSON.stringify(rangeOf(a2.body)), `重放一致（${rangeOf(a1.body)?.since}）`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— M2.1-B1 独立复核通过（now 必填 / 半开区间 / 年份推断 / 相对日 / 严格日历 / 歧义 / 数字不误判 / 时区归一 / 端到端取全 / 可重放）");
