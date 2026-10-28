// SCENARIO-2-FOLLOWUP —— 固定「角色记忆属于哪一天 / 谁能看见」这条规则。
//
// 起因：同一份真实数据、同一个整天窗口，量到两个数：
//   106（researcher 身份） vs 105（reader 身份）—— 差的正是
//   `curated/agents/pilot-01/role-7c963da877417294.md`（container:role / visibility:role /
//   role_id:"researcher"）。
//
// 结论（见 reports/SCENARIO-2-FOLLOWUP-dev-report.md）：这不是「日期语义」的差别，
// 而是**角色准入**的差别。判据在 container-policy.mjs 第 64 行：
//     if (scope.visibility === "role" || scope.container === "role")
//       return Boolean(role && p.role_id === role);
// 即容器/可见性为 role 的条目，只对 **role_id 相同**的 principal 可见；
// 与 agent_id 无关，与"谁写的"无关。所以 pilot-01/reader 看不到 pilot-01/researcher 的角色记忆。
//
// 本文件把这条规则钉在**整天枚举**这条真实入口上，防止有人把它当成
// "日期算错了" 或 "root 漏了" 去"修"。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "Asia/Shanghai";
// 争议条目 updated_at = 2026-09-23T19:04:46.615Z → 上海本地 2026-09-24 03:04。
const DAY = "2026-09-24";

// 逐字复刻争议条目的形状：layer:role + container:role + visibility:role +
// role_id 非空 + occurred_at 空 + **无 type**（无 type 时时间戳回落到 updated_at）。
function roleNote({ id, agent, role, updatedAt, marker }) {
  return [
    "---",
    `id: "${id}"`,
    'layer: "role"',
    `agent_id: "${agent}"`,
    `role_id: "${role}"`,
    'kind: "lesson"',
    'confidence: "high"',
    'status: "active"',
    "superseded_by: null",
    'occurred_at: ""',
    `updated_at: "${updatedAt}"`,
    "tags: []",
    "evidence_refs: []",
    'tenant_id: "default"',
    'container: "role"',
    'visibility: "role"',
    "---",
    "",
    "## 经验",
    "",
    marker,
    "",
  ].join("\n");
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-s2f-parity-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const own = path.join(dataRoot, "curated", "agents", "pilot-01");
  const other = path.join(dataRoot, "curated", "agents", "other-agent");
  await fs.mkdir(own, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(
    path.join(own, "role-researcher.md"),
    roleNote({ id: "role-researcher", agent: "pilot-01", role: "researcher", updatedAt: "2026-09-23T19:04:46.615Z", marker: "S2F-RESEARCHER-ROLE-MEMORY" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(other, "role-other.md"),
    roleNote({ id: "role-other", agent: "other-agent", role: "researcher", updatedAt: "2026-09-23T19:05:46.615Z", marker: "S2F-OTHER-ROLE-MEMORY" }),
    "utf8",
  );
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const pilot = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01");
  for (const roleId of ["researcher", "reader"]) {
    const role = pilot.roles.find((item) => item.role_id === roleId);
    role.group_id = "home-circle";
    role.user_id = "user-owner";
  }
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return { tmp, dataRoot, workspaceRoot, auth };
}

// **与生产同一个工厂**（server.mjs 用的也是 src/server-wiring.mjs 这一个）。
// 这条用例正是靠 agentId 才看得见"自己的角色记忆"（D4F1 self-root），
// 所以装配必须和生产一致，不能自己拼一个（CALLSHAPE-1）。
function productionFactory({ dataRoot, workspaceRoot }) {
  return createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
}

// 逐页取全一整天的枚举结果（用 next_offset，直到为 null）。
async function enumerateWholeDay(port, authBody) {
  const seen = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...authBody, since: DAY, until: DAY, calendarTimezone: TZ, limit: 10, offset }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    total = body.total_count;
    seen.push(...body.results);
    if (body.next_offset === null || body.next_offset === undefined || body.results.length === 0) break;
    offset = body.next_offset;
  }
  return { total, seen };
}

test("role memory belongs to its local day, and only its own role_id may see it", async () => {
  const { tmp, dataRoot, workspaceRoot, auth } = await fixture();
  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory: productionFactory({ dataRoot, workspaceRoot }),
  });
  try {
    const address = await server.listen();
    const base = { credential_ref: auth.credentialRef, secret: auth.authValue };

    // ① researcher：role_id 与条目的 role_id 相同 ⇒ 这条属于这一天。
    const asResearcher = await enumerateWholeDay(address.port, { ...base, principal: { agent_id: "pilot-01", role_id: "researcher" } });
    assert.equal(asResearcher.seen.some((item) => item.path.endsWith("role-researcher.md")), true, "同 role_id：角色记忆必须出现在整天的枚举里");
    assert.equal(asResearcher.seen.some((item) => item.path.endsWith("role-other.md")), false, "别的 agent 的角色记忆必须不可达");

    // ② reader：同一 agent_id、同一份数据、同一天，只换了 role_id ⇒ 那一条**不属于**这一天。
    //    这正是 106 → 105 的那 1 条差额，是**角色准入**造成的，不是日期语义。
    const asReader = await enumerateWholeDay(address.port, { ...base, principal: { agent_id: "pilot-01", role_id: "reader" } });
    assert.equal(asReader.seen.some((item) => item.path.endsWith("role-researcher.md")), false, "role_id 不同：角色记忆不可见");
    assert.equal(
      asResearcher.total - asReader.total,
      1,
      "差额恰好是那一条 researcher 的角色记忆（= 106 与 105 之差）",
    );
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("role admission is decided by role_id alone, not by agent_id", async () => {
  // 直接钉住 container-policy 第 64 行的语义：容器/可见性为 role 的条目，
  // 只认 p.role_id === role。换 agent_id 不影响结论。
  const { principalAllowsContainer } = await import("../src/container-policy.mjs");
  const entry = { container: "role", visibility: "role", agent_id: "pilot-01", role_id: "researcher" };
  const asRole = (agentId, roleId) => principalAllowsContainer({ framework_id: "deepseek-harness", agent_id: agentId, role_id: roleId, group_id: "home-circle", user_id: "user-owner" }, entry);

  assert.equal(asRole("pilot-01", "researcher"), true, "同 role_id ⇒ 可见（agent_id 相同）");
  assert.equal(asRole("admin-01", "researcher"), true, "同 role_id ⇒ 可见（**换 agent_id 也可见**，判据不看 agent_id）");
  assert.equal(asRole("pilot-01", "reader"), false, "换 role_id ⇒ 不可见（agent_id 相同也不行）");
  assert.equal(asRole("pilot-01", "steward"), false, "换 role_id ⇒ 不可见");
});
