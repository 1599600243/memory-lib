import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { CONTAINERS, principalAllowsContainer } from "../src/container-policy.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-m1-2-demo-"));
const writer = createMemoryWriter({ dataRoot: root });
const a = { group_id: "group-a", user_id: "user-a", agent_id: "agent-a", role_id: "role-a" };
const b = { group_id: "group-b", user_id: "user-b", agent_id: "agent-b", role_id: "role-b" };
const sameGroup = { group_id: "group-a", user_id: "user-c", agent_id: "agent-c", role_id: "role-c" };
const cases = [
  ["temporary", "private"], ["evidence", "private"], ["long-term", "private"], ["project", "project"],
  ["tool", "platform"], ["graph", "private"], ["plan", "private"], ["role", "role"], ["knowledge", "platform"],
];
for (const [container, visibility] of cases) {
  const metadata = { container, visibility, group_id: a.group_id, user_id: a.user_id, agent_id: a.agent_id, role_id: a.role_id, project: "demo" };
  const aCanRead = container === "temporary" ? false : principalAllowsContainer(a, metadata);
  const bCanRead = container === "temporary" ? false : principalAllowsContainer(b, metadata);
  const sameGroupCanRead = container === "project" || (container === "long-term" && visibility === "shared")
    ? principalAllowsContainer(sameGroup, { ...metadata, visibility: container === "project" ? "project" : "shared" }) : false;
  assert.equal(aCanRead, container !== "temporary", `${container}: owner must retain access`);
  assert.equal(bCanRead, false, `${container}: cross-group principal must be denied`);
  if (container === "project" || (container === "long-term" && visibility === "shared")) assert.equal(sameGroupCanRead, true, `${container}: same group must be allowed`);
}
await writer.putTemporary({ key: "scratch", body: "temporary-only", ttlMs: 60_000, principal: a });
assert.equal(await writer.getTemporary("scratch", b), null);
const promoted = await writer.promoteTemporary("scratch", "curated-shared", { id: "m1-2-promoted", body: "ignored", visibility: "shared", evidence_refs: ["demo-evidence"], principal: a });
assert.equal(promoted.created, true);
const files = await fs.readdir(root, { recursive: true });
assert.equal(files.some((name) => String(name).includes("temporary")), false);
console.log(JSON.stringify({ containers: CONTAINERS, isolation: "passed", temporary: "non-durable-and-explicit-promotion-only", root }, null, 2));
await fs.rm(root, { recursive: true, force: true });
