#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT / 项 2 —— **按根模式**逐入口量"没身份时是拒绝还是放行"。
//
// 根模式 = `if (principal && …)`：拿不到 principal 时判定**被静默跳过**（不是拒绝）。
// 已机械定位的站点（`grep -n "if (principal &&" src/*.mjs`）：
//   plans-memory.mjs:146,147,148 · profile-memory.mjs:50 · project-memory.mjs:128,152
//   role-memory.mjs:88 · tools-memory.mjs:118
//
// 方法：**不给 principal**，直接调仓储的 list 方法（= MCP 进程内路径把 payload 原样透传的等价形状），
// 看它返回"拒绝/空"还是"全部"。每条条目自带唯一 marker，用来确认到底漏了什么。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlansMemory } from "../src/plans-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { createRoleMemory } from "../src/role-memory.mjs";
import { createToolsMemory } from "../src/tools-memory.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis2r-root-"));
const dataRoot = path.join(tmp, "memory");

const other = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-OTHER", user_id: "user-OTHER", agent_id: "agent-OTHER", role_id: "role-OTHER" };
const me = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-ME", user_id: "user-ME", agent_id: "agent-ME", role_id: "role-ME" };

const plans = createPlansMemory({ dataRoot });
const profiles = createProfileMemory({ dataRoot });
const roles = createRoleMemory({ dataRoot });
const tools = createToolsMemory({ dataRoot });

const findings = [];
const note = (label, ok) => findings.push({ label, ok });

// ── 夹具 ──
await plans.writePlan({ topic: "plan-owned-by-other", status: "draft", evidence_refs: ["ev:1"], principal: other, sections: { 目标: "MARKER-PLAN-OTHER", 步骤: "- [ ] 一步", 当前卡点: "-" } });
await plans.writePlan({ topic: "plan-owned-by-me", status: "draft", evidence_refs: ["ev:1"], principal: me, sections: { 目标: "MARKER-PLAN-ME", 步骤: "- [ ] 一步", 当前卡点: "-" } });
await roles.putRoleNote({ agent_id: "agent-OTHER", role_id: "role-OTHER", kind: "lesson", evidence_refs: ["ev:1"], sections: { 经验: "MARKER-ROLE-OTHER", 适用场景: "-", 边界: "-" } });
try { await tools.putToolNote({ tool_name: "tool-OTHER", body: "MARKER-TOOL-OTHER", evidence_refs: ["ev:1"], principal: other }); } catch { /* 该 API 可能不同签名 */ }

const text = (v) => JSON.stringify(v ?? null);
const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" && Array.isArray(v.items) ? v.items.length : null);

const out = { fixture: "每个容器各一条『属于别人』的条目 + 一条属于我的（对照）" };

// ── A. 不给 principal（MCP 进程内形状）──
const noPrincipal = {};
{
  const v = await plans.listPlans({});
  noPrincipal["plans.listPlans({})"] = { 返回条数: count(v), 含别人private: text(v).includes("plan-owned-by-other"), 含我的: text(v).includes("plan-owned-by-me") };
}
{
  const v = await profiles.listProfiles({});
  noPrincipal["profiles.listProfiles({})"] = { 返回条数: count(v), 含别人private: text(v).includes("MARKER-PROFILE-OTHER") };
}
{
  const v = await roles.listRoleNotes({});
  noPrincipal["roleMemory.listRoleNotes({})"] = { 返回条数: count(v), 含别人role: text(v).includes("MARKER-ROLE-OTHER"), ids: (Array.isArray(v) ? v.map((i) => i.id) : null) };
}
{
  try {
    const v = await tools.listTools({});
    noPrincipal["tools.listTools({})"] = { 返回条数: count(v), 含别人tool: text(v).includes("MARKER-TOOL-OTHER") };
  } catch (e) { noPrincipal["tools.listTools({})"] = { 抛错: e.message }; }
}
out["A. 不给 principal ⇒ 会不会放行"] = noPrincipal;

// ── B. 给了"我的" principal（对照，应当只看到我的）──
const withPrincipal = {};
{
  const v = await plans.listPlans({ principal: me });
  withPrincipal["plans.listPlans({principal: me})"] = { 返回条数: count(v), 含别人private: text(v).includes("plan-owned-by-other"), 含我的: text(v).includes("plan-owned-by-me") };
}
{
  const v = await roles.listRoleNotes({ principal: me });
  withPrincipal["roleMemory.listRoleNotes({principal: me})"] = { 返回条数: count(v), 含别人role: text(v).includes("MARKER-ROLE-OTHER") };
}
out["B. 给了我的 principal（对照）"] = withPrincipal;

console.log(JSON.stringify(out, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
