// SCENARIO-2-FOLLOWUP 探针 4：把「self-root 兜底」这条补偿路径拿掉，看谁会掉条目。
//
// ⚠️ 本探针的**解读后来被探针 6/7 修正**，保留它是为了留下过程证据：
//   B/C 两个形状掉条目，**不是**"scopes→resolvedRoots 缺一个 role 根"造成的缺陷，
//   而是 container-policy 第 64 行**故意**的角色准入：容器/可见性为 role 的条目
//   只对 `role_id` 相同的 principal 可见。B（agentId=admin-01）掉条目是因为
//   它同时也没拿到 self-root；但即使拿到，准入仍由 role_id 决定。
//   ⇒ 这不是 bug，是设计。钉住它的用例见 test/day-membership-role-parity.test.mjs。
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { resolveRequestScopes } from "../src/identity-registry.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const target = path.join(dataRoot, "curated", "agents", "pilot-01", "role-7c963da877417294.md");
const WINDOW = { since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai", limit: 200 };

// 走**同一个已验证 role**（researcher）拿 scopes，只换「是谁在查」。
// 这样 role 授权判据（container-policy 第 64 行 p.role_id === role）恒成立，
// 唯一变量就是 memory-lib 第 180-186 行那条 self-root 兜底能不能兜住。
const scopes = [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "episodic" }];

const out = { target: path.relative(dataRoot, target), scopes: "memory/shared + memory/episodic（两个真实角色都有）" };
for (const [label, options] of [
  ["A role_id=researcher, agentId=pilot-01（=该文件自己的 agent）", { agentId: "pilot-01" }],
  ["B role_id=researcher, agentId=admin-01（同 role、换了 agent）", { agentId: "admin-01" }],
  ["C role_id=researcher, 不传 agentId（无 self-root 兜底）", {}],
]) {
  const principal = { framework_id: "deepseek-harness", agent_id: options.agentId ?? null, role_id: "researcher", group_id: "home-circle", user_id: "user-owner" };
  const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, scopes, vectorLane: { probe: false }, ...options });
  const page = await lib.timeline(WINDOW);
  out[label] = { total_count: page.total_count, containsTarget: page.results.some((item) => item.path === target) };
}
console.log(JSON.stringify(out, null, 2));
