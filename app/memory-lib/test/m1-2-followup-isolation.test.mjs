import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createPlansMemory } from "../src/plans-memory.mjs";
import { createProjectMemory, STATE_SECTIONS, DECISION_SECTIONS } from "../src/project-memory.mjs";
import { createToolsMemory, TOOL_SECTIONS } from "../src/tools-memory.mjs";
import { createRoleMemory } from "../src/role-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { principalAllowsContainer } from "../src/container-policy.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";

const A = { framework_id: "fa", group_id: "ga", user_id: "ua", agent_id: "aa", role_id: "ra" };
const B = { framework_id: "fb", group_id: "gb", user_id: "ub", agent_id: "bb", role_id: "rb" };
const SAME_GROUP = { framework_id: "fc", group_id: "ga", user_id: "uc", agent_id: "cc", role_id: "rc" };
const refs = ["evidence-followup"];
const sections = (names) => Object.fromEntries(names.map((name) => [name, `${name} content for isolation verification.`]));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-m1-2-followup-"));
  const writer = createMemoryWriter({ dataRoot: root });
  const plans = createPlansMemory({ dataRoot: root });
  const projects = createProjectMemory({ dataRoot: root });
  const tools = createToolsMemory({ dataRoot: root });
  const roles = createRoleMemory({ dataRoot: root });
  const profiles = createProfileMemory({ dataRoot: root });
  return { root, writer, plans, projects, tools, roles, profiles, async close() { await fs.rm(root, { recursive: true, force: true }); } };
}

test("M1.2 platform visibility is cross-group while private/group visibility remains isolated", () => {
  assert.equal(principalAllowsContainer(B, { container: "tool", visibility: "platform", group_id: "ga" }), true);
  assert.equal(principalAllowsContainer(B, { container: "knowledge", visibility: "platform", group_id: "ga" }), true);
  assert.equal(principalAllowsContainer(B, { container: "project", visibility: "project", project: "p", group_id: "ga" }), false);
  assert.equal(principalAllowsContainer(B, { container: "long-term", visibility: "shared", group_id: "ga" }), false);
});

test("direct repositories enforce principal filtering for plan/project/tool get and list", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  await f.plans.writePlan({ topic: "A plan", sections: { "目标": "目标 content", "步骤": "- [ ] verify isolation", "当前卡点": "none" }, evidence_refs: refs, principal: A });
  await f.projects.putCurrentState({ project: "A project", sections: sections(STATE_SECTIONS), evidence_refs: refs, principal: A });
  // 【契约变更 WRITE-DENY-1-REJECT2】工具记忆的目标容器只有 platform：要求 private 现在**显式 403**，
  // 不再静默落成 platform（静默降级会让调用方以为"写成功且私有"，实际全组可读）。
  await assert.rejects(
    () => f.tools.putToolNote({ tool_name: "A tool private", sections: sections(TOOL_SECTIONS), evidence_refs: refs, principal: { ...A, visibility: "private" } }),
    (error) => error?.code === "WRITE_SCOPE_DENIED" && error?.detail === "WRITE_SPACE_UNSUPPORTED",
    "requesting private for a tool note must be refused, not silently downgraded to platform",
  );
  await f.tools.putToolNote({ tool_name: "A tool", sections: sections(TOOL_SECTIONS), evidence_refs: refs, principal: A });
  assert.equal((await f.plans.listPlans({ principal: B })).length, 0);
  assert.equal(await f.plans.getPlan("A plan", B), null);
  assert.equal((await f.projects.listProjects(B)).length, 0);
  assert.equal((await f.projects.getProject("A project", B)).current_state, null);
  // 工具记忆是 platform 可见性 ⇒ 跨组可读（契约变更，见上面的 assert.rejects）。
  assert.equal((await f.tools.listTools({ principal: B })).length, 1, "tool notes are platform, so another group can list them");
  assert.equal((await f.tools.getTool("A tool", B)).tool_name, "A tool", "tool notes are platform, so another group can read them");
  assert.equal((await f.plans.getPlan("A plan", A)).topic, "A plan");
  assert.ok((await f.projects.getProject("A project", A)).current_state);
  assert.equal((await f.tools.getTool("A tool", A)).tool_name, "A tool");
});

