#!/usr/bin/env node
// VISIBILITY-FIX-1 / 步骤 1 —— **机械列全嫌疑点 + 有效夹具实测**（表格自动生成，报告不再手打）。
//
// 嫌疑点来源（机械，不靠"读代码觉得安全"）：
//   A) `grep -n "if (principal &&" src/*.mjs`          —— 可跳过的身份判定
//   B) `grep -n "trustedAgent|trustedRole" src/*.mjs`  —— 用"可能为 null 的身份变量"做过滤
//   C) 早退路径：listDrafts/listPersonas/listProjects 等**不收身份**的读方法
//   D) 身份自报路径：recall.myExperience(agent_id, role_id) 由调用方给
//
// 判别力（本单纪律）：每个嫌疑点都要有一个**正对照** —— 同一夹具下用一个"应当看得见"的身份，
// 必须能看见东西；看不见 ⇒ 该点写"夹具无判别力（未测）"，**不许写安全**。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlansMemory } from "../src/plans-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { createRoleMemory } from "../src/role-memory.mjs";
import { createToolsMemory } from "../src/tools-memory.mjs";
import { createProjectMemory } from "../src/project-memory.mjs";
import { createPetRuntimeStore } from "../src/pet-runtime-store.mjs";
import { createGraphStore } from "../src/graph-retrieval.mjs";
import { createLearningApi } from "../src/learning.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visapi-audit-"));
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

