#!/usr/bin/env node
// VISIBILITY-FIX-1 追加 —— **修前读数**的可靠获取方式。
//
// 做法：从 git 取**修前**版本的源码文件到临时目录，再用一份"按目录加载"的探针副本去量。
// 为什么不用 `git checkout` 覆盖工作树：本单只许收紧、不许破坏工作树；覆盖一旦漏还原就是事故
// （本单已经发生过一次：一次 checkout 把 learning.mjs 的修复抹掉，只能重做）。
//
// 用法：node scripts/probe-visfix1-before.mjs <srcDir> <outJson>
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.argv[2];
const OUT = process.argv[3] ?? "D:\\MemoryLib\\reports\\VISIBILITY-FIX-1-audit-BEFORE.json";
if (!SRC) throw new Error("usage: node probe-visfix1-before.mjs <srcDir> [outJson]");
const load = (name) => import(pathToFileURL(path.join(SRC, name)).href);

const { createPlansMemory } = await load("plans-memory.mjs");
const { createProfileMemory } = await load("profile-memory.mjs");
const { createRoleMemory } = await load("role-memory.mjs");
const { createToolsMemory } = await load("tools-memory.mjs");
const { createProjectMemory } = await load("project-memory.mjs");
const { createPetRuntimeStore } = await load("pet-runtime-store.mjs");
const { createGraphStore } = await load("graph-retrieval.mjs");
const { createLearningApi } = await load("learning.mjs");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1-before-"));
const dataRoot = path.join(tmp, "memory");
const TS = "2026-09-24T02:00:00.000Z";
const V = "AUDIT-VICTIM-PRIVATE";
const M = "AUDIT-MINE-VISIBLE";
const victim = { framework_id: "f", tenant_id: "default", group_id: "g-VICTIM", user_id: "u-VICTIM", agent_id: "agent-VICTIM", role_id: "role-VICTIM" };
const me = { framework_id: "f", tenant_id: "default", group_id: "g-ME", user_id: "u-ME", agent_id: "agent-ME", role_id: "role-ME" };

const plans = createPlansMemory({ dataRoot });
const profiles = createProfileMemory({ dataRoot });
const roles = createRoleMemory({ dataRoot });
const tools = createToolsMemory({ dataRoot });
const project = createProjectMemory({ dataRoot, graphStore: createGraphStore({ dataRoot }) });
const pet = createPetRuntimeStore({ dataRoot, workspaceRoot: tmp });
const learning = createLearningApi(path.join(tmp, "learning"));

