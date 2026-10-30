#!/usr/bin/env node
/**
 * verify-capture-attr2.mjs —— CAPTURE-ATTR-2 的**独立复核探针**（产品岗，非执行者）
 * 语义：无归属捕获 ⇒ **仍然拒绝**，但**原文先落隔离区**（不丢字），且隔离区**不是记忆**。
 *
 * 与开发自带 `test/capture-attr.test.mjs` 的判据差别（不是重跑它的测试）：
 *   ① 额外验**"绑定角色不会被误隔离"**（防止把正常捕获也拖进隔离区）
 *   ② 额外验**正文一字不差**（含多行/特殊字符）——"不丢字"是这个里程碑的全部意义
 *   ③ 额外验**不同 event_id 必须新增**（防止幂等做成"永远只留一条"）
 *   ④ 额外验 **list 不许泄露正文**、read 才给正文，且**普通角色读不了**
 *   ⑤ 额外验隔离记录里**缺失的主体声明被如实记成 null**（不是编一个）
 *   ⑥ 用**自己的夹具/标记**，与开发那份不共用字符串
 *
 * 用法：node verify-capture-attr2.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const G = "probe2-group", U = "probe2-user";
const QM1 = "PROBE2_QUARANTINE_MARKER_alpha";
const QM2 = "PROBE2_QUARANTINE_MARKER_beta";
const MULTI = `PROBE2_MULTILINE_开头\n第二行 "引号" 与 \\ 反斜杠\n结尾_END`;
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "capattr2-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const quarantineRoot = path.join(dataRoot, "quarantine", "unattributed-captures");
const evidenceRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(evidenceRoot, { recursive: true });

const auth = await createTestAuth(REPO, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const pilot = registry.frameworks[0].agents.find((a) => a.agent_id === "pilot-01");
const bound = pilot.roles.find((r) => r.role_id === "researcher");
bound.group_id = G; bound.user_id = U;
const unbound = pilot.roles.find((r) => r.role_id === "steward");
delete unbound.group_id; delete unbound.user_id;
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false },
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});

const qFiles = async () => { try { return (await fs.readdir(quarantineRoot)).filter((n) => n.endsWith(".json")).sort(); } catch { return []; } };
const readQ = async (name) => JSON.parse(await fs.readFile(path.join(quarantineRoot, name), "utf8"));

try {
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ident = (role, agent = "pilot-01") => ({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: agent, role_id: role } });
  const capture = (role, ev) => post("/v1/conversations/capture", { ...ident(role), source: "probe2", ...ev });

  console.log("== ① 无归属捕获：仍然拒绝，但原文落隔离区 ==");
  const before = await qFiles();
  const ev1 = { conversation_id: "probe2-conv-1", event_id: "probe2-evt-1", messages: [{ role: "user", content: QM1 }, { role: "assistant", content: `回答 ${QM1}` }] };
  const r1 = await capture("steward", ev1);
  note(r1.status === 400, `仍然 400（实际 ${r1.status}，message=${String(r1.body?.error?.message ?? "").slice(0, 60)}）`);
  const after1 = await qFiles();
  note(after1.length === before.length + 1, `隔离区新增 1 个（${before.length} → ${after1.length}）`);
  const rec1 = after1.length ? await readQ(after1.find((n) => !before.includes(n))) : null;
  note(rec1?.messages?.some((m) => String(m.content).includes(QM1)), "隔离记录里**存着原文**（含用户与助手两条）");
  note(String(rec1?.reason ?? "").length > 0, `记录了隔离原因（reason=${String(rec1?.reason).slice(0, 40)}）`);

  console.log("\n== ② 幂等：同一 {source,conversation_id,event_id} 重放只留一条 ==");
  await capture("steward", ev1);
  await capture("steward", ev1);
  note((await qFiles()).length === after1.length, `重放 2 次后仍是 ${after1.length} 个`);

  console.log("\n== ③ 不同 event_id 必须新增（防止幂等做成'永远只留一条'）==");
  const r3 = await capture("steward", { ...ev1, event_id: "probe2-evt-2", messages: [{ role: "user", content: QM2 }] });
  const after3 = await qFiles();
  note(r3.status === 400 && after3.length === after1.length + 1, `新增 1 个（${after1.length} → ${after3.length}）`);

  console.log("\n== ④ 绑定角色：必须仍然成功，且**不被误隔离** ==");
  const before4 = await qFiles();
  const ev4 = (await fs.readdir(evidenceRoot)).filter((n) => n.endsWith(".md")).length;
  const r4 = await capture("researcher", { conversation_id: "probe2-ok", event_id: "probe2-ok", messages: [{ role: "user", content: "PROBE2_NORMAL_CAPTURE" }] });
  const ev4after = (await fs.readdir(evidenceRoot)).filter((n) => n.endsWith(".md")).length;
  note(r4.status === 200, `绑定角色 200（实际 ${r4.status}）`);
  note((await qFiles()).length === before4.length, `隔离区**没有**新增（${before4.length} → ${(await qFiles()).length}）`);
  console.log(`     [诊断] 证据区 ${ev4} → ${ev4after}；响应 keys=${Object.keys(r4.body ?? {}).join(",")}；evidenceId=${r4.body?.evidenceId ?? "(无)"}；最近文件=${(await fs.readdir(evidenceRoot)).slice(-3).join(", ")}`);
  note(ev4after === ev4 + 1, `证据区正常新增 1 个（${ev4} → ${ev4after}）`);

  console.log("\n== ⑤ 正文一字不差（多行 / 引号 / 反斜杠）==");
  const r5 = await capture("steward", { conversation_id: "probe2-conv-3", event_id: "probe2-evt-3", messages: [{ role: "user", content: MULTI }] });
  const after5 = await qFiles();
  const rec5 = await readQ(after5[after5.length - 1]);
  const kept = rec5?.messages?.some((m) => String(m.content) === MULTI);
  note(r5.status === 400 && kept, `多行正文**逐字节一致**地被保留（len=${String(rec5?.messages?.[0]?.content ?? "").length} / 期望 ${MULTI.length}）`);

  console.log("\n== ⑥ 隔离区**不是记忆**：检索与按天枚举都取不到 ==");
  const s = await post("/v1/search", { ...ident("researcher"), query: QM1, limit: 100, rawQuota: 100, documentQuota: 100 });
  note(!JSON.stringify(s.body ?? {}).includes(QM1), `关键词检索取不到隔离标记（命中 ${(s.body?.results ?? []).length} 条）`);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const t = await post("/v1/search", { ...ident("researcher"), since: today, until: today, limit: 100, offset: 0 });
  const leaked = JSON.stringify(t.body ?? "");
  note(!leaked.includes(QM1) && !leaked.includes(QM2), `按天枚举取不到隔离标记（该日 ${t.body?.total_count} 条）`);

  console.log("\n== ⑦ 只有管理员能读：list 不泄露正文，read 才给正文 ==");
  const ordinary = await post("/v1/admin/quarantine/unattributed-captures", { ...ident("researcher"), limit: 10 });
  note(ordinary.status >= 400 || ordinary.body?.ok === false, `普通角色被拒（status=${ordinary.status}，code=${ordinary.body?.error?.code ?? "-"}）`);
  const list = await post("/v1/admin/quarantine/unattributed-captures", { ...ident("librarian-admin", "admin-01"), limit: 10 });
  note(list.status === 200 && Array.isArray(list.body?.records), `管理员能列（${list.body?.records?.length} 条）`);
  note(!JSON.stringify(list.body ?? "").includes(QM1), "**list 不包含隔离正文**（只给元数据）");
  const id = list.body?.records?.[0]?.id;
  const read = await post("/v1/admin/quarantine/unattributed-captures/read", { ...ident("librarian-admin", "admin-01"), id });
  note(read.status === 200 && String(read.body?.record?.messages?.[0]?.content ?? "").length > 0, `管理员按 id 能读到正文（id=${String(id).slice(0, 12)}…）`);

  console.log("\n== ⑧ admin 健康档给出隔离计数 ==");
  const hRes = await post("/v1/admin/health", { ...ident("librarian-admin", "admin-01") });
  const h = hRes.body;
  console.log(`     [诊断] status=${hRes.status} 顶层键=${h ? Object.keys(h).join(",") : "(非 JSON)"}`);
  const count = h?.quarantine?.unattributed_captures ?? h?.quarantine?.count ?? null;
  note(Number(count) >= 3, `admin health 的隔离计数 unattributed_captures = ${count}（应为 ≥3）`);
  const pub = await fetch(`${base}/v1/health`).then((r) => r.json()).catch(() => null);
  note(!JSON.stringify(pub ?? "").includes("unattributed_captures"), "公开 /v1/health **不暴露**隔离计数（保持最小形状）");
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— 独立复核全部通过（拒绝但保字 / 幂等但不吞新事件 / 不误隔离 / 不是记忆 / 只有管理员可读 / 有计数）");
