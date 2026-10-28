import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createIndexStore } from "../src/index-store.mjs";
import { applyMigration, layerForContainer, planMigration } from "../src/migrate-memory.mjs";
import { jointSearch } from "../src/graph-retrieval.mjs";
import { createProjectMemory } from "../src/project-memory.mjs";
import { createPlansMemory } from "../src/plans-memory.mjs";
import { createToolsMemory } from "../src/tools-memory.mjs";
import { createRoleMemory } from "../src/role-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m14-"));
  const dataRoot = path.join(root, "memory");
  await fs.mkdir(path.join(dataRoot, "curated", "shared"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "curated", "shared", "legacy.md"), "---\nid: legacy\nlayer: semantic\ncontainer: semantic\nvisibility: private\nevidence_refs: []\n---\nLegacy body\n", "utf8");
  await fs.mkdir(path.join(dataRoot, "curated", "agents", "main"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "curated", "agents", "main", "notes.md"), "# Agent note\n\nKeep this body.\n", "utf8");
  await fs.mkdir(path.join(dataRoot, "project-state"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "project-state", "README.md"), "# Project State\n\nInstructions.\n", "utf8");
  return { root, dataRoot };
}

test("M1.4 CLI refuses apply without explicit roots and rejects nested snapshots", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const cli = path.resolve("scripts/migrate-memory.mjs");
  const untouched = await fs.readFile(path.join(f.dataRoot, "curated", "shared", "legacy.md"), "utf8");
  const missing = spawnSync(process.execPath, [cli, "--apply"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /dataRoot is required/);
  assert.equal(await fs.readFile(path.join(f.dataRoot, "curated", "shared", "legacy.md"), "utf8"), untouched);
  const nested = spawnSync(process.execPath, [cli, "--apply", "--data-root", f.dataRoot, "--snapshot-root", path.join(f.dataRoot, "snapshot")], { encoding: "utf8" });
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /snapshotRoot must be outside dataRoot/);
  const snapshot = path.join(f.root, "snapshot");
  const valid = spawnSync(process.execPath, [cli, "--apply", "--data-root", f.dataRoot, "--snapshot-root", snapshot], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /body_sha256_before/);
  assert.match(valid.stdout, /body_sha256_same: true|\"body_sha256_same\": true/);
});

test("M1.4 all durable Markdown writers emit tenant_id and valid containers", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const principal = { tenant_id: "tenant-entrypoint", framework_id: "fw", group_id: "group-a", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
  const refs = ["evidence:entrypoint"];
  const sections = { "目标": "目标内容", "步骤": "- [ ] 步骤内容", "当前卡点": "无" };
  const projectSections = { "目标": "项目目标", "当前进展": "项目进展", "下一步": "项目下一步", "阻塞": "无" };
  const decisionSections = { "决定": "采用方案", "理由": "理由内容", "影响": "影响内容" };
  const roleSections = { "经验": "这是一个长度足够并且超过十五个字符的经验总结", "适用场景": "测试场景", "边界": "测试边界" };
  const cases = [];
  const project = createProjectMemory({ dataRoot: f.dataRoot });
  cases.push((await project.putCurrentState({ project: "entry-project", sections: projectSections, evidence_refs: refs, principal })).path);
  cases.push((await project.appendDecision({ project: "entry-project", slug: "decision", sections: decisionSections, evidence_refs: refs, principal })).path);
  const plans = createPlansMemory({ dataRoot: f.dataRoot });
  cases.push((await plans.writePlan({ topic: "entry-plan", sections, evidence_refs: refs, principal })).path);
  const tools = createToolsMemory({ dataRoot: f.dataRoot });
  cases.push((await tools.putToolNote({ tool_name: "entry-tool", kind: "tool", sections: { 用途: "工具用途内容", 接入方式: "接入方式内容", 关键参数: "关键参数内容", 已知坑: "已知问题内容", 验证方式: "验证方式内容" }, evidence_refs: refs, principal })).path);
  const roles = createRoleMemory({ dataRoot: f.dataRoot });
  cases.push((await roles.putRoleNote({ agent_id: "agent-a", role_id: "role-a", tenant_id: principal.tenant_id, kind: "lesson", sections: roleSections, evidence_refs: refs })).path);
  const allowed = new Set(["temporary", "evidence", "long-term", "project", "tool", "graph", "plan", "role", "knowledge"]);
  for (const file of cases) {
    const { frontmatter } = parseFrontmatterTyped(await fs.readFile(file, "utf8"));
    assert.equal(frontmatter.tenant_id, "tenant-entrypoint", file);
    assert.ok(allowed.has(frontmatter.container), `${file}: ${frontmatter.container}`);
    assert.ok(allowed.has(frontmatter.layer), `${file}: invalid layer ${frontmatter.layer}`);
  }
});

