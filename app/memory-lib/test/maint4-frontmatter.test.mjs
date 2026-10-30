import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createProjectMemory } from "../src/project-memory.mjs";
import { createPlansMemory } from "../src/plans-memory.mjs";
import { createToolsMemory } from "../src/tools-memory.mjs";
import { createRoleMemory } from "../src/role-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { createColdLayer } from "../src/cold-layer.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { scanDuplicateFrontmatter } from "../src/duplicate-frontmatter.mjs";

const principal = {
  tenant_id: "tenant-maint4",
  framework_id: "framework-maint4",
  group_id: "group-maint4",
  user_id: "user-maint4",
  agent_id: "agent-maint4",
  role_id: "role-maint4",
};
const refs = ["evidence:maint4"];
const planSections = { "目标": "目标", "步骤": "- [ ] 步骤", "当前卡点": "无" };
const toolSections = { 用途: "用途", 接入方式: "接入", 关键参数: "参数", 已知坑: "问题", 验证方式: "验证" };
const roleSections = { 经验: "这是一个长度超过十五字符的经验总结", 适用场景: "测试场景", 边界: "测试边界" };
const projectSections = { "目标": "目标", "当前进展": "进展", "下一步": "下一步", "阻塞": "无" };
const decisionSections = { "决定": "决定", "理由": "理由", "影响": "影响" };

function duplicateKeys(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  const counts = new Map();
  for (const line of match?.[1]?.split(/\r?\n/u) ?? []) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([key]) => key);
}

async function assertWritten(file, expectedPrincipal = principal) {
  const text = await fs.readFile(file, "utf8");
  assert.deepEqual(duplicateKeys(text), [], `${file} has duplicate frontmatter keys`);
  const { frontmatter } = parseFrontmatterTyped(text);
  for (const key of ["tenant_id", "framework_id", "group_id", "user_id", "agent_id", "role_id"]) {
    if (Object.hasOwn(frontmatter, key)) assert.equal(frontmatter[key], expectedPrincipal[key] ?? null, `${file}: ${key} must match principal`);
  }
}

test("MAINT4 table-driven durable writers emit unique identity frontmatter", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint4-writers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "memory");
  const files = [];
  const writer = createMemoryWriter({ dataRoot });
  files.push(["createMemoryWriter().write curated-shared", (await writer.write({ layer: "curated-shared", id: "m4-shared", body: "shared", evidence_refs: refs, principal })).path]);
  files.push(["createMemoryWriter().write agent", (await writer.write({ layer: "agent", agent: principal.agent_id, role_id: "spoofed-role", id: "m4-agent", body: "agent", evidence_refs: refs, principal })).path]);
  files.push(["createMemoryWriter().write tool", (await writer.write({ layer: "tool", id: "m4-tool", body: "tool", evidence_refs: refs, principal })).path]);
  files.push(["createMemoryWriter().write plan", (await writer.write({ layer: "plan", id: "m4-plan", body: "plan", evidence_refs: refs, principal })).path]);
  files.push(["createMemoryWriter().write document", (await writer.write({ layer: "document", id: "m4-document", body: "document", evidence_refs: refs, principal })).path]);
  files.push(["createMemoryWriter().writeProgress", (await writer.writeProgress({ project: "m4-project", entries: [{ topic: "目标与范围", at: "2026-01-01", text: "progress" }], evidence_refs: refs, principal })).path]);
  const project = createProjectMemory({ dataRoot });
  files.push(["putCurrentState", (await project.putCurrentState({ project: "m4-project", sections: projectSections, evidence_refs: refs, principal })).path]);
  files.push(["appendDecision", (await project.appendDecision({ project: "m4-project", slug: "decision", sections: decisionSections, evidence_refs: refs, principal })).path]);
  const plans = createPlansMemory({ dataRoot });
  files.push(["writePlan", (await plans.writePlan({ topic: "m4-plan-api", sections: planSections, evidence_refs: refs, principal })).path]);
  const tools = createToolsMemory({ dataRoot });
  files.push(["putToolNote", (await tools.putToolNote({ tool_name: "m4-tool-api", sections: toolSections, evidence_refs: refs, principal })).path]);
  const roles = createRoleMemory({ dataRoot });
  files.push(["putRoleNote", (await roles.putRoleNote({ ...principal, sections: roleSections, evidence_refs: refs })).path]);
  const profileDir = path.join(dataRoot, "profile");
  const profileFile = path.join(profileDir, "m4-profile.md");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profileFile, `---\nid: m4-profile\nlayer: long-term\ncontainer: long-term\ntenant_id: ${principal.tenant_id}\nvisibility: private\nkind: profile\nstatus: draft\nevidence_refs: [\"evidence:maint4\"]\nframework_id: ${principal.framework_id}\ngroup_id: ${principal.group_id}\nuser_id: ${principal.user_id}\nagent_id: ${principal.agent_id}\nrole_id: ${principal.role_id}\n---\nprofile body\n`, "utf8");
  const profiles = createProfileMemory({ dataRoot });
  files.push(["confirm", (await profiles.confirm("m4-profile", { evidence_refs: refs, principal })).path]);
  for (const [name, file] of files) await assertWritten(file, principal).catch((error) => { error.message = `${name}: ${error.message}`; throw error; });
});

test("MAINT4 scanner reports duplicate keys in a temporary data root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint4-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const duplicate = path.join(root, "duplicate.md");
  const clean = path.join(root, "clean.md");
  await fs.writeFile(duplicate, "---\nid: one\nrole_id: first\nrole_id: second\n---\nbody\n", "utf8");
  await fs.writeFile(clean, "---\nid: two\nrole_id: only\n---\nbody\n", "utf8");
  const result = await scanDuplicateFrontmatter(root);
  assert.deepEqual(result, [{ path: duplicate, keys: ["role_id"] }]);
});

test("MAINT4 cold refresh keeps unique principal metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint4-cold-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "curated", "_cold-2026", "cold.md");
  const target = path.join(root, "curated", "shared", "cold.md");
  await fs.mkdir(path.dirname(source), { recursive: true });
  const writer = createMemoryWriter({ dataRoot: root });
  const created = await writer.write({ layer: "curated-shared", id: "cold", body: "cold body", evidence_refs: refs, principal });
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.rename(created.path, source);
  const text = await fs.readFile(source, "utf8");
  await fs.writeFile(source, text.replace('status: "active"', 'status: "cold"').replace('---\n\ncold body', `cold_original_path: ${JSON.stringify(target)}\n---\n\ncold body`), "utf8");
  const cold = createColdLayer({ dataRoot: root });
  await cold.refresh("cold", { body: "refreshed", principal, evidence_refs: refs });
  await assertWritten(target, principal);
});
