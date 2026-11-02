#!/usr/bin/env node
// 检查 claim_allowlist 是否覆盖 identity.json 里所有已注册的 agent/role 组合。
// 用途：收紧 allowlist 后，防止"以后加了 agent 忘了加清单 → 线上 403"。
// 用法：node scripts/check-claim-allowlist.mjs [identity.json 路径]
// 退出码：0 全覆盖；1 有未覆盖；2 读不到/结构不对
import fs from "node:fs";
import path from "node:path";
import { claimAllowed } from "../src/identity-registry.mjs";

const file = process.argv[2] ?? path.join("D:/MemoryLib/data/runtime/identity.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const frameworks = Array.isArray(data.frameworks) ? data.frameworks : Object.values(data.frameworks ?? {});

let uncovered = 0;
let total = 0;
for (const framework of frameworks) {
  const allowlist = framework.claim_allowlist ?? null;
  console.log(`框架 ${framework.framework_id}  allowlist=${allowlist === null ? "null（全放行）" : JSON.stringify(allowlist)}`);
  for (const agent of framework.agents ?? []) {
    for (const role of agent.roles ?? []) {
      total += 1;
      const ok = claimAllowed(allowlist, agent.agent_id, role.role_id);
      if (!ok) {
        uncovered += 1;
        console.log(`  ✗ 未覆盖: ${agent.agent_id}/${role.role_id}`);
      }
    }
  }
}
console.log(`\n合计 ${total} 个 agent/role 组合，未覆盖 ${uncovered} 个`);
if (uncovered) {
  console.log("修法：在 identity.json 的 framework.claim_allowlist 里补上（支持 * 通配，如 qq-*/chat-*）");
  process.exit(1);
}