const toolSec = (x) => ({ 用途: x, 接入方式: "-", 关键参数: "-", 已知坑: "-", 验证方式: "-" });
await plans.writePlan({ topic: "victim-plan", status: "draft", evidence_refs: ["ev:1"], principal: victim, sections: { 目标: V, 步骤: "- [ ] 一", 当前卡点: "-" } });
await plans.writePlan({ topic: "my-plan", status: "draft", evidence_refs: ["ev:1"], principal: me, sections: { 目标: M, 步骤: "- [ ] 一", 当前卡点: "-" } });
await roles.putRoleNote({ agent_id: victim.agent_id, role_id: victim.role_id, kind: "lesson", evidence_refs: ["ev:1"], sections: { 经验: `${V} 这是一条属于受害者的角色经验，用于判别力测试。`, 适用场景: "-", 边界: "-" } });
// ⚠️ private 写进 **principal.visibility**（tools-memory 取的是 principal?.visibility）
await tools.putToolNote({ tool_name: "victim-tool", body: V, evidence_refs: ["ev:1"], principal: { ...victim, visibility: "private" }, sections: toolSec(V) });
await tools.putToolNote({ tool_name: "platform-tool", body: M, evidence_refs: ["ev:1"], principal: victim, visibility: "platform", sections: toolSec(M) });
await project.putCurrentState({ project: "victim-proj", evidence_refs: ["ev:1"], principal: victim, sections: { 目标: V, 当前进展: "-", 下一步: "-", 阻塞: "-" } });
// 画像夹具（profile 的写入入口不在本模块 ⇒ 手写文件；缺了它 S2 会量到 0 条，就是"空夹具"）
async function writeFixture(rel, body) {
  const full = path.join(dataRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
}
await writeFixture("profile/victim-profile.md", ["---", "id: victim-profile", "kind: profile", 'container: "long-term"', 'visibility: "private"', "group_id: g-VICTIM", "user_id: u-VICTIM", "agent_id: agent-VICTIM", "role_id: role-VICTIM", 'status: "active"', `updated_at: "${TS}"`, "---", "", V].join("\n"));
await writeFixture("profile/my-profile.md", ["---", "id: my-profile", "kind: profile", 'container: "long-term"', 'visibility: "private"', "group_id: g-ME", "user_id: u-ME", "agent_id: agent-ME", "role_id: role-ME", 'status: "active"', `updated_at: "${TS}"`, "---", "", M].join("\n"));
await pet.putDraft({ content: V, kind: "personal", roleId: "role-VICTIM", sessionId: "s-v" });
await pet.putPersonaConfig("role-VICTIM", { name: V, tone: V });
await learning.putPlan("victim-topic", { topic: "victim-topic", modules: [{ id: "m1", title: V, status: "pending" }] });

const text = (x) => JSON.stringify(x ?? null);
const n = (x) => (Array.isArray(x) ? x.length : x && typeof x === "object" && Array.isArray(x.items) ? x.items.length : x === null || x === undefined ? null : "object");
const hit = (x, mark) => text(x).includes(mark);

const SUSPECTS = [
  { id: "S1", site: "src/plans-memory.mjs:146,147,148", what: "listPlans 三条 `if (principal && …)`", noId: () => plans.listPlans({}) },
  { id: "S2", site: "src/profile-memory.mjs:50", what: "listProfiles 的 `if (principal && …)`", noId: () => profiles.listProfiles({}) },
  { id: "S3", site: "src/role-memory.mjs:86-88", what: "listRoleNotes：trustedAgent/Role 可为 null + `if (principal && …)`", noId: () => roles.listRoleNotes({}) },
  { id: "S4", site: "src/tools-memory.mjs:118", what: "listTools 的 `if (principal && …)`", noId: () => tools.listTools({}) },
  { id: "S5", site: "src/project-memory.mjs:128,152", what: "listProjects/getProject 的 `if (principal && …)`", noId: () => project.listProjects(null), mark: "victim-proj" },
  { id: "S6", site: "src/pet-runtime-store.mjs:53", what: "listDrafts 不收身份（只按 limit）", noId: () => pet.listDrafts({}) },
  { id: "S7", site: "src/pet-runtime-store.mjs:91", what: "listPersonas 不收身份", noId: () => pet.listPersonas() },
  { id: "S8", site: "src/learning.mjs:getPlan 等", what: "learning 读方法不收身份（只有动作门）", noId: () => learning.getPlan("victim-topic") },
  { id: "S9", site: "src/recall.mjs:93-97", what: "myExperience(agent_id, role_id) 由**调用方自报**身份（经 listRoleNotes）", noId: () => roles.listRoleNotes({ agent_id: null, role_id: null }) },
];

const rows = [];
for (const s of SUSPECTS) {
  let noId;
  try { noId = await s.noId(); } catch (e) { noId = { __err: e.message }; }
  const mark = s.mark ?? V;
  const leaked = noId?.__err ? null : hit(noId, mark);
  rows.push({
    id: s.id, site: s.site, what: s.what,
    无身份时: noId?.__err ? `抛错:${noId.__err}` : n(noId),
    无身份看到别人的: leaked === null ? "抛错" : leaked,
    判定: leaked === true ? "❌ 放行（无身份看到别人的）" : leaked === null ? "— 抛错（默认拒绝）" : "✅ 已拒绝/不泄露",
  });
}
await fs.writeFile(OUT, JSON.stringify({ src: SRC, note: "修前读数（源码取自 git 的修前版本）", rows }, null, 2), "utf8");
console.log(rows.map((r) => `${r.id} ${r.what} → 无身份=${r.无身份时} 含别人=${r.无身份看到别人的} ${r.判定}`).join("\n"));
await fs.rm(tmp, { recursive: true, force: true });