async function write(rel, body) {
  const full = path.join(dataRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
}

// ── 非空夹具：每个容器一条"只该受害者可见" + 一条"来访者应当可见"的对照 ──
// ⚠️ private 必须写进 **principal.visibility**：`tools-memory.mjs:42` 取的是
//    `principal?.visibility ?? "platform"`，传 `visibility: "private"` 参数**会被忽略**
//    （那样工具会落成 platform ⇒ 谁都能看，就证不了 private 这一层）。
const toolSec = (x) => ({ 用途: x, 接入方式: "-", 关键参数: "-", 已知坑: "-", 验证方式: "-" });
await plans.writePlan({ topic: "victim-plan", status: "draft", evidence_refs: ["ev:1"], principal: victim, sections: { 目标: V, 步骤: "- [ ] 一", 当前卡点: "-" } });
await plans.writePlan({ topic: "my-plan", status: "draft", evidence_refs: ["ev:1"], principal: me, sections: { 目标: M, 步骤: "- [ ] 一", 当前卡点: "-" } });
await roles.putRoleNote({ agent_id: victim.agent_id, role_id: victim.role_id, kind: "lesson", evidence_refs: ["ev:1"], sections: { 经验: `${V} 这是一条属于受害者的角色经验，用于判别力测试。`, 适用场景: "-", 边界: "-" } });
await tools.putToolNote({ tool_name: "victim-tool", body: V, evidence_refs: ["ev:1"], principal: { ...victim, visibility: "private" }, sections: toolSec(V) });
await tools.putToolNote({ tool_name: "platform-tool", body: M, evidence_refs: ["ev:1"], principal: victim, visibility: "platform", sections: toolSec(M) });
await project.putCurrentState({ project: "victim-proj", evidence_refs: ["ev:1"], principal: victim, sections: { 目标: V, 当前进展: "-", 下一步: "-", 阻塞: "-" } });
await write("profile/victim-profile.md", ["---", "id: victim-profile", "kind: profile", 'container: "long-term"', 'visibility: "private"', "group_id: g-VICTIM", "user_id: u-VICTIM", "agent_id: agent-VICTIM", "role_id: role-VICTIM", 'status: "active"', `updated_at: "${TS}"`, "---", "", V].join("\n"));
await pet.putDraft({ content: V, kind: "personal", roleId: "role-VICTIM", sessionId: "s-v" });
await pet.putPersonaConfig("role-VICTIM", { name: V, tone: V });

// 学习夹具（E1）：一个带可辨识内容的 plan
const learningRoot = path.join(tmp, "learning");
const learningFixture = createLearningApi(learningRoot);
await learningFixture.putPlan("victim-topic", { topic: "victim-topic", modules: [{ id: "m1", title: V, status: "pending" }] });

const text = (x) => JSON.stringify(x ?? null);
const n = (x) => (Array.isArray(x) ? x.length : x && typeof x === "object" && Array.isArray(x.items) ? x.items.length : x === null || x === undefined ? null : "object");
const hit = (x, mark) => text(x).includes(mark);

// ── 嫌疑点清单 ──
const SUSPECTS = [
  { id: "A1", site: "src/plans-memory.mjs:146,147,148", what: "listPlans 三条 `if (principal && …)`", noId: () => plans.listPlans({}), withId: () => plans.listPlans({ principal: me }) },
  { id: "A2", site: "src/profile-memory.mjs:50", what: "listProfiles 的 `if (principal && …)`", noId: () => profiles.listProfiles({}), withId: () => profiles.listProfiles({ principal: me }) },
  { id: "A3", site: "src/role-memory.mjs:86-88", what: "listRoleNotes：trustedAgent/Role 可为 null + `if (principal && …)`", noId: () => roles.listRoleNotes({}), withId: () => roles.listRoleNotes({ principal: me }) },
  { id: "A4", site: "src/tools-memory.mjs:118", what: "listTools 的 `if (principal && …)`", noId: () => tools.listTools({}), withId: () => tools.listTools({ principal: me }) },
  { id: "A5", site: "src/project-memory.mjs:128,152", what: "listProjects/getProject 的 `if (principal && …)`", noId: () => project.listProjects(null), withId: () => project.listProjects(me), mark: "victim-proj" },
  { id: "C1", site: "src/pet-runtime-store.mjs:53", what: "listDrafts 不收身份（只按 limit）", noId: () => pet.listDrafts({}), withId: () => pet.listDrafts({ limit: 100 }) },
  { id: "C2", site: "src/pet-runtime-store.mjs:91", what: "listPersonas 不收身份", noId: () => pet.listPersonas(), withId: () => pet.listPersonas() },
  { id: "D1", site: "src/recall.mjs:93-97", what: "myExperience(agent_id, role_id) 由**调用方自报**身份", noId: () => roles.listRoleNotes({ agent_id: null, role_id: null }), withId: () => roles.listRoleNotes({ agent_id: victim.agent_id }) },
  // E1：学习读路径此前**完全不接身份**（只有动作门 learning）；部署 registry 里有两个角色带该动作。
  { id: "E1", site: "src/learning.mjs:getPlan/getProgress/getReview/listDueReviews/getProfile", what: "learning 读方法不收身份（只有动作门）", noId: () => createLearningApi(path.join(tmp, "learning")).getPlan("victim-topic"), withId: () => createLearningApi(path.join(tmp, "learning")).getPlan("victim-topic", victim) },
];

const rows = [];
for (const s of SUSPECTS) {
  let noId; let withId;
  try { noId = await s.noId(); } catch (e) { noId = { __err: e.message }; }
  try { withId = await s.withId(); } catch (e) { withId = { __err: e.message }; }
  const mark = s.mark ?? V;
  const noLeak = noId?.__err ? null : hit(noId, mark);
  const noCount = noId?.__err ? `抛错:${noId.__err}` : n(noId);
  // 正对照：withId 至少要看得见"我的"东西（M），证明夹具非空、有判别力
  const controlSees = hit(withId, M) || hit(withId, "my-plan") || hit(withId, "platform-tool");
  rows.push({
    id: s.id, site: s.site, what: s.what,
    无身份时: noCount, 无身份看到别人的: noLeak,
    正对照看得见自己的: controlSees,
    判定: noLeak === true ? "❌ 放行（无身份看到别人的）"
      : noLeak === null ? "— 抛错（默认拒绝）"
        : controlSees ? "✅ 已拒绝/不泄露（正对照通过）"
          : "⚠️ 夹具无判别力（未测）",
  });
}

const md = ["| 嫌疑点 | 位置 | 无身份时 | 无身份看不到别人的 | 正对照看得见自己的 | 判定 |", "|---|---|---|---|---|---|"];
for (const r of rows) md.push(`| ${r.id} ${r.what} | \`${r.site}\` | ${r.无身份时} | ${r.无身份看到别人的 === null ? "抛错" : r.无身份看到别人的} | ${r.正对照看得见自己的} | ${r.判定} |`);

console.log(JSON.stringify({ fixture: { 受害者标记: V, 我的标记: M, 受害者: "agent-VICTIM/role-VICTIM" }, rows, markdown: md.join("\n") }, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
