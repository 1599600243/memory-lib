import test from "node:test";
import assert from "node:assert/strict";
import { CONTAINERS, normalizeContainerScope, principalAllowsContainer, pathContainer } from "../src/container-policy.mjs";

test("M1.2 defines exactly nine containers and normalizes legacy layers", () => {
  assert.deepEqual(CONTAINERS, ["temporary", "evidence", "long-term", "project", "tool", "graph", "plan", "role", "knowledge"]);
  assert.deepEqual(normalizeContainerScope({ layer: "curated-shared", visibility: "shared" }), { container: "long-term", visibility: "shared", project: null });
  assert.deepEqual(normalizeContainerScope({ layer: "project-state", visibility: "project", project: "alpha" }), { container: "project", visibility: "project", project: "alpha" });
  assert.equal(normalizeContainerScope({ layer: "unknown", visibility: "shared" }), null);
});

test("M1.2 principal visibility isolates private data and permits same-group project/shared data", () => {
  const a = { group_id: "g-a", user_id: "u-a", agent_id: "a-a", role_id: "r-a" };
  const b = { group_id: "g-b", user_id: "u-b", agent_id: "a-b", role_id: "r-b" };
  const sameGroup = { group_id: "g-a", user_id: "u-c", agent_id: "a-c", role_id: "r-c" };
  assert.equal(principalAllowsContainer(a, { container: "role", visibility: "role", role_id: "r-a" }), true);
  assert.equal(principalAllowsContainer(b, { container: "role", visibility: "role", role_id: "r-a" }), false);
  assert.equal(principalAllowsContainer(a, { container: "project", visibility: "project", project: "alpha", group_id: "g-a" }), true);
  assert.equal(principalAllowsContainer(b, { container: "project", visibility: "project", project: "alpha", group_id: "g-a" }), false);
  assert.equal(principalAllowsContainer(sameGroup, { container: "project", visibility: "project", project: "alpha", group_id: "g-a" }), true);
  assert.equal(principalAllowsContainer(sameGroup, { container: "long-term", visibility: "shared", group_id: "g-a" }), true);
  assert.equal(principalAllowsContainer(b, { container: "long-term", visibility: "shared", group_id: "g-a" }), false);
  assert.equal(principalAllowsContainer(a, { container: "temporary", visibility: "private" }), false);
});

test("sentinel ownership comparisons reject both sides after whitespace/case normalization", () => {
  const sentinels = ["unknown", "", "null", "n/a", "-"];
  const ownership = ["user_id", "agent_id", "role_id"];
  for (const key of ownership) {
    for (const sentinel of sentinels) {
      const container = key === "role_id" ? "role" : "long-term";
      const visibility = key === "role_id" ? "role" : "private";
      const metadata = { container, visibility, [key]: sentinel };
      const normalized = sentinel === "" ? "  " : ` ${sentinel.toUpperCase()} `;
      assert.equal(principalAllowsContainer({ [key]: sentinel }, metadata), false, `${key} self-matched sentinel ${JSON.stringify(sentinel)}`);
      assert.equal(principalAllowsContainer({ [key]: normalized }, metadata), false, `${key} principal sentinel normalization failed for ${sentinel}`);
      assert.equal(principalAllowsContainer({ [key]: "owner-real" }, { container, visibility, [key]: "owner-real" }), true, `${key} real identity stopped matching`);
    }
  }
});

test("group sentinels retain baseline equality and missing-group compatibility", () => {
  const sentinels = ["unknown", "null", "n/a", "-"];
  for (const sentinel of sentinels) {
    const normalized = ` ${sentinel.toUpperCase()} `;
    const metadata = { container: "project", visibility: "project", project: "alpha", group_id: sentinel };
    assert.equal(principalAllowsContainer({ group_id: sentinel }, metadata), true, `equal group sentinel compatibility changed for ${sentinel}`);
    assert.equal(principalAllowsContainer({ group_id: normalized }, metadata), false, `group comparison must remain exact for ${sentinel}`);
    assert.equal(principalAllowsContainer({ group_id: "real-g" }, metadata), false, `real principal group must not match sentinel memory group ${sentinel}`);
    assert.equal(principalAllowsContainer({ group_id: sentinel }, { ...metadata, group_id: "real-g" }), false, `sentinel principal group must not match real memory group ${sentinel}`);
    assert.equal(principalAllowsContainer({ group_id: sentinel }, { container: "long-term", visibility: "shared", group_id: sentinel }), true, `shared equal group sentinel compatibility changed for ${sentinel}`);
  }
  assert.equal(principalAllowsContainer({ group_id: "unknown" }, { container: "project", visibility: "project", project: "alpha", group_id: "real-g" }), false, "unknown principal group expanded project access");
  assert.equal(principalAllowsContainer({ group_id: "unknown" }, { container: "long-term", visibility: "shared", group_id: "real-g" }), false, "unknown principal group expanded shared access");
  assert.equal(principalAllowsContainer({ group_id: null }, { container: "project", visibility: "project", project: "alpha", group_id: "g-a" }), true, "project absent principal group compatibility changed");
  assert.equal(principalAllowsContainer({ group_id: null }, { container: "long-term", visibility: "shared", group_id: "g-a" }), true, "shared absent principal group compatibility changed");
  assert.equal(principalAllowsContainer({ group_id: "g-a" }, { container: "project", visibility: "project", project: "alpha", group_id: "" }), true, "empty metadata group compatibility changed");
});

test("platform, shared, and path-container behavior remain stable", () => {
  assert.equal(principalAllowsContainer({ user_id: "unknown" }, { container: "long-term", visibility: "platform", user_id: "unknown" }), true);
  assert.equal(principalAllowsContainer({ group_id: "g-a" }, { container: "long-term", visibility: "shared", group_id: "g-a" }), true);
  assert.equal(principalAllowsContainer({ group_id: "g-b" }, { container: "long-term", visibility: "shared", group_id: "g-a" }), false);
  assert.equal(pathContainer("C:/data/memory", "C:/data/memory/curated/agents/a/n.md"), "role");
  assert.equal(pathContainer("C:/data/memory", "C:/data/memory/evidence/conversations/x.md"), "evidence");
});

test("M1.2 temporary memory is session-local, expires, and promotes explicitly", async () => {
  const { createMemoryWriter } = await import("../src/write-memory.mjs");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-m1-2-temp-"));
  const writer = createMemoryWriter({ dataRoot: root });
  await writer.putTemporary({ key: "session-item", body: "private scratch", ttlMs: 5, principal: { role_id: "r-a" } });
  assert.equal((await writer.getTemporary("session-item", { role_id: "r-b" })), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await writer.getTemporary("session-item", { role_id: "r-a" }), null);
  await writer.putTemporary({ key: "promote", body: "explicit durable", principal: { role_id: "r-a" } });
  const promoted = await writer.promoteTemporary("promote", "curated-shared", { evidence_refs: ["e1"], principal: { role_id: "r-a" }, visibility: "shared", id: "promoted" });
  assert.equal(promoted.created, true);
  assert.equal((await fs.readdir(root)).includes("temporary"), false);
});

test("M1.2 maps existing storage without treating raw evidence as searchable", () => {
  assert.equal(pathContainer("C:/data/memory", "C:/data/memory/curated/agents/a/n.md"), "role");
  assert.equal(pathContainer("C:/data/memory", "C:/data/memory/evidence/conversations/x.md"), "evidence");
});