test("MAINT1 migration maps every supported container to a valid layer", () => {
  const cases = [["long-term", "long-term"], ["role", "role"], ["project", "project"], ["tool", "tool"], ["plan", "plan"], ["knowledge", "knowledge"], ["semantic", null], ["unknown", null]];
  const allowed = new Set(["long-term", "role", "project", "tool", "plan", "temporary", "knowledge", "evidence", "graph"]);
  for (const [container, expected] of cases) {
    const layer = layerForContainer(container);
    assert.equal(layer, expected, container);
    if (layer) assert.ok(allowed.has(layer));
  }
});

test("M1.4 migration plans tenant/container/layer/visibility changes without body edits", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const beforeBody = await fs.readFile(path.join(f.dataRoot, "curated", "shared", "legacy.md"), "utf8");
  const plan = await planMigration({ dataRoot: f.dataRoot });
  assert.equal(plan.rows.length, 2);
  assert.ok(plan.rows.every((row) => row.bodyShaBefore === row.bodyShaAfter));
  assert.deepEqual(plan.rows.find((row) => row.file === "curated/shared/legacy.md").changes.layer, ["semantic", "long-term"]);
  assert.ok(plan.rows.every((row) => row.changes.layer));
  assert.deepEqual(plan.classifications, [
    { file: "curated/agents/main/notes.md", kind: "memory", reason: "agent memory path" },
    { file: "project-state/README.md", kind: "documentation", reason: "README documentation" },
  ]);
  const snapshot = path.join(f.root, "snapshot");
  await applyMigration({ dataRoot: f.dataRoot, plan, snapshotRoot: snapshot });
  const migrated = await fs.readFile(path.join(f.dataRoot, "curated", "shared", "legacy.md"), "utf8");
  assert.match(migrated, /tenant_id: "default"/);
  assert.match(migrated, /container: "long-term"/);
  assert.match(migrated, /layer: "long-term"/);
  assert.match(migrated, /visibility: private/);
  assert.match(migrated, /Legacy body/);
  assert.equal(migrated.slice(migrated.indexOf("---", 4)), beforeBody.slice(beforeBody.indexOf("---", 4)));
  const second = await planMigration({ dataRoot: f.dataRoot });
  assert.equal(second.rows.length, 0);
  assert.equal(await fs.readFile(path.join(f.dataRoot, "project-state", "README.md"), "utf8"), "# Project State\n\nInstructions.\n");
  const index = createIndexStore({ dataRoot: f.dataRoot, fetchImpl: async () => { throw new Error("vector service not required"); } });
  const indexed = await index.index();
  assert.equal(indexed.scanned, 2);
});

test("M1.4 production-shaped principal defaults tenant and joint FTS sees new memory", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const writer = createMemoryWriter({ dataRoot: f.dataRoot });
  const written = await writer.write({ layer: "curated-shared", id: "new-memory", body: "tenant default searchable phrase", evidence_refs: ["ev:new"] });
  const text = await fs.readFile(written.path, "utf8");
  assert.match(text, /tenant_id: "default"/);
  const index = createIndexStore({ dataRoot: f.dataRoot, ollama: { dimension: 1 }, fetchImpl: async () => { throw new Error("vector service not required"); } });
  await index.index();
  const result = await jointSearch({ dataRoot: f.dataRoot, tenantId: "default", principal: {}, query: "tenant default searchable phrase", fetchImpl: async () => { throw new Error("vector service not required"); } });
  assert.ok(result.some((row) => row.path === written.path && row.matched_by.includes("fts")));
});
