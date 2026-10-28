#!/usr/bin/env node
/**
 * smoke-deploy11.mjs —— DEPLOY-11（上线 CAPTURE-ATTR-1）的真实入口冒烟
 *
 * 会**真实捕获 1 条**（带醒目标记，便于日后退役）——这是唯一能证明"现有捕获链没被打死"的办法。
 *
 * 判据：
 *   ① 用**生产捕获链实际使用的角色**（capture-ingest）捕获 ⇒ 200
 *   ② 落盘 frontmatter 的 groupId/userId = home-circle/user-owner（归属取自凭据）
 *   ③ 这条新记忆**立刻可被检索到**（写入即记忆，不是"写进去但搜不到"）
 *   ④ 请求体**伪造归属** ⇒ 被拒且**不落盘**
 *   ⑤ 回归：10-06 仍 33/33、10-10 仍 9/9（按天取回未受影响）
 *
 * 用法：node smoke-deploy11.mjs
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:8787";
const CRED = "memory-lib/deepseek-harness";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const EVID = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";
const stamp = new Date().toISOString().replace(/[-:.]/gu, "").slice(0, 17);
const MARKER = `DEPLOY11RAW${stamp}`;

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) fail += 1; };
const listing = () => new Set(fs.readdirSync(EVID).filter((n) => n.endsWith(".md")));

const capture = async (role, body) => {
  const r = await fetch(`${BASE}/v1/conversations/capture`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: role }, ...body }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log(`=== DEPLOY-11 冒烟 · 生产 ${BASE} · 标记 ${MARKER} ===\n`);

console.log("== ① 用生产捕获链的角色 capture-ingest 捕获一条 ==");
const before = listing();
const cap = await capture("capture-ingest", {
  source: "deploy11-smoke", conversation_id: `deploy11-${stamp}`, event_id: MARKER,
  messages: [{ role: "user", content: `Production capture-ownership smoke marker ${MARKER} exact token.` }, { role: "assistant", content: "Acknowledged for capture attribution verification." }],
});
check(cap.status === 200, `HTTP 200（实际 ${cap.status}${cap.status !== 200 ? " " + JSON.stringify(cap.body).slice(0, 120) : ""}）`);
const evidenceId = cap.body?.evidenceId ?? cap.body?.evidence_id ?? null;
const after = listing();
check(after.size === before.size + 1, `落盘新增 1 个文件（${before.size} → ${after.size}）`);

console.log("\n== ② 新条目的归属 = 凭据解析出的 home-circle/user-owner ==");
if (evidenceId) {
  const file = `${EVID}\\${evidenceId}.md`;
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, "utf8");
    const g = /^groupId:\s*"?([^"\r\n]*)"?/mu.exec(t)?.[1];
    const u = /^userId:\s*"?([^"\r\n]*)"?/mu.exec(t)?.[1];
    check(g === "home-circle" && u === "user-owner", `groupId/userId = ${g}/${u}`);
    check(!/^groupId:\s*"?unknown/mu.test(t), "归属**不是** unknown（历史 bug 的形态）");
  } else check(false, `找不到落盘文件 ${evidenceId}.md`);
} else check(false, `响应里没有 evidenceId：${JSON.stringify(cap.body).slice(0, 160)}`);

console.log("\n== ③ 这条新记忆立刻可检索（写入即记忆）==");
let found = null;
for (let i = 0; i < 6; i += 1) {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" }, query: MARKER, limit: 5 }) });
  const b = await r.json().catch(() => null);
  found = (b?.results ?? []).find((x) => String(x.path).includes(evidenceId ?? "@@"));
  if (found) break;
  await new Promise((res) => setTimeout(res, 5000));
}
check(Boolean(found), `用标记 ${MARKER} 能检索到刚落的那条${found ? "" : "（等 30 秒仍未命中）"}`);

console.log("\n== ④ 请求体伪造归属 ⇒ 被拒且不落盘 ==");
const b4 = listing();
const spoof = await capture("capture-ingest", {
  source: "deploy11-smoke", conversation_id: `deploy11-spoof-${stamp}`, event_id: `${MARKER}-SPOOF`,
  messages: [{ role: "user", content: `spoof attempt ${MARKER}` }],
  principal: { agent_id: "pilot-01", role_id: "capture-ingest", group_id: "attacker-group", user_id: "attacker-user" },
});
const a4 = listing();
check(spoof.status >= 400, `被拒（status=${spoof.status}，message=${String(spoof.body?.error?.message ?? "").slice(0, 70)}）`);
check(a4.size === b4.size, `**没有落盘**（${b4.size} → ${a4.size}）`);

console.log("\n== ⑤ 回归：按天取回未受影响 ==");
for (const [day, want] of [["2026-10-06", 33], ["2026-10-10", 9]]) {
  const r = await fetch(`${BASE}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" }, since: day, until: day, limit: 100, offset: 0 }) });
  const b = await r.json().catch(() => null);
  check(b?.total_count === want, `${day} total_count = ${want}（实际 ${b?.total_count}）`);
}

console.log("\n== ⑥ 健康档 ==");
const h = await fetch(`${BASE}/v1/health`).then((r) => r.json()).catch(() => null);
check(h?.health === "healthy", `health=${h?.health}`);
check(Number(h?.index?.failed ?? 1) === 0, `failed=${h?.index?.failed}`);
console.log(`     indexed=${h?.index?.indexed_files} pending=${h?.index?.pending_changes} PID 需另查`);

console.log(fail === 0 ? "\n✅ 冒烟全部通过" : `\n❌ 冒烟有 ${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
