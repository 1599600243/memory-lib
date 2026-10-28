// 部署后验：brief 五问法 + 图检索 + search（三条入口）
// 认证口径：/v1/recall/brief 与 /v1/search、/v1/graph/query 都走 **body 里的 credential_ref + secret + principal**
//（头部 X-MCP-* 那套在这几个端点会 401 "credential_ref required" —— 踩过）
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const ADMIN = { agent_id: "admin-01", role_id: "librarian-admin" };
const READER = { agent_id: "pilot-01", role_id: "reader" };
const ANS = "curated-shared-466787238d86faef";
const post = async (path, body) => {
  const r = await fetch("http://127.0.0.1:8787" + path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: ref, secret, ...body }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

console.log("== 1) brief：五种「几层」问法（reader 身份）==");
for (const q of ["记忆库几层", "记忆库是几层", "记忆库有几层？", "我们记忆库分几层", "记忆库一共几层"]) {
  const { status, json } = await post("/v1/recall/brief", { principal: READER, format: "prompt", query: q, memory_only: true, memory_limit_chars: 600 });
  const inc = json?.included ?? [];
  const pos = inc.findIndex((m) => m.id === ANS) + 1;
  console.log(`  ${q.padEnd(16)} HTTP ${status} source=${json?.candidate_source ?? "-"} 8层位次=${pos || "未进"} 命中=${inc.length}`);
}

console.log("\n== 2) 图检索 /v1/graph/query（admin 身份）==");
for (const pid of ["project:memory-lib", "project:maint6-project", "project:memory-archive"]) {
  const { status, json } = await post("/v1/graph/query", { principal: ADMIN, project_id: pid });
  const g = json?.graph ?? {};
  console.log(`  ${pid.padEnd(28)} HTTP ${status} nodes=${g.nodes?.length ?? g.memories?.length ?? 0} edges=${g.edges?.length ?? 0}`);
}

console.log("\n== 3) search（admin 身份）==");
for (const q of ["记忆库收敛为8层", "RANK-1 验收", "VISIBILITY 哨兵"]) {
  const { status, json } = await post("/v1/search", { principal: ADMIN, query: q, limit: 5 });
  console.log(`  ${q.padEnd(18)} HTTP ${status} 命中 ${json?.count ?? json?.results?.length ?? 0}`);
}
