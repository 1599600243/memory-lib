#!/usr/bin/env node
/**
 * bind-capture-roles.mjs —— 给"能捕获但归属为空"的角色绑定归属（改生产 identity.json）
 *
 * 背景：DEPLOY-11 侦察发现 5 个角色 group/user 为空 ⇒ 它们捕获会（旧行为）静默写不可见证据 /
 *       （新行为）被 400 拒绝。用户批准"给这些角色绑归属"。
 *
 * ⚠️ 但**不能机械全绑**，归属是**语义判断**：
 *   · home-circle/home-owner-agent → home-circle/user-owner   ✔ 绑（本用户的管家）
 *   · home-circle/home-friend-agent → home-circle/user-owner  ✔ 绑（同圈、本机只有一个真人）
 *   · admin-01/librarian-admin     → **不动**（带 admin 动作，空归属可能是"平台级"的有意设计，且它不捕获）
 *   · work-circle/ops-collector    → **不动**（work-circle 的归属不该塞进 home-circle，需人定"归谁"）
 *   · work-circle/ops-agent        → **不动**（同上）
 *
 * 用法：node bind-capture-roles.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";

const REG = "D:\\MemoryLib\\data\\runtime\\identity.json";
const BACKUP_ROOT = "D:\\MemoryLib\\backups";
const APPLY = process.argv.includes("--apply");

const BIND = [
  { agent: "home-circle", role: "home-owner-agent", group_id: "home-circle", user_id: "user-owner" },
  { agent: "home-circle", role: "home-friend-agent", group_id: "home-circle", user_id: "user-owner" },
];
const SKIP = [
  { agent: "admin-01", role: "librarian-admin", why: "带 admin 动作，空归属可能是有意的平台级设计；且它不参与捕获" },
  { agent: "work-circle", role: "ops-collector", why: "work-circle 的归属不该塞进 home-circle —— 归谁需人定" },
  { agent: "work-circle", role: "ops-agent", why: "同上" },
];

const registry = JSON.parse(fs.readFileSync(REG, "utf8"));
const findRole = (agentId, roleId) => {
  for (const fw of registry.frameworks) for (const a of fw.agents) if (a.agent_id === agentId) for (const r of a.roles) if (r.role_id === roleId) return r;
  return null;
};

console.log("=== 将要绑定 ===");
let changes = 0;
for (const b of BIND) {
  const r = findRole(b.agent, b.role);
  if (!r) { console.log(`  ⚠️ 找不到 ${b.agent}/${b.role}`); continue; }
  const before = `group=${r.group_id ?? "(无)"} user=${r.user_id ?? "(无)"}`;
  if (r.group_id === b.group_id && r.user_id === b.user_id) { console.log(`  = ${b.agent}/${b.role} 已是 ${b.group_id}/${b.user_id}，跳过`); continue; }
  console.log(`  → ${b.agent}/${b.role}：${before}  ⇒  group=${b.group_id} user=${b.user_id}`);
  r.group_id = b.group_id; r.user_id = b.user_id;
  changes += 1;
}
console.log("\n=== 明确**不动**的 ===");
for (const s of SKIP) {
  const r = findRole(s.agent, s.role);
  console.log(`  · ${s.agent}/${s.role}（当前 group=${r?.group_id ?? "(无)"} user=${r?.user_id ?? "(无)"}）—— ${s.why}`);
}

if (!APPLY) {
  console.log(`\n（干跑：将改动 ${changes} 个角色，未写入）`);
  process.exit(0);
}
if (changes === 0) { console.log("\n无需改动。"); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/gu, "").slice(0, 15);
const backupDir = path.join(BACKUP_ROOT, `identity-bind-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, "identity-before.json");
fs.copyFileSync(REG, backupFile);

// 原子写 + 无 BOM（照仓库 atomicWriteFile 的做法：先写临时文件再改名）
const tmp = `${REG}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
fs.renameSync(tmp, REG);

const after = JSON.parse(fs.readFileSync(REG, "utf8"));
const ok = BIND.every((b) => { const r = findRole(b.agent, b.role); return r && r.group_id === b.group_id && r.user_id === b.user_id; });
console.log(`\n✅ 已写入（备份 ${backupFile}）· 回读校验 ${ok ? "通过" : "**失败**"}`);
console.log(`   文件字节：${fs.statSync(REG).size}；前 3 字节 = ${[...fs.readFileSync(REG).subarray(0, 3)].join(",")}`);
