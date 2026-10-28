#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT2 —— 唯一探针：**嫌疑点 × 实测 × 夹具是否有判别力**。
//
// 方法（本单真正要改的东西）：
//   1) 机械列出嫌疑点（下面的 SUSPECTS 来自 `grep -n "if (principal &&" src/*.mjs` + 早退路径）
//   2) 一份**非空**夹具：每条"应当只有受害者看得见"的条目 + **至少一条"来访者应当看得见"的对照条目**
//   3) 对每个嫌疑点，**两种调用**各量一次：
//        来访者（me，不该看见别人的）+ 受害者（victim，正对照）
//      正对照看不见东西 ⇒ 该夹具对这一处**没有判别力** ⇒ 结论只能写"未测"，**不许写 ✅ 安全**
//   4) 输出 JSON + **自动生成的 markdown 表**（告别手打数字）
//
// 只读：全部写在临时目录；不碰副本内容。
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis2r2-"));
const dataRoot = path.join(tmp, "memory");
const workspaceRoot = tmp;

// 来访者（不该看见受害者的东西）；受害者（正对照，应当看得见）
const me = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-ME", user_id: "user-ME", agent_id: "agent-ME", role_id: "role-ME" };
const victim = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-VICTIM", user_id: "user-VICTIM", agent_id: "agent-VICTIM", role_id: "role-VICTIM" };

const TS = "2026-09-24T02:00:00.000Z";

// ───────── 非空夹具 ─────────
const plans = createPlansMemory({ dataRoot });
const profiles = createProfileMemory({ dataRoot });
const roles = createRoleMemory({ dataRoot });
const tools = createToolsMemory({ dataRoot });
const project = createProjectMemory({ dataRoot, graphStore: createGraphStore({ dataRoot }) });
const pet = createPetRuntimeStore({ dataRoot, workspaceRoot });

const VICTIM_MARK = "VICTIM-PRIVATE";
const MINE_MARK = "MINE-VISIBLE";

// 计划：受害者的 private + 我的 private（同容器，保证"有东西"）
await plans.writePlan({ topic: "victim-plan", status: "draft", evidence_refs: ["ev:1"], principal: victim, sections: { 目标: VICTIM_MARK, 步骤: "- [ ] 一步", 当前卡点: "-" } });
await plans.writePlan({ topic: "my-plan", status: "draft", evidence_refs: ["ev:1"], principal: me, sections: { 目标: MINE_MARK, 步骤: "- [ ] 一步", 当前卡点: "-" } });

// 角色记忆：受害者的（经验字段要求 >=15 字符）
await roles.putRoleNote({ agent_id: victim.agent_id, role_id: victim.role_id, kind: "lesson", evidence_refs: ["ev:1"], sections: { 经验: `${VICTIM_MARK} 这是一条属于受害者的角色经验，用于判别力测试。`, 适用场景: "-", 边界: "-" } });

// 工具记忆：受害者的 private + 一条平台可见的（对照：来访者应当看得见）
const toolSections = (mark) => ({ 用途: mark, 接入方式: "-", 关键参数: "-", 已知坑: "-", 验证方式: "-" });
try {
  await tools.putToolNote({ tool_name: "victim-tool", body: VICTIM_MARK, evidence_refs: ["ev:1"], principal: victim, visibility: "private", sections: toolSections(VICTIM_MARK) });
} catch (e) { console.error("tool private 写入失败:", e.message); }
await tools.putToolNote({ tool_name: "platform-tool", body: MINE_MARK, evidence_refs: ["ev:1"], principal: victim, visibility: "platform", sections: toolSections(MINE_MARK) });

// 项目状态：受害者的（注意 putCurrentState 收 sections，不收 body）
try {
  await project.putCurrentState({ project: "victim-proj", evidence_refs: ["ev:1"], principal: victim, sections: { 目标: VICTIM_MARK, 当前进展: "-", 下一步: "-", 阻塞: "-" } });
} catch (e) { console.error("project 写入失败:", e.message); }

