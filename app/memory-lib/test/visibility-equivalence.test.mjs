// visibility-equivalence.test.mjs —— 差分测试：抽取出来的 canSeePath 必须与原实现 100% 一致
//
// 做法：把原实现（memory-lib.mjs 的 principalAuthorizesPath）冻结成本文件里的 legacyCanSee，
// 然后拿真实语料（data/memory 下所有 .md）× 真实身份（identity.json 里每个 role）
// 逐条比对。任何一条不一致都判失败 —— 这是抽取重构唯一的验收标准。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathContainer, principalAllowsContainer } from "../src/container-policy.mjs";
import { canSeePath, unquoteFrontmatter } from "../src/visibility.mjs";

const DATA_ROOT = process.env.MEMORY_DATA_ROOT ?? "D:\\MemoryLib\\data\\memory";
const IDENTITY_FILE = process.env.MEMORY_IDENTITY ?? "D:\\MemoryLib\\data\\runtime\\identity.json";

// ── 冻结的旧实现（逐字复制 memory-lib.mjs，不要改它）──────────────────
function legacyCanSee({ principal, dataRoot, filePath, frontmatter = null }) {
  if (!principal) return true;
  const fm = frontmatter ?? {};
  const container = pathContainer(dataRoot, filePath);
  if (!container) return false;
  if (container === "evidence") {
    const group = unquoteFrontmatter(fm.group_id ?? fm.groupId);
    const user = unquoteFrontmatter(fm.user_id ?? fm.userId);
    const principalGroup = principal.group_id;
    const principalUser = principal.user_id;
    return Boolean(group && user && group !== "unknown" && user !== "unknown" && principalGroup && principalUser && group === principalGroup && user === principalUser);
  }
  const metadata = {
    ...fm, container,
    project: unquoteFrontmatter(fm.project),
    group_id: unquoteFrontmatter(fm.group_id),
    user_id: unquoteFrontmatter(fm.user_id),
    agent_id: unquoteFrontmatter(fm.agent_id),
    role_id: unquoteFrontmatter(fm.role_id),
    visibility: unquoteFrontmatter(fm.visibility) || (container === "project" ? "project" : container === "tool" || container === "knowledge" ? "platform" : container === "role" ? "role" : "private"),
  };
  if (!metadata.group_id && !metadata.user_id && !metadata.agent_id && !metadata.role_id) {
    if (container === "role") {
      const parts = path.relative(dataRoot, filePath).split(path.sep);
      metadata.agent_id = parts[0] === "curated" && parts[1] === "agents" ? parts[2] : null;
    }
    if (container === "project") return true;
    if (container === "long-term" || container === "tool" || container === "knowledge") return true;
  }
  return principalAllowsContainer(principal, metadata);
}

// ── 语料与身份 ────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function parseFm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[kv[1]] = v;
  }
  return fm;
}

function loadPrincipals() {
  const reg = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
  const out = [];
  for (const fw of reg.frameworks ?? []) {
    for (const agent of fw.agents ?? []) {
      for (const role of agent.roles ?? []) {
        out.push({
          label: `${agent.agent_id}/${role.role_id}`,
          principal: {
            framework_id: fw.framework_id,
            agent_id: agent.agent_id,
            role_id: role.role_id,
            user_id: role.user_id ?? null,
            group_id: role.group_id ?? agent.group_id ?? null,
          },
        });
      }
    }
  }
  // 补一个"非 admin、无 user_id"的主体会员，覆盖最严的拒绝分支
  out.push({ label: "anonymous/no-user", principal: { framework_id: "x", agent_id: "qq-none", role_id: "chat-reader", user_id: null, group_id: null } });
  return out;
}

test("canSeePath 与旧实现逐条一致（真实语料 × 真实身份）", () => {
  const files = walk(DATA_ROOT);
  const principals = loadPrincipals();
  assert.ok(files.length > 500, `语料太少：${files.length}`);
  assert.ok(principals.length >= 10, `身份太少：${principals.length}`);

  let checked = 0;
  const mismatches = [];
  for (const filePath of files) {
    const fm = parseFm(fs.readFileSync(filePath, "utf8"));
    for (const { label, principal } of principals) {
      const oldVerdict = legacyCanSee({ principal, dataRoot: DATA_ROOT, filePath, frontmatter: fm });
      const newVerdict = canSeePath({ principal, dataRoot: DATA_ROOT, filePath, frontmatter: fm });
      checked += 1;
      if (oldVerdict !== newVerdict) {
        mismatches.push({ file: path.relative(DATA_ROOT, filePath), principal: label, oldVerdict, newVerdict });
        if (mismatches.length >= 20) break;
      }
    }
    if (mismatches.length >= 20) break;
  }

  console.log(`  语料 ${files.length} 个文件 × ${principals.length} 个身份 = ${checked} 次判定`);
  if (mismatches.length) {
    console.log("  不一致样例：");
    for (const m of mismatches) console.log(`    ${m.principal} | ${m.file} | 旧=${m.oldVerdict} 新=${m.newVerdict}`);
  }
  assert.deepEqual(mismatches, [], "存在不一致，抽取不等价");
});

test("unknown group_id is a sentinel, not a real group (project visibility)", async () => {
  const { principalAllowsContainer } = await import("../src/container-policy.mjs");
  const principal = { tenant_id: "default", framework_id: "f", agent_id: "admin-01", role_id: "librarian-admin", group_id: "home-circle", user_id: "user-owner" };
  const metadata = { layer: "project", container: "project", visibility: "project", project: "memory-lib", group_id: "unknown" };
  assert.equal(principalAllowsContainer(principal, { ...metadata }), true, "group_id=unknown 应视为未标注，不应拦住项目记忆");
  assert.equal(principalAllowsContainer(principal, { ...metadata, group_id: "other-group" }), false, "明确不同的分组仍应拒绝");
});
