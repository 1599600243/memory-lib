// 核对 /v1/admin/health 的 index 段（用正确与错误的身份各打一次）
import fs from "node:fs";
const BASE = "http://127.0.0.1:8787";
const secret = fs.readFileSync("D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8").trim();
const CRED = "memory-lib/deepseek-harness";
async function adminHealth(agent, role) {
  const r = await fetch(BASE + "/v1/admin/health", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: CRED, secret, principal: { agent_id: agent, role_id: role } }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
for (const [agent, role, note] of [["pilot-01", "researcher", "非管理员（预期 403）"], ["admin-01", "librarian-admin", "管理员（预期 200 + index 段）"]]) {
  const r = await adminHealth(agent, role);
  const keys = r.body?.index ? Object.keys(r.body.index) : [];
  console.log(`--- ${agent}/${role} —— ${note}`);
  console.log(`    status=${r.status}  health=${r.body?.health ?? "(无)"}  error=${r.body?.error?.code ?? "-"}`);
  console.log(`    有 index 段: ${Boolean(r.body?.index)}  字段数=${keys.length}`);
  if (keys.length) {
    console.log(`    字段: ${keys.join(", ")}`);
    console.log(`    failed=${r.body.index.failed} last_error=${JSON.stringify(r.body.index.last_error)} incremental_failure=${JSON.stringify(r.body.index.incremental_failure)} pending=${r.body.index.pending_changes}`);
  }
}
