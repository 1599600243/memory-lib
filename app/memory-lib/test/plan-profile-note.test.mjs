import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlansMemory, PLAN_SECTIONS } from "../src/plans-memory.mjs";
import { createProfileMemory } from "../src/profile-memory.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";

const PRINCIPAL = {
  tenant_id: "default", framework_id: "f", agent_id: "admin-01", role_id: "librarian-admin",
  group_id: "home-circle", user_id: "user-owner",
};

async function fixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-profile-"));
  return { dataRoot };
}

test("writes a plan with checkbox steps and lists it", async () => {
  const { dataRoot } = await fixture();
  const plans = createPlansMemory({ dataRoot });
  const result = await plans.writePlan({
    topic: "控制台 v2 收尾",
    sections: { 目标: "把页面数据源对齐真实能力", 步骤: "- [x] 知识库\n- [ ] 计划/画像", 当前卡点: "学习流程未启用" },
    evidence_refs: ["conversation-a"], principal: PRINCIPAL,
  });
  assert.equal(result.topic, "控制台 v2 收尾");
  // 新计划必须是 draft，确认后才变 active（产品规则）
  await plans.confirm("控制台 v2 收尾", { evidence_refs: ["conversation-a"], principal: PRINCIPAL });
  const listed = await plans.listPlans({ include_done: true, principal: PRINCIPAL });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "active");
  const text = await fs.readFile(result.path, "utf8");
  for (const heading of PLAN_SECTIONS) assert.match(text, new RegExp(`## ${heading}`));
});

test("rejects a plan whose steps have no checkbox line", async () => {
  const { dataRoot } = await fixture();
  const plans = createPlansMemory({ dataRoot });
  await assert.rejects(
    () => plans.writePlan({ topic: "无勾选", sections: { 目标: "g", 步骤: "只有文字", 当前卡点: "b" }, evidence_refs: ["conversation-a"], principal: PRINCIPAL }),
    /checkbox/u,
  );
});

test("writes a profile fact and lists it back", async () => {
  const { dataRoot } = await fixture();
  const writer = createMemoryWriter({ dataRoot });
  const written = await writer.write({
    layer: "profile", id: "user-prefers-chinese",
    body: "主人要求解释用中文，先结论后证据。", tags: ["preference"],
    evidence_refs: ["conversation-a"], principal: PRINCIPAL,
  });
  assert.equal(written.ok, true, JSON.stringify(written));
  const profiles = createProfileMemory({ dataRoot });
  const listed = await profiles.listProfiles({ include_draft: true, principal: PRINCIPAL });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "user-prefers-chinese");
});
