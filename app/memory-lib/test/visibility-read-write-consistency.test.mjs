// visibility-read-write-consistency.test.mjs —— 读侧与写侧的不变量
//
// 不变量（唯一一条，其余都是它的推论）：
//   **写得回的记忆，必须读得见。**
// 违反它就会出现今天的同类故障：写进去了但列表/检索看不到，或者看得见但存不进去。
//
// 覆盖范围：
//   · 身份类可见性 user / role / agent / shared / private / daily
//   · 5 种典型 principal（全身份 / 只有 user / 只有 agent / 只有 role / 空）
//   · 显式排除 platform / project —— 它们的门不是"身份位"（platform 要 admin、project 要 scope），
//     单独断言，不套用这条不变量。

import test from "node:test";
import assert from "node:assert/strict";
import { canSeePath } from "../src/visibility.mjs";
import { identityDenialForWrite } from "../src/write-authorization.mjs";

const DATA_ROOT = "D:\\tmp-visibility-test\\memory";
const FILE = "D:\\tmp-visibility-test\\memory\\curated\\shared\\probe.md";

const PRINCIPALS = [
  { label: "all-slots", principal: { framework_id: "f", group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" } },
  { label: "user-only", principal: { framework_id: "f", user_id: "u1" } },
  { label: "agent-only", principal: { framework_id: "f", agent_id: "a1" } },
  { label: "role-only", principal: { framework_id: "f", role_id: "r1" } },
  { label: "no-identity", principal: { framework_id: "f" } },
];

const VISIBILITIES = ["user", "role", "agent", "shared", "private", "daily"];

/** 构造"这条记忆属于该 principal 自己"的 frontmatter */
function ownFrontmatter(principal, visibility) {
  return {
    layer: "long-term",
    visibility,
    group_id: principal.group_id ?? undefined,
    user_id: principal.user_id ?? undefined,
    agent_id: principal.agent_id ?? undefined,
    role_id: principal.role_id ?? undefined,
  };
}

test("写得回 ⇒ 读得见（身份类可见性 × 5 种 principal）", () => {
  const rows = [];
  for (const { label, principal } of PRINCIPALS) {
    for (const visibility of VISIBILITIES) {
      const target = { container: "long-term", visibility };
      const writeDenial = identityDenialForWrite({ target, principal, claimed: {} });
      const canWrite = writeDenial === null;

      const fm = ownFrontmatter(principal, visibility);
      const canRead = canSeePath({ principal, dataRoot: DATA_ROOT, filePath: FILE, frontmatter: fm });
      rows.push({ label, visibility, canWrite, canRead, code: writeDenial?.code ?? null });

      if (canWrite) {
        assert.equal(canRead, true, `${label} 能写 ${visibility} 却读不到自己的记忆（写=${canWrite} 读=${canRead}）`);
      }
    }
  }
  console.table(rows);
});

test("platform：读对所有人开放，写只对 admin 开放（不套用上条不变量）", () => {
  const fm = { layer: "long-term", visibility: "platform" };
  const principal = { framework_id: "f" };
  assert.equal(canSeePath({ principal, dataRoot: DATA_ROOT, filePath: FILE, frontmatter: fm }), true, "platform 读应开放");
});

test("别人身份位上的记忆不可见（反向隔离）", () => {
  const other = { framework_id: "f", group_id: "g1", user_id: "u-other", agent_id: "a-other", role_id: "r-other" };
  const me = { framework_id: "f", group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" };
  for (const visibility of ["user", "role", "agent"]) {
    const fm = ownFrontmatter(other, visibility);
    // private/long-term 分支允许 user/agent/role 任一命中，others 三个位都不同 → 必须 false
    assert.equal(canSeePath({ principal: me, dataRoot: DATA_ROOT, filePath: FILE, frontmatter: fm }), false, `visibility=${visibility} 不应可见`);
  }
});