test("nine-layer matrix uses real durable writes and repository reads", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const results = [];
  const record = (layer, aRead, bRead, sameGroupRead = null) => { results.push({ layer, a_write: true, a_read: Boolean(aRead), b_rejected: !bRead, same_group_read: sameGroupRead === null ? "n/a" : Boolean(sameGroupRead) }); };
  await f.writer.write({ layer: "curated-shared", id: "private-long", body: "private long-term", evidence_refs: refs, principal: A, visibility: "private" });
  await f.writer.write({ layer: "curated-shared", id: "shared-long", body: "shared long-term", evidence_refs: refs, principal: A, visibility: "shared" });
  const libA = createMemoryLib({ dataRoot: f.root, principal: A, vectorLane: { probe: false } });
  const libB = createMemoryLib({ dataRoot: f.root, principal: B, vectorLane: { probe: false } });
  const libSame = createMemoryLib({ dataRoot: f.root, principal: SAME_GROUP, vectorLane: { probe: false } });
  record("long-term", Boolean(await libA.get("shared-long")), Boolean(await libB.get("shared-long")), Boolean(await libSame.get("shared-long")));
  const roleWrite = await f.roles.putRoleNote({ agent_id: A.agent_id, role_id: A.role_id, group_id: A.group_id, user_id: A.user_id, sections: { "经验": "这是用于隔离验证的角色经验内容，长度足够。", "适用场景": "隔离测试场景", "边界": "仅允许原角色读取" }, evidence_refs: refs });
  record("role", Boolean(await f.roles.getRoleNote(roleWrite.id, A)), Boolean(await f.roles.getRoleNote(roleWrite.id, B)), false);
  await f.projects.putCurrentState({ project: "matrix", sections: sections(STATE_SECTIONS), evidence_refs: refs, principal: A });
  record("project", Boolean((await f.projects.getProject("matrix", A)).current_state), Boolean((await f.projects.getProject("matrix", B)).current_state), Boolean((await f.projects.getProject("matrix", SAME_GROUP)).current_state));
  await f.tools.putToolNote({ tool_name: "platform tool", sections: sections(TOOL_SECTIONS), evidence_refs: refs, principal: { ...A, visibility: "platform" } });
  record("tool", Boolean(await f.tools.getTool("platform tool", A)), Boolean(await f.tools.getTool("platform tool", B)), Boolean(await f.tools.getTool("platform tool", SAME_GROUP)));
  await f.plans.writePlan({ topic: "matrix plan", sections: { "目标": "目标 content", "步骤": "- [ ] verify isolation", "当前卡点": "none" }, evidence_refs: refs, principal: A });
  record("plan", Boolean(await f.plans.getPlan("matrix plan", A)), Boolean(await f.plans.getPlan("matrix plan", B)), false);
  const temp = await f.writer.putTemporary({ key: "matrix-temp", body: "temporary", principal: A });
  record("temporary", Boolean(await f.writer.getTemporary("matrix-temp", A)), Boolean(await f.writer.getTemporary("matrix-temp", B)), false);
  await f.writer.write({ layer: "document", id: "knowledge-doc", body: "knowledge", evidence_refs: refs, principal: A, visibility: "platform" });
  record("knowledge", Boolean(await libA.get("knowledge-doc")), Boolean(await libB.get("knowledge-doc")), Boolean(await libSame.get("knowledge-doc")));
  results.push({ layer: "evidence", status: "N/A", reason: "raw conversation evidence is storage-only and has no durable read repository" });
  results.push({ layer: "graph", status: "N/A", reason: "graph repository is M1.3 scope and intentionally not implemented" });
  assert.deepEqual(results.map((x) => x.layer), ["long-term", "role", "project", "tool", "plan", "temporary", "knowledge", "evidence", "graph"]);
  assert.ok(results.filter((x) => x.status !== "N/A").every((x) => x.a_write && x.a_read && (x.layer === "tool" || x.layer === "knowledge" || x.b_rejected)));
  assert.equal(results.find((x) => x.layer === "project").same_group_read, true);
  assert.equal(results.find((x) => x.layer === "tool").b_rejected, false);
  assert.equal(results.find((x) => x.layer === "knowledge").b_rejected, false);
  console.log(JSON.stringify(results));
});