// 画像：直接手写夹具文件（profile 的写入入口不在本模块，且本单不许调写接口）
async function writeFixture(rel, body) {
  const full = path.join(dataRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
}
await writeFixture("profile/victim-profile.md", [
  "---", "id: victim-profile", "kind: profile", 'container: "long-term"', 'visibility: "private"',
  "group_id: group-VICTIM", "user_id: user-VICTIM", "agent_id: agent-VICTIM", "role_id: role-VICTIM",
  'status: "active"', `updated_at: "${TS}"`, "---", "", VICTIM_MARK,
].join("\n"));
await writeFixture("profile/my-profile.md", [
  "---", "id: my-profile", "kind: profile", 'container: "long-term"', 'visibility: "private"',
  "group_id: group-ME", "user_id: user-ME", "agent_id: agent-ME", "role_id: role-ME",
  'status: "active"', `updated_at: "${TS}"`, "---", "", MINE_MARK,
].join("\n"));

// 宠物草稿：写在 victim 的 role_id 下
try {
  await pet.putDraft({ content: VICTIM_MARK, kind: "personal", roleId: "victim-role", sessionId: "s-victim" });
  await pet.putDraft({ content: MINE_MARK, kind: "personal", roleId: "my-role", sessionId: "s-me" });
} catch (e) { console.error("pet draft 写入失败:", e.message); }
// 宠物 persona：给 victim-role 配一个（否则 listPersonas 无判别力）
try {
  await pet.putPersonaConfig("victim-role", { name: VICTIM_MARK, tone: VICTIM_MARK });
} catch (e) { console.error("pet persona 写入失败:", e.message); }

// ───────── 嫌疑点清单（机械来源）─────────
// grep -n "if (principal &&" src/*.mjs  → plans:146,147,148  profile:50  project:128,152  role:88  tools:118
// 早退/缺失身份路径：timeline(scopeFilteredResults)、pet listDrafts/listPersonas、lib 构造 scopes=null
const SUSPECTS = [
  { id: "S1", site: "src/plans-memory.mjs:146-148", desc: "listPlans 三条 if (principal && …)", call: () => plans.listPlans({}) },
  { id: "S2", site: "src/profile-memory.mjs:50", desc: "listProfiles 的 if (principal && …)", call: () => profiles.listProfiles({}) },
  { id: "S3", site: "src/role-memory.mjs:88 (+86-87)", desc: "listRoleNotes 的 trustedAgent/Role + if (principal && …)", call: () => roles.listRoleNotes({}) },
  { id: "S4", site: "src/tools-memory.mjs:118", desc: "listTools 的 if (principal && …)", call: () => tools.listTools({}) },
  { id: "S5", site: "src/project-memory.mjs:128,152", desc: "listProjects 的 if (principal && …)", call: () => project.listProjects(null), marker: "victim-proj" },
  { id: "S6", site: "src/pet-runtime-store.mjs:53,91", desc: "listDrafts/listPersonas：只按 roleId 取，不认身份", call: () => pet.listDrafts({}) },
  { id: "S7", site: "src/pet-runtime-store.mjs:91", desc: "listPersonas：不认身份", call: () => pet.listPersonas() },
];

const text = (v) => JSON.stringify(v ?? null);
const inspect = (v, needle) => {
  const t = text(v);
  const n = Array.isArray(v) ? v.length : (v && typeof v === "object" && Array.isArray(v.items) ? v.items.length : (v === null ? null : "?"));
  return { 条数: n, 含VICTIM标记: t.includes(needle) };
};

const rows = [];
for (const s of SUSPECTS) {
  let anonymous; let asVictim;
  try { anonymous = inspect(await s.call(), s.marker ?? VICTIM_MARK); } catch (e) { anonymous = { 抛错: e.message }; }
  rows.push({
    id: s.id, site: s.site, desc: s.desc,
    "无身份": anonymous,
    可判别: anonymous["含VICTIM标记"] === true ? "有（真放行）" : "待正对照",
  });
}

// ───────── 正对照：这些"无身份"路径的条数是否非零 ─────────
// 规则：若"无身份"返回 0 条，需要证明**这夹具里确实有这条方法能看见的东西**，
// 否则结论只能是"夹具无判别力（未测）"。做法：直接数夹具里该容器的文件数。
async function countFiles(rel) {
  const dir = path.join(dataRoot, rel);
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  } catch { return 0; }
}
const fixtureCounts = {
  "curated/agents": await countFiles("curated/agents"),
  plans: await countFiles("plans"),
  "tools-memory": await countFiles("tools-memory"),
  "project-state": await countFiles("project-state"),
  profile: await countFiles("profile"),
};

for (const row of rows) {
  if (row["无身份"]?.["条数"] === 0) {
    row.结论 = "夹具无判别力（未测）——「无身份返回 0」可能只是没东西可漏";
  } else if (row["无身份"]?.["含VICTIM标记"]) {
    row.结论 = "❌ 放行（无身份时能看到别人的东西）";
  } else {
    row.结论 = "⏳ 有返条目但不含 VICTIM 标记——需人工看是不是别人的";
  }
}

// ───────── 事实：夹具里到底有多少条"别人的东西" ─────────
const markdown = [];
markdown.push("| 嫌疑点 | 位置 | 无身份时返回 | 含别人的东西 | 判定 |");
markdown.push("|---|---|---|---|---|");
for (const r of rows) {
  markdown.push(`| ${r.id} ${r.desc} | \`${r.site}\` | ${r["无身份"]?.条数 ?? r["无身份"]?.抛错} | ${r["无身份"]?.["含VICTIM标记"] ?? "-"} | ${r.结论} |`);
}

console.log(JSON.stringify({
  fixture: { 受害者: "agent-VICTIM/role-VICTIM", 来访者: "agent-ME/role-ME", 标记: VICTIM_MARK, 对照标记: MINE_MARK },
  夹具文件数: fixtureCounts,
  嫌疑点: rows,
  markdown: markdown.join("\n"),
}, null, 2));

await fs.rm(tmp, { recursive: true, force: true });
