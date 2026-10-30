#!/usr/bin/env node
// VISIBILITY-AUDIT-2-REJECT2 —— 重做 scopes=null 那一处（上一版第一行 total=4 却四个 check 全 False，自相矛盾）。
//
// 修法：**统一用 `results[].id` 判定**（不再用路径子串），并对每个场景同时打印
//   total、返回的 id 列表、命中的 marker 集合 —— 三者必须互相自洽。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vis2r2-null-"));
const dataRoot = path.join(tmp, "memory");
const workspaceRoot = tmp;
const TS = "2026-09-24T02:00:00.000Z";

const other = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-OTHER", user_id: "user-OTHER", agent_id: "agent-OTHER", role_id: "role-OTHER" };
const me = { framework_id: "deepseek-harness", tenant_id: "default", group_id: "group-ME", user_id: "user-ME", agent_id: "agent-ME", role_id: "role-ME" };

async function write(rel, body) {
  const full = path.join(dataRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
}
// 四条"属于别人"的条目，id 唯一且可判
await write("curated/shared/other-shared.md", `---\nid: other-shared\nlayer: long-term\nstatus: active\nupdated_at: "${TS}"\ngroup_id: group-OTHER\n---\n\nbelongs to other\n`);
await write("curated/agents/agent-OTHER/other-role.md", `---\nid: other-role\nlayer: role\ncontainer: role\nvisibility: role\nstatus: active\nagent_id: agent-OTHER\nrole_id: role-OTHER\nkind: lesson\nupdated_at: "${TS}"\nevidence_refs: []\n---\n\n## 经验\n\nthis role note belongs to another agent entirely\n`);
await write("tools-memory/other-tool.md", `---\nid: other-tool\nlayer: tool\nvisibility: private\nstatus: active\nagent_id: agent-OTHER\nupdated_at: "${TS}"\n---\n\nbelongs to other\n`);
await write("plans/other-plan.md", `---\nid: other-plan\nlayer: plan\nvisibility: private\nstatus: active\nagent_id: agent-OTHER\ngroup_id: group-OTHER\nuser_id: user-OTHER\nupdated_at: "${TS}"\n---\n\nbelongs to other\n`);

const OTHERS = ["other-shared", "other-role", "other-tool", "other-plan"];
const WIDE = { since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", limit: 100 };

async function run(label, options) {
  const lib = createMemoryLib({ dataRoot, workspaceRoot, vectorLane: { probe: false }, ...options });
  const page = await lib.timeline(WIDE);
  const ids = (page.results ?? []).map((r) => r.id);
  const hits = OTHERS.filter((o) => ids.includes(o));
  return {
    场景: label,
    roots: lib.roots.map((r) => path.relative(dataRoot, typeof r === "string" ? r : r.path).replaceAll("\\", "/")),
    total_count: page.total_count,
    返回的id: ids,
    命中别人的: hits,
    命中数: hits.length,
    // 自洽校验：total_count 必须等于返回条数（单页装得下）
    自洽: page.total_count === ids.length,
  };
}

const rows = [];
rows.push(await run("scopes=null（parity）", { scopes: null }));
rows.push(await run("scopes=null 经 server-wiring（生产 libFactory 形状）", { scopes: null, __factory: true }));
rows.pop(); // 上一行用 factory 单独跑，见下
rows.push(await run("scopes=[memory/shared] + principal=me", { scopes: [{ layer: "memory", visibility: "shared" }], principal: me, agentId: "agent-ME" }));
rows.push(await run("scopes=[] + principal=me", { scopes: [], principal: me, agentId: "agent-ME" }));

// server-wiring 形状单独跑
{
  const factory = createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
  const lib = factory({ scopes: null });
  const page = await lib.timeline(WIDE);
  const ids = (page.results ?? []).map((r) => r.id);
  const hits = OTHERS.filter((o) => ids.includes(o));
  rows.push({ 场景: "server-wiring libFactory({scopes:null})", roots: lib.roots.map((r) => path.relative(dataRoot, typeof r === "string" ? r : r.path).replaceAll("\\", "/")), total_count: page.total_count, 返回的id: ids, 命中别人的: hits, 命中数: hits.length, 自洽: page.total_count === ids.length });
}

console.log(JSON.stringify({ fixture: { 别人的条目: OTHERS, 我的身份: "agent-ME/role-ME" }, rows }, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
