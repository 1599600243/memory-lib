import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRoleMemory } from "../src/role-memory.mjs";

const PRINCIPAL = {
  tenant_id: "default", framework_id: "f", agent_id: "admin-01", role_id: "librarian-admin",
  group_id: "home-circle", user_id: "user-owner",
};

function note(overrides = {}) {
  return {
    agent_id: "admin-01", role_id: "librarian-admin",
    kind: "lesson", confidence: "high",
    sections: {
      经验: "验收测试的 fixture 必须使用真实接口返回的形状，否则对象被当数组迭代这类 bug 测不出来。",
      适用场景: "给控制台页面写回归测试时",
      边界: "不适用于一次性脚本；也不替代原文证据",
    },
    evidence_refs: ["conversation-a"],
    ...overrides,
  };
}

test("writes a role note with three sections and lists it", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "role-note-"));
  const roles = createRoleMemory({ dataRoot });
  const result = await roles.putRoleNote(note());
  assert.equal(result.status, "active");
  assert.match(result.path, /curated[\\/]agents[\\/]admin-01[\\/]role-/u);
  const text = await fs.readFile(result.path, "utf8");
  for (const heading of ["经验", "适用场景", "边界"]) assert.match(text, new RegExp(`## ${heading}`));
  const listed = await roles.listRoleNotes({ agent_id: "admin-01", role_id: "librarian-admin", principal: PRINCIPAL });
  assert.equal(listed.length, 1);
});

test("rejects experience shorter than 15 chars", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "role-note-short-"));
  const roles = createRoleMemory({ dataRoot });
  await assert.rejects(
    () => roles.putRoleNote(note({ sections: { ...note().sections, 经验: "太短了" } })),
    /经验 must be >= 15 chars/u,
  );
});

test("rejects user-preference phrasing and points to profile layer", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "role-note-pref-"));
  const roles = createRoleMemory({ dataRoot });
  await assert.rejects(
    () => roles.putRoleNote(note({ sections: { ...note().sections, 经验: "用户要求我用中文回答，而且必须先给结论再给证据，不要只给口头报告。" } })),
    /user-preference/u,
  );
});
