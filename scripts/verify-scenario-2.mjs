#!/usr/bin/env node
/**
 * verify-scenario-2.mjs —— SCENARIO-2（大日子：取全 + 分批不丢条目）的**独立复核探针**（产品岗，非执行者）
 *
 * 判据（用**我自己造的"大日子"夹具**，不是跑它的测试）：
 *   ① **取全**：一天 150 条时，取回条数 == total_count（不许因为分页/上限少给）
 *   ② **分批不丢**：所有块的条目**并集 == 当天取全集合**（一条不多、一条不少、不重复）
 *   ③ **上限生效**：任何一块的字符数 ≤ 给定预算
 *   ④ **超长单条**：单条本身超过预算时，必须**单独成块且被明确标注**（不许截断、不许静默超限）
 *   ⑤ **不改写**：块内条目的 excerpt 与"当天列表"里的**逐字节一致**（分批只切分，不做摘要）
 *   ⑥ **退化**：只有 1 条时 ⇒ 恰好 1 块；0 条 ⇒ 0 块（不许产生空块）
 *   ⑦ **确定性**：同输入同参数 ⇒ 分批结果一致
 *
 * 用法：node verify-scenario-2.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { recallScenario } = await import(pathToFileURL(path.join(REPO, "src/scenario-recall.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const G = "sc2-group", U = "sc2-user", SH = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const BIG = 150;                 // 大日子：150 条
const BUDGET = 1500;             // 每块字符预算（故意给小，逼出很多块）
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
// 本地 2026-10-10 那天：150 条，正文长度不等
// 关键：**必须有一条正文本身远大于块预算**，否则「单条超预算 ⇒ 单独成块且不截断」那条分支根本走不到，
// 判据会**空过**（every 对空数组恒真）—— 这是我第一版探针犯过的错。
const OVERSIZE_PAD = 12000;      // 远大于 BUDGET=1500
const ids = [];
for (let i = 0; i < BIG; i += 1) {
  const pad = i === 37 ? "长".repeat(OVERSIZE_PAD) : (i % 37 === 0 && i > 0 ? "长".repeat(1200) : "短".repeat(20));
  const id = `big-${String(i).padStart(3, "0")}`;
  ids.push(id);
  const at = new Date(Date.UTC(2026, 9, 9, 16, 0, 0) + i * 300000).toISOString();   // 本地 10-10 从 00:00 起，每 5 分钟一条
  await fs.writeFile(path.join(convRoot, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${at}`, `groupId: ${G}`, `userId: ${U}`, "---", "", `夹具 ${id} ${pad}`].join("\n"), "utf8");
}
// 只 1 条的一天（本地 10-12）
await fs.writeFile(path.join(convRoot, "solo-1.md"), ["---", "id: solo-1", "type: conversation", "capturedAt: 2026-10-11T16:30:00.000Z", `groupId: ${G}`, `userId: ${U}`, "---", "", "夹具 solo-1"].join("\n"), "utf8");

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
  const call = (text, extra = {}) => recallScenario({
    baseUrl: `http://127.0.0.1:${port}`,
    credentials: { credential_ref: auth.credentialRef, secret: auth.authValue },
    principal: { agent_id: "pilot-01", role_id: "researcher" }, text, now: NOW, timezone: SH,
    pageSize: 25,          // 故意小于一天条数，逼它翻页
    chunkChars: BUDGET,
    ...extra,
  });
  const strip = (x) => path.basename(String(x.path ?? "")).replace(/\.md$/u, "");

  console.log(`== ① 取全：本地 10/10 有 ${BIG} 条，pageSize=25（必须翻 7 页）==`);
  const big = await call("10/10 我们聊了什么");
  const items = big?.items ?? [];
  const itemIds = items.map(strip);
  const excerptLen = (x) => String(x?.excerpt ?? "").length;
  const byId = new Map(items.map((x) => [strip(x), x]));   // 供 ③④⑤ 复用
  note(big?.ok !== false, `整体 ok（ok=${big?.ok} reason=${big?.reason ?? "-"}）`);
  note(items.length === BIG, `取回条数 == 当天条数 ${BIG}（实际 ${items.length}）`);
  note(itemIds.length === new Set(itemIds).size, "取回的条目**没有重复**");
  note(big?.complete === true, `complete=true（实际 ${big?.complete}）`);

  console.log("\n== ② 分批不丢：块并集 == 当天取全集合 ==");
  const chunks = big?.chunks ?? [];
  const flat = chunks.flatMap((c) => (c.items ?? c.entries ?? []).map(strip));
  note(chunks.length > 1, `确实被切成了多块（${chunks.length} 块）`);
  note(flat.length === BIG, `块内条目总数 == ${BIG}（实际 ${flat.length}）`);
  note(flat.length === new Set(flat).size, "块之间**没有重复条目**");
  const missing = itemIds.filter((x) => !flat.includes(x));
  const extra = flat.filter((x) => !itemIds.includes(x));
  note(missing.length === 0, `**一条都没丢**（缺 ${missing.length}${missing.length ? "：" + missing.slice(0, 5).join(",") : ""}）`);
  note(extra.length === 0, `也没有凭空多出来的条目（多 ${extra.length}）`);

  console.log("\n== ③ 上限生效（预算 1500） / ④ 单条超预算：单独成块 + 被标注 + 不截断（预算 100）==");
  const maxExcerpt = Math.max(...items.map(excerptLen));
  console.log(`     [观察] 当天最长一条 excerpt = ${maxExcerpt} 字符（我埋了 ${OVERSIZE_PAD} 字符正文 ⇒ excerpt 有上限）`);
  console.log(`     [观察] 预算 ${BUDGET} 时每块 (条数, 字符数, oversized) = ${chunks.map((c) => `(${(c.items ?? c.entries ?? []).length},${c.chars ?? "?"},${c.oversized === true})`).join(" ")}`);

  // ③ 正常预算：任何一条都不超预算 ⇒ **不许有任何块超预算**
  const overCap = chunks.filter((c) => (c.chars ?? 0) > BUDGET);
  note(overCap.length === 0, `预算 ${BUDGET} 时没有块超预算（超限 ${overCap.length} 块）—— 上限生效`);
  note(chunks.length > 1 && chunks.every((c) => (c.items ?? c.entries ?? []).length > 0), "每块都非空");

  // ④ 关键：excerpt 有 400 字符上限，**默认预算下「单条超预算」这条路走不到**。
  //    所以必须把预算压到 400 以下（模拟"接入方上下文很小"）才能真正撞到它，否则本组判据空过。
  const TINY = 100;
  const tiny = await call("10/10 我们聊了什么", { chunkChars: TINY });
  const tinyChunks = tiny?.chunks ?? [];
  const tinyFlat = tinyChunks.flatMap((c) => (c.items ?? c.entries ?? []).map(strip));
  console.log(`     [观察] 预算 ${TINY} 时切成 ${tinyChunks.length} 块，每块 (条数, 字符数, oversized) = ${tinyChunks.map((c) => `(${(c.items ?? c.entries ?? []).length},${c.chars ?? "?"},${c.oversized === true})`).slice(0, 6).join(" ")} …`);
  note(maxExcerpt > TINY, `夹具里的条目确实"单条 > 预算"（最长 ${maxExcerpt} > ${TINY}）—— 否则本组判据空过`);
  const chunkOf = (c) => (c.items ?? c.entries ?? []);
  // 正确定义的"上限生效"：**任何"多条装一块"的块都不许超预算**；
  // 唯一允许超预算的形态是「单条本身就超预算 ⇒ 单独成块 + oversized」。
  const multiOver = tinyChunks.filter((c) => chunkOf(c).length > 1 && (c.chars ?? 0) > TINY);
  note(multiOver.length === 0, `没有"多条挤在一起还超预算"的块（${multiOver.length} 块）`);
  const fatItems = tinyChunks.flatMap((c) => chunkOf(c).filter((it) => excerptLen(it) > TINY).map((it) => ({ c, it })));
  note(fatItems.length >= 1, `确认有 ${fatItems.length} 条"本身超预算"的条目进入分批（不是空过）`);
  const badShape = fatItems.filter(({ c }) => chunkOf(c).length !== 1 || c.oversized !== true);
  note(badShape.length === 0, `每条"本身超预算"的条目都**单独成块并标 oversized**（不合规 ${badShape.length} 条）`);
  const thinOver = tinyChunks.filter((c) => (c.chars ?? 0) > TINY && chunkOf(c).length === 1 && c.oversized !== true);
  note(thinOver.length === 0, `不存在"超了预算却没被标注"的块（${thinOver.length} 块）`);
  const oversizeCount = tinyChunks.filter((c) => c.oversized === true).length;
  note(oversizeCount === fatItems.length, `标注数量与"本身超预算"的条目数一致（${oversizeCount} vs ${fatItems.length}）`);
  note(tinyFlat.length === BIG, `超小预算下**仍然一条不丢**（${tinyFlat.length}/${BIG}）`);
  note(tinyFlat.length === new Set(tinyFlat).size, "超小预算下**仍然不重复**");
  note(tinyFlat.every((x) => itemIds.includes(x)), "超小预算下也没有凭空多出的条目");
  const oversize = tinyChunks.find((c) => strip((c.items ?? c.entries ?? [])[0]) === "big-037");
  note(Boolean(oversize), "我埋的超长那条（big-037）在超小预算下也在");
  if (oversize) {
    const got = String((oversize.items ?? oversize.entries ?? [])[0]?.excerpt ?? "");
    const src = String(byId.get("big-037")?.excerpt ?? "");
    note(got === src, `超长条**没有被截断**（块内 ${got.length} 字符 vs 当天列表 ${src.length} 字符，逐字节一致）`);
  }

  console.log("\n== ⑤ 不改写：块内 excerpt 与当天列表逐字节一致 ==");
  let mismatch = 0;
  for (const c of chunks) for (const it of (c.items ?? c.entries ?? [])) {
    const orig = byId.get(strip(it));
    if (!orig) { mismatch += 1; continue; }
    if (String(orig.excerpt ?? "") !== String(it.excerpt ?? "")) mismatch += 1;
  }
  note(mismatch === 0, `块内摘要是**原样搬运**、没有改写（不一致 ${mismatch} 条）`);

  console.log("\n== ⑥ 退化：只有 1 条的一天 ==");
  const one = await call("10/12 我们聊了什么");
  const oneItems = one?.items ?? [];
  const oneChunks = one?.chunks ?? [];
  note(oneItems.length === 1, `那天取回 1 条（实际 ${oneItems.length}）`);
  note(oneChunks.length === 1, `恰好 1 块（实际 ${oneChunks.length}）`);
  note(oneChunks.every((c) => (c.items ?? c.entries ?? []).length > 0), "没有空块");

  console.log("\n== ⑦ 确定性 ==");
  const again = await call("10/10 我们聊了什么");
  const chunkSig = (r) => JSON.stringify((r?.chunks ?? []).map((c) => (c.items ?? c.entries ?? []).map(strip)));
  note(chunkSig(big) === chunkSig(again), "同输入同参数 ⇒ 分批结果一致");
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— SCENARIO-2 独立复核通过（大日子取全 / 分批不丢不重 / 上限生效 / 单条超长可识别 / 不改写 / 退化 / 确定性）");
