#!/usr/bin/env node
/**
 * verify-scenario-1.mjs —— SCENARIO-1 的**独立复核探针**（产品岗，非执行者）
 *
 * 用**我自己的夹具**直接调用它的参考实现 `recallScenario`（不是跑它的测试），核三条路径：
 *   ① 正题：给一句人话 ⇒ 解析出那一天 ⇒ **取全**（条数 == 夹具里那天的条数），且每条都来自库里的 excerpt
 *   ② 反例：没有任何时间表达 ⇒ **明确拒绝，且一条都不许检索**
 *   ③ 歧义：locale 未知的 `10/11` ⇒ **不许替用户合并两天**（要么拒绝、要么给候选）
 *   ④ 越界：`until` 之外/之内的条目边界正确（两端边界）
 *   ⑤ 零模型：参考实现不得 import 任何模型客户端（静态检查它的 import）
 *
 * 用法：node verify-scenario-1.mjs [repoRoot]
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

const G = "sc1-group", U = "sc1-user", SH = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";           // 本地 10-15 16:00
const DAY = [
  ["s-0000", "2026-10-09T16:00:00.000Z"], ["s-0030", "2026-10-09T16:30:00.000Z"],
  ["s-1200", "2026-10-10T04:00:00.000Z"], ["s-2330", "2026-10-10T15:30:00.000Z"],
  ["s-prev", "2026-10-09T15:30:00.000Z"], ["s-next", "2026-10-10T16:30:00.000Z"],
  ["s-other-day", "2026-10-14T02:00:00.000Z"],
];
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sc1-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const convRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(convRoot, { recursive: true });
for (const [id, at] of DAY) {
  await fs.writeFile(path.join(convRoot, `${id}.md`), ["---", `id: ${id}`, "type: conversation", `capturedAt: ${at}`, `groupId: ${G}`, `userId: ${U}`, "---", "", `夹具 ${id} 的内容摘要`].join("\n"), "utf8");
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

const src = await fs.readFile(path.join(REPO, "src/scenario-recall.mjs"), "utf8");
try {
  console.log("== ⑤ 零模型：参考实现的 import 必须有理由 ==");
  const imports = [...src.matchAll(/^import\s+(?:[^"']+from\s+)?["']([^"']+)["']/gmu)].map((m) => m[1]);
  console.log(`     import 列表：${imports.join(", ") || "（无）"}`);
  const modelish = imports.filter((i) => /llm|openai|anthropic|deepseek|model|pi-ai/iu.test(i));
  note(modelish.length === 0, `没有 import 任何模型客户端（可疑项 ${modelish.length} 个）`);
  note(/date\/resolve/u.test(src) && /\/v1\/search/u.test(src), "参考实现确实调用 /v1/date/resolve 与 /v1/search（只读）");
  note(!/method:\s*["'](POST|PUT|DELETE|PATCH)["'][\s\S]{0,200}\/v1\/(write|conversations\/capture|admin)/u.test(src), "没有对写接口发请求");

  const { port } = await server.listen();
  const call = (text, extra = {}) => recallScenario({
    baseUrl: `http://127.0.0.1:${port}`,
    credentials: { credential_ref: auth.credentialRef, secret: auth.authValue },
    principal: { agent_id: "pilot-01", role_id: "researcher" }, text, now: NOW, timezone: SH, ...extra,
  });

  console.log("\n== ① 正题：人话 ⇒ 那一天 ⇒ 取全 ==");
  const main = await call("10/10 我们聊了什么");
  const strip = (x) => path.basename(String(x.path ?? "")).replace(/\.md$/u, "");
  const mainIds = (main?.items ?? main?.results ?? []).map(strip);
  const expectIn = ["s-0000", "s-0030", "s-1200", "s-2330"];
  note(main?.ok !== false, `整体 ok（ok=${main?.ok} reason=${main?.reason ?? "-"}）`);
  note(mainIds.length === expectIn.length, `取回 ${expectIn.length} 条（实际 ${mainIds.length}：${mainIds.join(",")}）`);
  note(expectIn.every((x) => mainIds.includes(x)), "该日 4 条（含本地零点那条）全在内");
  note(!mainIds.includes("s-prev") && !mainIds.includes("s-next") && !mainIds.includes("s-other-day"), "两侧邻居与其它天**都没有**被带进来");
  const complete = main?.complete ?? main?.completeness?.complete ?? null;
  note(complete !== false, `它的"取全"判定不为 false（complete=${complete}）`);
  const excerpts = (main?.items ?? []).map((x) => String(x.excerpt ?? ""));
  note(excerpts.some((t) => t.includes("夹具")), "输出里的摘要确实来自库里的 excerpt（含夹具正文）");

  console.log("\n== ② 反例：没有时间表达 ⇒ 拒绝且不检索 ==");
  const none = await call("随便聊聊");
  const noneIds = (none?.items ?? none?.results ?? []);
  note(none?.ok === false, `明确拒绝（ok=${none?.ok} reason=${none?.reason ?? "-"}）`);
  note(noneIds.length === 0, `**一条都没有检索**（实际 ${noneIds.length} 条）`);

  console.log("\n== ③ 歧义：不许替用户合并两天 ==");
  const amb = await call("10/11", { locale: null });
  const ambItems = (amb?.items ?? amb?.results ?? []);
  if (amb?.ok === false) {
    const cand = JSON.stringify(amb?.candidates ?? amb?.error ?? "").slice(0, 120);
    note(true, `拒绝并给出候选/原因（${amb?.reason ?? "-"} ${cand}）`);
  } else {
    const span = amb?.range ? (Date.parse(amb.range.untilExclusive ?? amb.range.until) - Date.parse(amb.range.since)) / 86400000 : null;
    note(span !== null && span <= 1.01, `若仍返回范围，跨度必须只有 1 天（实际 ${span} 天）—— 不许合并两天`);
    console.log(`     [观察] 取回 ${ambItems.length} 条，range=${JSON.stringify(amb?.range)?.slice(0, 100)}`);
  }

  console.log("\n== ④ 相对日「昨天聊了什么」（夹具里 10-14 有 1 条）==");
  const y = await call("昨天聊了什么");
  const yIds = (y?.items ?? y?.results ?? []).map(strip);
  note(y?.ok !== false && yIds.length === 1 && yIds[0] === "s-other-day", `取回昨天那 1 条（实际 ${yIds.join(",")}）`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— SCENARIO-1 独立复核通过（取全含零点条目 / 邻居不串 / 拒绝不检索 / 歧义不合并 / 零模型 import / 只读）");
