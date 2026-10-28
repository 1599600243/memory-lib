#!/usr/bin/env node
/**
 * smoke-deploy8.mjs —— DEPLOY-8 上线后的真实入口冒烟（可复跑）。
 *
 * 检查项：
 *   1) 公开 /v1/health 与认证 /v1/admin/health 都有 index 段（FIX3 的交付）
 *   2) 四档 searchMode 可用（memories / documents / evidence / hybrid）
 *   3) **入口一致性**：同一身份、同一 query，REST /v1/search 与 MCP memory_search 的路径集合必须相同
 *   4) 跨身份负向：work-circle/ops-agent（无归属）应零命中
 *   5) 可选：--capture 做一次真实 capture 并验证随后能搜到（需要索引已收敛）
 *
 * 用法：node smoke-deploy8.mjs [--capture] [--query <词>]
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:8787";
const SECRET_FILE = "D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret";
const CRED = "memory-lib/deepseek-harness";
const args = process.argv.slice(2);
const DO_CAPTURE = args.includes("--capture");
const qIdx = args.indexOf("--query");
const QUERY = qIdx >= 0 ? args[qIdx + 1] : "记忆";

const secret = fs.readFileSync(SECRET_FILE, "utf8").trim();
let seq = 0;

async function rest(route, body, agent = "pilot-01", role = "researcher") {
  const payload = agent ? { credential_ref: CRED, secret, principal: { agent_id: agent, role_id: role }, ...body } : body;
  const r = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function mcp(tool, argsObj = {}, agent = "pilot-01", role = "researcher") {
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mcp-credential-ref": CRED, "x-mcp-secret": secret, "x-mcp-agent": agent, "x-mcp-role": role },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name: tool, arguments: argsObj } }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const paths = (res) => {
  const b = res?.body;
  const items = b?.results ?? b?.result?.results ?? b?.items ?? b?.result?.content?.[0]?.results ?? [];
  const arr = Array.isArray(items) ? items : [];
  return arr.map((x) => String(x?.path ?? x?.rel ?? x ?? "")).filter(Boolean).sort();
};
const mcpPaths = (res) => {
  const b = res?.body;
  const txt = b?.result?.content?.[0]?.text ?? "";
  try { const j = JSON.parse(txt); return (j.results ?? []).map((x) => String(x.path ?? "")).filter(Boolean).sort(); } catch { return []; }
};

const out = { query: QUERY, checks: {}, raw: {} };

// 1) health 的 index 段
const health = await (await fetch(BASE + "/v1/health")).json();
const admin = await rest("/v1/admin/health", {}, "admin-01", "librarian-admin");
out.checks.public_health = health.health;
out.checks.public_index_keys = Object.keys(health.index ?? {});
out.checks.admin_health = admin.body?.health ?? null;
out.checks.admin_has_index = Boolean(admin.body?.index);
out.checks.admin_index_keys = Object.keys(admin.body?.index ?? {});
out.checks.admin_index_agrees_with_public =
  JSON.stringify(Object.keys(admin.body?.index ?? {}).sort()) === JSON.stringify(Object.keys(health.index ?? {}).sort());
out.raw.pending_changes = health.index?.pending_changes;
out.raw.library_files = health.index?.library_files;
out.raw.indexed_files = health.index?.indexed_files;

// 2) 四档可用
for (const mode of ["memories", "documents", "evidence", "hybrid"]) {
  const r = await rest("/v1/search", { query: QUERY, searchMode: mode, limit: 10, graphExpand: false });
  out.checks[`mode_${mode}_status`] = r.status;
  out.raw[`mode_${mode}_count`] = paths(r).length;
}

// 3) 入口一致性（hybrid + memories）
for (const mode of ["hybrid", "memories"]) {
  const r = await rest("/v1/search", { query: QUERY, searchMode: mode, limit: 10, graphExpand: false });
  const m = await mcp("memory_search", { query: QUERY, searchMode: mode, limit: 10, graphExpand: false });
  const rp = paths(r), mp = mcpPaths(m);
  out.checks[`channels_agree_${mode}`] = JSON.stringify(rp) === JSON.stringify(mp);
  out.raw[`rest_${mode}`] = rp.slice(0, 5);
  out.raw[`mcp_${mode}`] = mp.slice(0, 5);
  out.raw[`rest_${mode}_count`] = rp.length;
  out.raw[`mcp_${mode}_count`] = mp.length;
}

// 4) 跨身份负向（work-circle/ops-agent 无 group/user 归属）
const neg = await rest("/v1/search", { query: QUERY, searchMode: "hybrid", limit: 10, graphExpand: false }, "work-circle", "ops-agent");
out.checks.negative_work_circle_count = paths(neg).length;
out.checks.negative_is_empty = paths(neg).length === 0;

// 5) 可选：真实 capture → 随后能搜到
if (DO_CAPTURE) {
  const marker = `DEPLOY8-SMOKE-${Date.now()}`;
  const cap = await rest("/v1/conversations/capture", {
    source: "deploy8-smoke", conversation_id: `deploy8-smoke-${Date.now()}`, event_id: `deploy8-smoke-${Date.now()}`,
    messages: [{ role: "user", content: `上线冒烟标记 ${marker}` }],
  });
  out.raw.capture_status = cap.status;
  out.raw.capture_body = { searchStatus: cap.body?.searchStatus, status: cap.body?.status, indexError: cap.body?.indexError, lifecycle: cap.body?.lifecycle, evidenceId: cap.body?.evidenceId };
  const ev = cap.body?.evidenceId;
  if (ev) {
    let found = 0;
    for (let i = 1; i <= 20; i++) {
      const s = await rest("/v1/search", { query: marker, searchMode: "evidence", limit: 10, graphExpand: false });
      found = paths(s).length;
      if (found > 0) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    out.checks.captured_then_searchable = found > 0;
    out.raw.captured_evidence_id = ev;
    out.raw.captured_search_count = found;
    const g = await rest("/v1/get", { id: ev });
    out.checks.captured_get_by_id = g.status === 200;
  }
}

console.log(JSON.stringify(out, null, 2));
const fails = Object.entries(out.checks).filter(([k, v]) => v === false).map(([k]) => k);
console.log(fails.length ? `\n❌ 失败项: ${fails.join(", ")}` : "\n✅ 全部冒烟项通过");
process.exit(fails.length ? 1 : 0);
