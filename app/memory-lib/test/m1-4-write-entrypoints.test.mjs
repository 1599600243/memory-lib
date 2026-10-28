import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createProjectMemory } from "../src/project-memory.mjs";
import { createPlansMemory } from "../src/plans-memory.mjs";
import { createToolsMemory } from "../src/tools-memory.mjs";
import { createRoleMemory } from "../src/role-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { applyMigration, planMigration } from "../src/migrate-memory.mjs";
import { createRefinementJobs } from "../src/refinement-jobs.mjs";
import { parseFrontmatterTyped, updateFrontmatterFields } from "../src/frontmatter-util.mjs";

const inventory = await fs.readFile(path.resolve("memory-write-entrypoints.md"), "utf8");
const entryNames = [...inventory.matchAll(/^\| `[^`]+` \| `([^`]+)` \|/gmu)].map((match) => match[1]);
const testTable = new Set([
  "createMemoryWriter().write",
  "createMemoryWriter().writeProgress",
  "createMemoryWriter().mergeEvidenceRefs",
  "submit",
  "putCurrentState",
  "appendDecision",
  "writePlan",
  "transition",
  "putToolNote",
  "refreshStatus",
  "putRoleNote",
  "evidence merge/supersede rewrites",
  "confirm",
  "applyMigration",
]);

function sections() {
  return { "目标": "目标", "步骤": "- [ ] 步骤", "当前卡点": "无" };
}
function roleSections() {
  return { "经验": "这是一个长度足够并且超过十五个字符的经验总结", "适用场景": "测试场景", "边界": "测试边界" };
}
async function read(pathname) { return parseFrontmatterTyped(await fs.readFile(pathname, "utf8")); }
function assertMetadata(frontmatter, tenant = "tenant-table") {
  const allowed = new Set(["temporary", "evidence", "long-term", "project", "tool", "graph", "plan", "role", "knowledge"]);
  assert.equal(frontmatter.tenant_id, tenant);
  assert.ok(allowed.has(frontmatter.container), `invalid container ${frontmatter.container}`);
}
function assertOnlyExpectedRemoved(before, after, expected = []) {
  const missing = Object.keys(before).filter((key) => !(key in after) && !expected.includes(key));
  assert.deepEqual(missing, [], `frontmatter fields were removed: ${missing.join(", ")}`);
}
function bodySha(text) { return crypto.createHash("sha256").update(parseFrontmatterTyped(text).body, "utf8").digest("hex"); }

test("M1.4 inventory and test table have identical entry names", () => {
  assert.deepEqual([...new Set(entryNames)], [...testTable]);
});

test("M1.4 every listed Markdown writer and rewrite preserves metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m14-entrypoints-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "memory");
  const principal = { tenant_id: "tenant-table", framework_id: "fw", group_id: "group-a", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
  const refs = ["evidence:table"];
  const writer = createMemoryWriter({ dataRoot });
  const created = [];
  created.push(["createMemoryWriter().write", (await writer.write({ layer: "curated-shared", id: "table-shared", body: "shared body", evidence_refs: refs, principal })).path]);
  created.push(["createMemoryWriter().writeProgress", (await writer.writeProgress({ project: "table-project", entries: [{ topic: "目标与范围", at: "2026-01-01", text: "progress body" }], evidence_refs: refs, principal })).path]);
  const project = createProjectMemory({ dataRoot });
  created.push(["putCurrentState", (await project.putCurrentState({ project: "table-project", sections: { "目标": "目标", "当前进展": "进展", "下一步": "下一步", "阻塞": "无" }, evidence_refs: refs, principal })).path]);
  created.push(["appendDecision", (await project.appendDecision({ project: "table-project", slug: "table-decision", sections: { "决定": "决定", "理由": "理由", "影响": "影响" }, evidence_refs: refs, principal })).path]);
  const plans = createPlansMemory({ dataRoot });
  created.push(["writePlan", (await plans.writePlan({ topic: "table-plan", sections: sections(), evidence_refs: refs, principal })).path]);
  const tools = createToolsMemory({ dataRoot });
  created.push(["putToolNote", (await tools.putToolNote({ tool_name: "table-tool", sections: { 用途: "用途", 接入方式: "接入", 关键参数: "参数", 已知坑: "问题", 验证方式: "验证" }, evidence_refs: refs, principal })).path]);
  const roles = createRoleMemory({ dataRoot });
  const role = await roles.putRoleNote({ agent_id: "agent-a", role_id: "role-a", tenant_id: "tenant-table", group_id: "group-a", user_id: "user-a", sections: roleSections(), evidence_refs: refs });
  created.push(["putRoleNote", role.path]);
  for (const [name, file] of created) assertMetadata((await read(file)).frontmatter);

  // `createMemoryWriter().mergeEvidenceRefs`：提炼提交 merge 路径用的"就地重写"。
  // 它改写**已有的那个文件**，所以除了 evidence_refs / updated_at 之外，元数据必须原样保留。
  const sharedFile = created[0][1];
  const sharedBeforeText = await fs.readFile(sharedFile, "utf8");
  const sharedBefore = parseFrontmatterTyped(sharedBeforeText).frontmatter;
  const mergedShared = await writer.mergeEvidenceRefs({ filePath: sharedFile, evidence_refs: ["evidence:table-merge"] });
  const sharedAfterText = await fs.readFile(sharedFile, "utf8");
  const sharedAfter = parseFrontmatterTyped(sharedAfterText).frontmatter;
  assertOnlyExpectedRemoved(sharedBefore, sharedAfter);
  assertMetadata(sharedAfter);
  assert.equal(mergedShared.path, sharedFile, "a merge rewrites the existing file, it does not create a second one");
  assert.equal(sharedAfter.id, "table-shared", "a merge keeps the existing id");
  assert.equal(sharedAfter.layer, "long-term", "a merge keeps the existing layer");
  assert.equal(sharedAfter.container, "long-term", "a merge keeps the existing container");
  assert.deepEqual(sharedAfter.evidence_refs, ["evidence:table", "evidence:table-merge"], "a merge unions the evidence refs in order");
  assert.equal(bodySha(sharedBeforeText), bodySha(sharedAfterText), "a merge never rewrites the body");
  assert.notEqual(sharedAfter.updated_at, sharedBefore.updated_at, "a merge refreshes updated_at");

  const progressFile = created[1][1];
  const progressBefore = await read(progressFile);
  await writer.writeProgress({ project: "table-project", entries: [{ topic: "目标与范围", at: "2026-01-02", text: "second progress" }], evidence_refs: refs, principal });
  const progressAfter = await read(progressFile);
  assertOnlyExpectedRemoved(progressBefore.frontmatter, progressAfter.frontmatter);
  assertMetadata(progressAfter.frontmatter);
  const progressTextAfterOne = await fs.readFile(progressFile, "utf8");
  await writer.writeProgress({ project: "table-project", entries: [{ topic: "目标与范围", at: "2026-01-03", text: "third progress" }], evidence_refs: refs, principal });
  const progressTextAfterTwo = await fs.readFile(progressFile, "utf8");
  await writer.writeProgress({ project: "table-project", entries: [{ topic: "目标与范围", at: "2026-01-04", text: "fourth progress" }], evidence_refs: refs, principal });
  const progressTextAfterThree = await fs.readFile(progressFile, "utf8");
  for (const text of [progressTextAfterOne, progressTextAfterTwo, progressTextAfterThree]) {
    assert.equal((text.match(/# 项目进度 · table-project/g) ?? []).length, 1);
    assert.equal((text.match(/- 2026-01-01 · progress body/g) ?? []).length, 1);
  }
  assert.ok(progressTextAfterThree.length > progressTextAfterTwo.length);
  assert.ok(progressTextAfterTwo.length > progressTextAfterOne.length);

  const planFile = created[4][1];
  let planText = await fs.readFile(planFile, "utf8");
  planText = updateFrontmatterFields(planText, { "custom_field": JSON.stringify("preserve-plan"), group_id: JSON.stringify("group-a"), visibility: JSON.stringify("private") });
  await fs.writeFile(planFile, planText, "utf8");
  const planBeforeText = await fs.readFile(planFile, "utf8");
  const planBefore = parseFrontmatterTyped(planBeforeText).frontmatter;
  await plans.confirm("table-plan");
  const planAfterText = await fs.readFile(planFile, "utf8");
  const planAfter = parseFrontmatterTyped(planAfterText).frontmatter;
  assertOnlyExpectedRemoved(planBefore, planAfter);
  assert.equal(bodySha(planBeforeText), bodySha(planAfterText));
  assertMetadata(planAfter);
  const planDoneBeforeText = planAfterText;
  await plans.markDone("table-plan");
  const planDoneAfterText = await fs.readFile(planFile, "utf8");
  assertOnlyExpectedRemoved(parseFrontmatterTyped(planDoneBeforeText).frontmatter, parseFrontmatterTyped(planDoneAfterText).frontmatter);
  assert.equal(bodySha(planDoneBeforeText), bodySha(planDoneAfterText));
  assertMetadata(parseFrontmatterTyped(planDoneAfterText).frontmatter);

  const toolFile = created[5][1];
  let toolText = await fs.readFile(toolFile, "utf8");
  toolText = updateFrontmatterFields(toolText, { verified_at: JSON.stringify("2020-01-01T00:00:00.000Z"), custom_field: JSON.stringify("preserve-tool") });
  await fs.writeFile(toolFile, toolText, "utf8");
  const toolBeforeText = await fs.readFile(toolFile, "utf8");
  const toolBefore = parseFrontmatterTyped(toolBeforeText).frontmatter;
  await tools.refreshStatus();
  const toolAfterText = await fs.readFile(toolFile, "utf8");
  const toolAfter = parseFrontmatterTyped(toolAfterText).frontmatter;
  assertOnlyExpectedRemoved(toolBefore, toolAfter);
  assert.equal(bodySha(toolBeforeText), bodySha(toolAfterText));
  assertMetadata(toolAfter);

  let roleText = await fs.readFile(role.path, "utf8");
  roleText = updateFrontmatterFields(roleText, { custom_field: JSON.stringify("preserve-role"), container: JSON.stringify("role"), visibility: JSON.stringify("role"), group_id: JSON.stringify("group-a"), user_id: JSON.stringify("user-a") });
  await fs.writeFile(role.path, roleText, "utf8");
  const roleBeforeText = await fs.readFile(role.path, "utf8");
  const roleBefore = parseFrontmatterTyped(roleBeforeText).frontmatter;
  await roles.putRoleNote({ agent_id: "agent-a", role_id: "role-a", tenant_id: "tenant-table", group_id: "group-a", user_id: "user-a", sections: roleSections(), evidence_refs: ["evidence:table-merge"] });
  const roleAfterMergeText = await fs.readFile(role.path, "utf8");
  const roleAfterMerge = parseFrontmatterTyped(roleAfterMergeText).frontmatter;
  assertOnlyExpectedRemoved(roleBefore, roleAfterMerge);
  assert.equal(bodySha(roleBeforeText), bodySha(roleAfterMergeText));
  assertMetadata(roleAfterMerge);
  const replacement = await roles.putRoleNote({ agent_id: "agent-a", role_id: "role-a", tenant_id: "tenant-table", group_id: "group-a", user_id: "user-a", sections: { ...roleSections(), "经验": "这是一个完全不同且长度足够的替代经验总结内容" }, evidence_refs: refs, supersedes: role.id });
  const roleAfterSupersedeText = await fs.readFile(role.path, "utf8");
  const roleAfterSupersede = parseFrontmatterTyped(roleAfterSupersedeText).frontmatter;
  assertOnlyExpectedRemoved(roleAfterMerge, roleAfterSupersede);
  assert.equal(bodySha(roleAfterMergeText), bodySha(roleAfterSupersedeText));
  assertMetadata(roleAfterSupersede);
  assert.equal((await read(replacement.path)).frontmatter.tenant_id, "tenant-table");

  const profileDir = path.join(dataRoot, "profile");
  const profileFile = path.join(profileDir, "table-profile.md");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profileFile, `---\nid: table-profile\nlayer: long-term\ncontainer: long-term\ntenant_id: tenant-table\nvisibility: private\nkind: profile\nstatus: draft\nevidence_refs: ["evidence:profile"]\ncustom_field: preserve-profile\n---\nprofile body\n`, "utf8");
  const profile = createProfileMemory({ dataRoot });
  const profileBeforeText = await fs.readFile(profileFile, "utf8");
  const profileBefore = parseFrontmatterTyped(profileBeforeText).frontmatter;
  await profile.confirm("table-profile", { evidence_refs: ["evidence:profile"], principal });
  const profileAfterText = await fs.readFile(profileFile, "utf8");
  const profileAfter = parseFrontmatterTyped(profileAfterText).frontmatter;
  assertOnlyExpectedRemoved(profileBefore, profileAfter);
  assert.equal(bodySha(profileBeforeText), bodySha(profileAfterText));
  assertMetadata(profileAfter);

  const abandonPlan = await plans.writePlan({ topic: "table-abandon", sections: sections(), evidence_refs: refs, principal });
  const abandonBeforeText = await fs.readFile(abandonPlan.path, "utf8");
  const abandonBefore = parseFrontmatterTyped(abandonBeforeText).frontmatter;
  await plans.abandon("table-abandon");
  const abandonAfterText = await fs.readFile(abandonPlan.path, "utf8");
  const abandonAfter = parseFrontmatterTyped(abandonAfterText).frontmatter;
  assertOnlyExpectedRemoved(abandonBefore, abandonAfter);
  assert.equal(bodySha(abandonBeforeText), bodySha(abandonAfterText));
  assertMetadata(abandonAfter);

  const migrateRoot = path.join(root, "migration-memory");
  await fs.mkdir(path.join(migrateRoot, "project-state", "legacy"), { recursive: true });
  await fs.writeFile(path.join(migrateRoot, "project-state", "legacy", "progress.md"), "legacy body\n", "utf8");
  const migration = await planMigration({ dataRoot: migrateRoot });
  const snapshot = path.join(root, "migration-snapshot");
  await applyMigration({ dataRoot: migrateRoot, plan: migration, snapshotRoot: snapshot });
  const migrated = parseFrontmatterTyped(migration.rows[0]?.after ?? "");
  assert.equal(migrated.frontmatter.tenant_id, "default");
  assert.equal(migrated.frontmatter.container, "project");
});

// 提炼提交（MEMORY-LOOP-1）是**新的正式 Markdown 写入口**：它不自己拼 frontmatter，
// 而是把每条结论交给同一个 memory writer（write / mergeEvidenceRefs / supersede）。
// 这一条把"清单里的那一行"变成**真实用例**：真写一次、真合并一次，逐字段核对元数据。
test("M1.4 refinement submit delegates to the shared Markdown writer (write + stable-key merge) and preserves metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m14-refinement-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "memory");
  const principal = { tenant_id: "tenant-table", framework_id: "fw", group_id: "group-a", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
  const workspace = "D:/work/table-refine";
  const project = "d-work-table-refine";
  const stableKey = "m1-4-entry-table-key";
  const body = "M1.4 入口清单：提炼提交必须复用同一个 Markdown writer，不许自己拼 frontmatter。";
  const evidenceFor = (evidenceId) => ({
    id: evidenceId,
    path: path.join(dataRoot, "evidence", "conversations", `${evidenceId}.md`),
    frontmatter: { id: evidenceId, type: "conversation", workspace: JSON.stringify(workspace), groupId: JSON.stringify(principal.group_id), userId: JSON.stringify(principal.user_id) },
    body: "# 原始对话记录\n",
  });
  const writer = createMemoryWriter({ dataRoot });
  const jobs = createRefinementJobs({ dataRoot });
  const collaborators = {
    assertion: () => {},
    verifyEvidence: async (evidenceId) => evidenceFor(evidenceId),
    writeMemory: (input) => writer.write(input),
    findActiveMemory: (query) => writer.findActiveByStableKey(query),
    readableMemory: async () => true,
    mergeMemory: (input) => writer.mergeEvidenceRefs(input),
    supersedeMemory: (input) => writer.supersede(input),
    targetPathOf: (input) => writer.targetPathFor(input),
  };
  const evidenceA = "conversation-0123456789abcdef0123456c";
  const evidenceB = "conversation-0123456789abcdef0123456d";

  const jobA = await jobs.recordCapture({ evidenceId: evidenceA, conversationId: "table-refine-a", workspace, principal });
  assert.equal(jobA.project, project, "the job project must be derived from the capture workspace");
  await jobs.claim({ job_id: jobA.job_id, principal });
  const first = await jobs.submit({
    job_id: jobA.job_id,
    principal,
    body: { conclusions: [{ layer: "project-decision", id: "table-refine-decision", body, evidence_refs: [evidenceA], stable_key: stableKey }] },
    ...collaborators,
  });
  assert.equal(first.ok, true, `the refinement submit must succeed, got ${JSON.stringify(first)}`);
  assert.equal(first.job.state, "completed");
  const decisionPath = path.join(dataRoot, "project-state", project, "decisions", "table-refine-decision.md");
  assert.equal(first.receipt.writes[0].path, decisionPath, "the conclusion must land through the shared writer's project-decision path");
  const written = parseFrontmatterTyped(await fs.readFile(decisionPath, "utf8")).frontmatter;
  assertMetadata(written);
  assert.equal(written.id, "table-refine-decision");
  assert.equal(written.layer, "project");
  assert.equal(written.project, project);
  assert.equal(written.visibility, "project");
  assert.equal(written.stable_key, stableKey, `the written memory must carry the stable_key, got ${JSON.stringify(written.stable_key)}`);
  assert.deepEqual(written.evidence_refs, [evidenceA]);

  // 第二次提交：同 stable_key、同正文 ⇒ 走 mergeEvidenceRefs 就地重写（不产生第二个文件）。
  const jobB = await jobs.recordCapture({ evidenceId: evidenceB, conversationId: "table-refine-b", workspace, principal });
  await jobs.claim({ job_id: jobB.job_id, principal });
  const merged = await jobs.submit({
    job_id: jobB.job_id,
    principal,
    body: { conclusions: [{ layer: "project-decision", id: "table-refine-decision-b", body: `${body}\r\n`, evidence_refs: [evidenceB], stable_key: stableKey }] },
    ...collaborators,
  });
  assert.equal(merged.ok, true, `the merge submission must succeed, got ${JSON.stringify(merged)}`);
  assert.equal(merged.receipt.outcome, "merged", `a same-body same-key submission must merge, got ${JSON.stringify(merged.receipt)}`);
  assert.equal(merged.receipt.writes[0].path, decisionPath, "a merge rewrites the existing file");
  const afterMerge = parseFrontmatterTyped(await fs.readFile(decisionPath, "utf8")).frontmatter;
  assertMetadata(afterMerge);
  assert.equal(afterMerge.id, "table-refine-decision");
  assert.equal(afterMerge.stable_key, stableKey);
  assert.deepEqual(afterMerge.evidence_refs, [evidenceA, evidenceB], `the merge must union the evidence, got ${JSON.stringify(afterMerge.evidence_refs)}`);
  const files = await fs.readdir(path.join(dataRoot, "project-state", project, "decisions"));
  assert.deepEqual(files.sort(), ["table-refine-decision.md"], `a merge must not create a second file, got ${JSON.stringify(files)}`);
});
