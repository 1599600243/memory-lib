// 用你的场景做一次真实验证： "过几天随口问：10/10 聊了什么"
// 做法：用真实认证身份，按【时间范围】检索某一天的对话原文，看能取回多少、够不够复述。
import fs from "node:fs";
const BASE = "http://127.0.0.1:8787";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const CRED = "memory-lib/deepseek-harness";
async function search(body) {
  const r = await fetch(BASE + "/v1/search", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" }, ...body }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const day = process.argv[2] ?? "2026-10-10";
const q = process.argv[3] ?? "记忆库";
for (const [label, body] of [
  ["默认（limit=10, 无时间范围）", { query: q, searchMode: "hybrid", limit: 10, graphExpand: false }],
  [`按天（since=until=${day}）+ limit=10`, { query: q, searchMode: "hybrid", limit: 10, since: day, until: day, graphExpand: false }],
  [`按天（since=until=${day}）+ limit=50`, { query: q, searchMode: "hybrid", limit: 50, since: day, until: day, graphExpand: false }],
  [`按天 + evidence 档 + limit=50`, { query: q, searchMode: "evidence", limit: 50, since: day, until: day, graphExpand: false }],
]) {
  const r = await search(body);
  const items = r.body?.results ?? [];
  const ev = items.filter((x) => String(x.path ?? "").includes("evidence/conversations")).length;
  console.log(`--- ${label}`);
  console.log(`    status=${r.status}  返回条数=${items.length}  其中原文=${ev}`);
  for (const it of items.slice(0, 4)) console.log(`      · ${String(it.path ?? "").split("\\").pop()}  (${String(it.excerpt ?? "").replace(/\s+/gu, " ").slice(0, 60)})`);
}
