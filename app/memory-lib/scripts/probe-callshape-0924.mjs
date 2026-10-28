#!/usr/bin/env node
// 诊断：2026-09-24 在副本上到底是 105 还是 106？谁来补那条？
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const WINDOW = { since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai" };

const out = {};

// ① 直接数文件：curated/agents/pilot-01 下的角色记忆，updated_at 落在该窗口的有几条
const roleDir = path.join(dataRoot, "curated", "agents", "pilot-01");
const entries = await fs.readdir(roleDir).catch(() => []);
out["① curated/agents/pilot-01 文件"] = [];
for (const name of entries.sort()) {
  const text = await fs.readFile(path.join(roleDir, name), "utf8");
  const m = text.match(/updated_at:\s*"?([^"\n]+)"?/u);
  const stamp = m ? m[1].trim() : null;
  const inWindow = stamp ? Date.parse(stamp) >= Date.parse(WINDOW.since) && Date.parse(stamp) <= Date.parse(WINDOW.until) : null;
  const role = (text.match(/role_id:\s*"?([^"\n]+)"?/u) ?? [])[1]?.trim() ?? null;
  out["① curated/agents/pilot-01 文件"].push({ name, updated_at: stamp, role_id: role, inWindow });
}

// ② 各身份下 timeline 的条数
const scopesFor = {
  "pilot-01/reader": [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "episodic" }],
  "pilot-01/researcher": [{ layer: "memory", visibility: "shared" }, { layer: "knowledge", visibility: "shared" }, { layer: "memory", visibility: "project", project: "pilot" }, { layer: "memory", visibility: "episodic" }],
  "pilot-01/steward": [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "*" }, { layer: "memory", visibility: "episodic" }],
};
for (const [label, scopes] of Object.entries(scopesFor)) {
  const [agentId, roleId] = label.split("/");
  const principal = { framework_id: "deepseek-harness", agent_id: agentId, role_id: roleId, group_id: "home-circle", user_id: "user-owner" };
  // ②a 带 agentId（生产 self-root 生效）
  const withAgent = createMemoryLib({ dataRoot, workspaceRoot: COPY, scopes, agentId, roleId, principal, vectorLane: { probe: false } });
  const pageWith = await withAgent.timeline({ ...WINDOW, limit: 100 });
  // ②b 不带 agentId
  const noAgent = createMemoryLib({ dataRoot, workspaceRoot: COPY, scopes, principal, vectorLane: { probe: false } });
  const pageNo = await noAgent.timeline({ ...WINDOW, limit: 100 });
  // ②c 不过滤 root（对照上界）
  const unrestricted = createMemoryLib({ dataRoot, workspaceRoot: COPY, scopes: null, agentId, principal, vectorLane: { probe: false } });
  const pageAll = await unrestricted.timeline({ ...WINDOW, limit: 100 });
  out[`② ${label}`] = { withAgentId: pageWith.total_count, withoutAgentId: pageNo.total_count, unrestricted: pageAll.total_count };
}

console.log(JSON.stringify(out, null, 2));
