import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRoleKey, authenticateRoleKey, revokeRole, keyDigest } from "../src/api-key-registry.mjs";

test("M1.1 key is shown once, maps to one role, and revocation is immediate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "m11-key-"));
  const file = path.join(dir, "api-keys.json");
  const result = await createRoleKey({ file, groupId: "group-a", userId: "user-a", roleId: "role-a", roleName: "assistant", pepper: "test-pepper" });
  assert.match(result.secret, /^mlk_/);
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes(result.secret), false);
  assert.equal(raw.includes("Authorization"), false);
  assert.equal(raw.includes(result.prefix), true);
  assert.equal(keyDigest(result.secret, "test-pepper").length, 64);
  const principal = await authenticateRoleKey({ file, presented: result.secret, pepper: "test-pepper" });
  assert.deepEqual({ role_id: principal.role_id, user_id: principal.user_id, group_id: principal.group_id }, { role_id: "role-a", user_id: "user-a", group_id: "group-a" });
  assert.equal((await authenticateRoleKey({ file, presented: "mlk_wrong", pepper: "test-pepper" })), null);
  await revokeRole({ file, roleId: "role-a" });
  assert.equal(await authenticateRoleKey({ file, presented: result.secret, pepper: "test-pepper" }), null);
  await fs.rm(dir, { recursive: true, force: true });
});
