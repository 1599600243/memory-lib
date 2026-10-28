// 对比改前/改后 principalAllowsContainer：必须做成"逐 case 表"，用于判定误伤与漏洞
// 用法: node scripts/diff-container-policy.mjs [基线 src 目录] [当前 src 目录]
import path from "node:path";

const BASE_SRC = process.argv[2] ?? "D:\\MemoryLib\\_wt\\wt-vis-base\\memory-lib\\src";
const CUR_SRC = process.argv[3] ?? "D:\\MemoryLib\\app\\memory-lib\\src";

const base = await import("file:///" + path.join(BASE_SRC, "container-policy.mjs").replace(/\\/g, "/") + "?v=" + Date.now());
const cur = await import("file:///" + path.join(CUR_SRC, "container-policy.mjs").replace(/\\/g, "/") + "?v=" + Date.now());

const cases = [
  // ── 漏洞点：所有权哨兵不该匹配 ─────────────────────────────
  { name: "L1 private+long-term(user=unknown) × 仅 user=unknown（漏洞点，应拒）", expect: false,
    meta: { container: "long-term", visibility: "private", user_id: "unknown", agent_id: "admin-01", role_id: "librarian-admin" },
    principal: { user_id: "unknown" } },
  { name: "L2 同上 × agent/role 哨兵（应拒）", expect: false,
    meta: { container: "long-term", visibility: "private", user_id: "unknown", agent_id: "unknown", role_id: "unknown" },
    principal: { agent_id: "unknown", role_id: "unknown" } },
  { name: "L3 visibility=user(user=unknown) × user=unknown（应拒）", expect: false,
    meta: { container: "long-term", visibility: "user", user_id: "unknown" },
    principal: { user_id: "unknown" } },
  { name: "L4 visibility=role(role=unknown) × role=unknown（应拒）", expect: false,
    meta: { container: "role", visibility: "role", role_id: "unknown" },
    principal: { role_id: "unknown" } },

  // ── 误伤点：真实身份/范围语义必须保持 ──────────────────────
  { name: "M1 project(group=unknown 双方) × researcher(group=unknown)（maint6 场景，应放行）", expect: true,
    meta: { container: "project", visibility: "project", project: "maint6-project", group_id: "unknown", agent_id: "admin-01", role_id: "librarian-admin", user_id: "unknown" },
    principal: { agent_id: "pilot-01", role_id: "researcher", group_id: "unknown", user_id: "unknown" } },
  { name: "M2 shared(group=unknown 双方)（应放行）", expect: true,
    meta: { container: "long-term", visibility: "shared", group_id: "unknown" },
    principal: { group_id: "unknown" } },
  { name: "M3 private(long-term) × 真实 admin-01/librarian-admin（应放行）", expect: true,
    meta: { container: "long-term", visibility: "private", user_id: "unknown", agent_id: "admin-01", role_id: "librarian-admin" },
    principal: { agent_id: "admin-01", role_id: "librarian-admin" } },
  { name: "M4 platform（应放行）", expect: true,
    meta: { container: "knowledge", visibility: "platform" },
    principal: { user_id: "unknown" } },
  { name: "M5 真实 user 精确相等（应放行）", expect: true,
    meta: { container: "long-term", visibility: "user", user_id: "real-user-1" },
    principal: { user_id: "real-user-1" } },
  { name: "M6 两侧 group 不同且都非哨兵（应拒绝）", expect: false,
    meta: { container: "project", visibility: "project", project: "p1", group_id: "g-a" },
    principal: { group_id: "g-b" } },

  // ── 扩权方向（验收岗 2026-10-22 抓到；产品岗原方案在此处判断错误）──
  // 基线：一侧哨兵、一侧真实组 ⇒ 拒绝（因为两边都"存在"但不相等）。
  // 任何把"哨兵当未指定"的改法都会把这三条变成放行 = 扩权，必须保持基线值。
  { name: "X1 project × 记忆 group=real-g × principal group=unknown（应拒绝，防扩权）", expect: false,
    meta: { container: "project", visibility: "project", project: "p1", group_id: "real-g" },
    principal: { group_id: "unknown" } },
  { name: "X2 shared × 记忆 group=real-g × principal group=unknown（应拒绝，防扩权）", expect: false,
    meta: { container: "long-term", visibility: "shared", group_id: "real-g" },
    principal: { group_id: "unknown" } },
  { name: "X3 project × 记忆 group=unknown × principal group=real-g（应拒绝，防扩权）", expect: false,
    meta: { container: "project", visibility: "project", project: "p1", group_id: "unknown" },
    principal: { group_id: "real-g" } },
  { name: "X4 project × 双方 group=unknown（maint6 场景，应放行）", expect: true,
    meta: { container: "project", visibility: "project", project: "p1", group_id: "unknown" },
    principal: { group_id: "unknown" } },
];

let bad = 0;
console.log("case".padEnd(62) + "改前  改后  期望  判定");
for (const c of cases) {
  const b = base.principalAllowsContainer(c.principal, c.meta);
  const n = cur.principalAllowsContainer(c.principal, c.meta);
  const okCur = n === c.expect;
  const okBase = b === c.expect;
  if (!okCur) bad++;
  const verdict = okCur ? (okBase ? "✅改前改后都对" : "✅（本单修正）") : "❌ 改后不符期望";
  console.log(c.name.padEnd(58) + String(b).padEnd(6) + String(n).padEnd(6) + String(c.expect).padEnd(6) + verdict);
}
console.log(`\n改后不符期望: ${bad} / ${cases.length}`);
process.exitCode = bad === 0 ? 0 : 1;
