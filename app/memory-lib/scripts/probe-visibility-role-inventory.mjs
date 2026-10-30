#!/usr/bin/env node
// VISIBILITY-AUDIT-1 —— 影响面读数：**真实数据副本**上，角色记忆一共有多少、分属谁。
// 只读；不碰生产。这条回答"如果 memory_role_list 空参数可达，实际能看到多少"。
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../src/read-only-core.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const root = path.join(COPY, "memory", "curated", "agents");

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = await walk(root);
const byAgent = new Map();
const byRole = new Map();
let withRoleId = 0;
let withoutRoleId = 0;
const samples = [];

for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  const fm = parseFrontmatter(text).frontmatter;
  const uq = (v) => (v === null || v === undefined ? null : String(v).trim().replace(/^["']|["']$/gu, ""));
  const agent = uq(fm.agent_id) ?? "(none)";
  const role = uq(fm.role_id);
  byAgent.set(agent, (byAgent.get(agent) ?? 0) + 1);
  byRole.set(role ?? "(none)", (byRole.get(role ?? "(none)") ?? 0) + 1);
  if (role) withRoleId += 1; else withoutRoleId += 1;
  if (samples.length < 8) samples.push({ relative: path.relative(root, file), agent_id: agent, role_id: role, kind: uq(fm.kind) });
}

console.log(JSON.stringify({
  copy: COPY,
  totalRoleMemoryFiles: files.length,
  withRoleId,
  withoutRoleId,
  agents: [...byAgent.entries()].sort((a, b) => b[1] - a[1]),
  roles: [...byRole.entries()].sort((a, b) => b[1] - a[1]),
  sample: samples,
}, null, 2));
