#!/usr/bin/env node
// SCENARIO-2-FOLLOWUP 探针 7：把争议条目的**准入判据**直接量出来。
// 它回答：那条 `curated/agents/pilot-01/role-*.md`（container:role / visibility:role /
// role_id:"researcher"）到底对**哪些身份**可见？
// 判据来自 container-policy.mjs 第 64 行：容器/可见性为 role 时，只认 `p.role_id === role`。
import fs from "node:fs/promises";
import path from "node:path";
import { pathContainer, principalAllowsContainer } from "../src/container-policy.mjs";
import { parseFrontmatter } from "../src/read-only-core.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const target = path.join(dataRoot, "curated", "agents", "pilot-01", "role-7c963da877417294.md");

const fm = parseFrontmatter(await fs.readFile(target, "utf8")).frontmatter;
const uq = (v) => (v === null || v === undefined ? v : String(v).trim().replace(/^["']|["']$/gu, ""));
// 与真实代码同口径：frontmatter 里的值是带引号的，必须 unquote，
// 否则 normalizeContainer('"role"') → null → principalAllowsContainer 恒 false（假阴性）。
const metadata = {
  ...fm,
  container: pathContainer(dataRoot, target),
  visibility: uq(fm.visibility),
  agent_id: uq(fm.agent_id),
  role_id: uq(fm.role_id),
};

const out = {
  entry: { container: metadata.container, visibility: metadata.visibility, agent_id: metadata.agent_id, role_id: metadata.role_id },
  note: "同一 agent_id（pilot-01）、不同 role_id 的准入结果",
};
for (const role of ["reader", "researcher", "steward", "learner"]) {
  out[`role_id=${role}`] = principalAllowsContainer(
    { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: role, group_id: "home-circle", user_id: "user-owner" },
    metadata,
  );
}
console.log(JSON.stringify(out, null, 2));
