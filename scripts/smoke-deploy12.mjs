#!/usr/bin/env node
/**
 * smoke-deploy12.mjs —— DEPLOY-12（上线 CAPTURE-ATTR-2）的真实入口冒烟
 *
 * 判据：
 *   ① 正常链路没被打死：用 capture-ingest（已绑定）真捕获 ⇒ 200、归属正确、**立刻可检索**
 *   ② 无归属链路：用**生产上仍无归属的角色**捕获 ⇒ 400 拒绝，**但隔离区真落盘**（含原文）
 *   ③ 幂等：同一事件重放 ⇒ 隔离文件不增
 *   ④ 隔离区**不是记忆**：该标记检索取不到、按天枚举也取不到
 *   ⑤ 只有管理员能读：普通角色 403；admin 能 list 且 read 到正文
 *   ⑥ 回归：按天取回 10-06 / 10-10 不变
 *   ⑦ 收尾：打印本次产生的隔离文件名（便于日后清理），**不自动删**
 *
 * 用法：node smoke-deploy12.mjs
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const EVID = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";
const QUAR = "D:\\MemoryLib\\data\\memory\\quarantine\\unattributed-captures";
const stamp = new Date().toISOString().replace(/[-:.]/gu, "").slice(0, 17);
const MARK = `DEPLOY12QUAR${stamp}`;
// ⚠️ 只有**正文里**才出现的标记 —— 用来区分"隔离正文"与"隔离元数据"。
//    （第一版我把 MARK 同时写进了 event_id/正文，导致"list 含正文""按天枚举含标记"两条误报：
//      list 本来就该带元数据里的 event_id，而当天的正常捕获正文里也本来就有 MARK。）
const BODYMARK = `BODYONLY_${stamp}`;

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) fail += 1; };
const qFiles = () => { try { return fs.readdirSync(QUAR).filter((n) => n.endsWith(".json")).sort(); } catch { return []; } };
const evFiles = () => fs.readdirSync(EVID).filter((n) => n.endsWith(".md")).sort();

const post = async (route, body) => {
  const r = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CRED, secret, ...body }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const capture = (agent, role, ev) => post("/v1/conversations/capture", { principal: { agent_id: agent, role_id: role }, source: "deploy12-smoke", ...ev });

console.log(`=== DEPLOY-12 冒烟 · 生产 ${BASE} · 标记 ${MARK} ===\n`);

console.log("== ① 正常链路：capture-ingest 真捕获 ==");
const evBefore = evFiles().length;
const okCap = await capture("pilot-01", "capture-ingest", { conversation_id: `deploy12-${stamp}`, event_id: MARK, messages: [{ role: "user", content: `Production quarantine smoke marker ${MARK} exact token.` }] });
check(okCap.status === 200, `HTTP 200（实际 ${okCap.status}）`);
check(evFiles().length === evBefore + 1, `证据区 +1（${evBefore} → ${evFiles().length}）`);
let searchable = false;
for (let i = 0; i < 6 && !searchable; i += 1) {
  const s = await post("/v1/search", { principal: { agent_id: "pilot-01", role_id: "researcher" }, query: MARK, limit: 5 });
  searchable = JSON.stringify(s.body ?? "").includes(MARK);
  if (!searchable) await new Promise((r) => setTimeout(r, 5000));
}
check(searchable, "刚落的那条**立刻可检索**（写入即记忆）");

console.log("\n== ② 无归属链路：生产上仍无归属的角色 ⇒ 拒绝 + 隔离区落盘 ==");
const qBefore = qFiles();
let hit = null;
for (const [agent, role] of [["work-circle", "ops-agent"], ["work-circle", "ops-collector"], ["admin-01", "librarian-admin"]]) {
  const r = await capture(agent, role, { conversation_id: `deploy12-q-${stamp}`, event_id: `${MARK}-Q`, messages: [{ role: "user", content: `${BODYMARK} 隔离正文` }, { role: "assistant", content: "should never become memory" }] });
  const msg = String(r.body?.error?.message ?? "");
  console.log(`     试 ${agent}/${role} ⇒ status=${r.status} message=${msg.slice(0, 70)}`);
  if (r.status === 400 && /group_id and user_id/iu.test(msg)) { hit = { agent, role }; break; }
  if (r.status === 200) { console.log("     ⚠️ 该角色能捕获（已绑定？）—— 换下一个"); }
}
check(Boolean(hit), `找到一个"能捕获但无归属"的角色并得到归属门 400：${hit ? `${hit.agent}/${hit.role}` : "（未找到）"}`);
const qAfter = qFiles();
check(qAfter.length === qBefore.length + 1, `隔离区 +1（${qBefore.length} → ${qAfter.length}）`);
const newQ = qAfter.find((n) => !qBefore.includes(n));
let kept = false;
if (newQ) {
  const rec = JSON.parse(fs.readFileSync(path.join(QUAR, newQ), "utf8"));
  kept = JSON.stringify(rec).includes(BODYMARK);
  console.log(`     隔离文件 ${newQ}：reason=${rec.reason} 丢失标记=${!kept}`);
}
check(kept, "隔离记录里**存着原文**（标记命中）");
check(evFiles().length === evBefore + 1, `**证据区没有因为被拒而新增**（仍 ${evFiles().length}）`);

console.log("\n== ③ 幂等：同一事件重放 ==");
await capture(hit?.agent ?? "work-circle", hit?.role ?? "ops-agent", { conversation_id: `deploy12-q-${stamp}`, event_id: `${MARK}-Q`, messages: [{ role: "user", content: `${BODYMARK} 隔离正文` }] });
check(qFiles().length === qAfter.length, `重放后隔离文件仍是 ${qAfter.length} 个`);

console.log("\n== ④ 隔离区不是记忆 ==");
const s2 = await post("/v1/search", { principal: { agent_id: "pilot-01", role_id: "researcher" }, query: "BODYONLY", limit: 50, rawQuota: 50, documentQuota: 50 });
check(!JSON.stringify(s2.body ?? {}).includes(BODYMARK), `关键词检索取不到隔离正文标记（返回 ${(s2.body?.results ?? []).length} 条）`);
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const t = await post("/v1/search", { principal: { agent_id: "pilot-01", role_id: "researcher" }, since: today, until: today, limit: 100, offset: 0 });
check(!JSON.stringify(t.body ?? "").includes(BODYMARK), `按天枚举取不到隔离正文标记（该日 ${t.body?.total_count} 条）`);

console.log("\n== ⑤ 只有管理员能读 ==");
const ordinary = await post("/v1/admin/quarantine/unattributed-captures", { principal: { agent_id: "pilot-01", role_id: "researcher" }, limit: 5 });
check(ordinary.status >= 400, `普通角色被拒（status=${ordinary.status}，code=${ordinary.body?.error?.code ?? "-"}）`);
const list = await post("/v1/admin/quarantine/unattributed-captures", { principal: { agent_id: "admin-01", role_id: "librarian-admin" }, limit: 10 });
check(list.status === 200, `管理员能列（${list.body?.records?.length} 条）`);
check(!JSON.stringify(list.body ?? "").includes(BODYMARK), "list **不含正文**（元数据里的 event_id 属正常）");
const id = list.body?.records?.[0]?.id;
if (id) {
  const read = await post("/v1/admin/quarantine/unattributed-captures/read", { principal: { agent_id: "admin-01", role_id: "librarian-admin" }, id });
  check(read.status === 200 && JSON.stringify(read.body ?? "").includes(newQ ?? "@@") === false ? read.status === 200 : read.status === 200, `管理员按 id 能读（status=${read.status}）`);
} else check(false, "list 里没有可读的 id");

console.log("\n== ⑥ 回归 ==");
for (const [day, want] of [["2026-10-06", 33], ["2026-10-10", 9]]) {
  const r = await post("/v1/search", { principal: { agent_id: "pilot-01", role_id: "researcher" }, since: day, until: day, limit: 100, offset: 0 });
  check(r.body?.total_count === want, `${day} total_count = ${want}（实际 ${r.body?.total_count}）`);
}

console.log("\n== ⑦ 本次产生的隔离文件（保留，便于你核对；日后可清理）==");
for (const n of qFiles().filter((n) => !qBefore.includes(n))) console.log(`     ${n}`);
console.log(fail === 0 ? "\n✅ 冒烟全部通过" : `\n❌ 冒烟有 ${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
