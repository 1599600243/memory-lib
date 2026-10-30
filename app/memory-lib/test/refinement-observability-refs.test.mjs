// REFINE-LOOP-1-REJECT1：巡检的 evidence_refs 关联口径
// 背景：提炼写出的 refs 是 eventId 形式（`session-…#turn-N`），证据文件的 id 是 `conversation-…`。
// 巡检若只按 id 建索引 ⇒ 提炼产出全部关联不上 ⇒ 仪表误报「零精炼 / alert」。
// 本文件锁住三件事：①两种标识都能关联 ②指向不存在的标识不许算关联 ③pending() 同一口径。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRefinementObservability, DEFAULT_INSPECTION_REPORT_RELATIVE_PATH, inspectionReportPath, isInsideRetrievalRoot, REFINED_DIRS } from "../src/refinement-observability.mjs";

const NOW = Date.parse("2026-10-19T00:00:00.000Z");
const fresh = new Date(NOW - 60 * 60 * 1000).toISOString();   // 1 小时前（落在 24h 窗口内）

const roots = [];
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refs-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "evidence", "conversations"), { recursive: true });
  await fs.mkdir(path.join(root, "curated", "shared"), { recursive: true });
  return root;
}
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

// 证据文件：id 是 `conversation-…`，eventId 是 `session-…#turn-N` —— 与生产形态一致
async function writeEvidence(root, { id, eventId, capturedAt = fresh, groupId = "g1", userId = "u1" }) {
  const body = `---\nid: ${id}\ntype: conversation\ncapturedAt: ${capturedAt}\nsource: dsh-session\nconversationId: ${id}\neventId: ${eventId}\ngroupId: "${groupId}"\nuserId: "${userId}"\n---\n\n# 原始对话记录\n\n## 用户\n\n这条对话用来验证巡检的关联口径。\n`;
  await fs.writeFile(path.join(root, "evidence", "conversations", `${id}.md`), body, "utf8");
}

async function writeMemory(root, { id, refs, updatedAt = fresh, groupId = "g1", userId = "u1" }) {
  const body = `---\nid: ${id}\nlayer: long-term\ncontainer: long-term\nvisibility: platform\ntype: memory\nstatus: active\nupdated_at: ${updatedAt}\nevidence_refs: ${JSON.stringify(refs)}\ntenant_id: default\ngroup_id: "${groupId}"\nuser_id: "${userId}"\nagent_id: admin-01\nrole_id: librarian-admin\ntags: ["refined","fact"]\n---\n\n一条提炼出来的事实。\n`;
  await fs.writeFile(path.join(root, "curated", "shared", `${id}.md`), body, "utf8");
}

test("两种标识都要能关联：refs 写 id 的、写 eventId 的各一条，都要算已关联", async () => {
  const root = await makeRoot();
  await writeEvidence(root, { id: "conversation-aaa111", eventId: "session-aaa111#turn-1" });
  await writeEvidence(root, { id: "conversation-bbb222", eventId: "session-bbb222#turn-2" });
  await writeMemory(root, { id: "m-by-id", refs: ["conversation-aaa111"] });
  await writeMemory(root, { id: "m-by-eventid", refs: ["session-bbb222#turn-2"] });

  const metrics = await createRefinementObservability({ dataRoot: root, threshold: 1, now: () => NOW }).snapshot();
  assert.equal(metrics.raw_conversations, 2);
  assert.equal(metrics.refined_memories, 2, "id 形式与 eventId 形式都必须关联上");
  assert.equal(metrics.alert.status, "ok");
});

test("负向：refs 指向不存在的 id / eventId，一律不算已关联（不许为了变绿放宽成随便算）", async () => {
  const root = await makeRoot();
  await writeEvidence(root, { id: "conversation-aaa111", eventId: "session-aaa111#turn-1" });
  await writeMemory(root, { id: "m-by-eventid", refs: ["session-aaa111#turn-1"] });
  await writeMemory(root, { id: "m-ghost-id", refs: ["conversation-does-not-exist"] });
  await writeMemory(root, { id: "m-ghost-event", refs: ["session-nope#turn-9"] });
  await writeMemory(root, { id: "m-ghost-both", refs: ["conversation-ghost", "session-ghost#turn-1"] });

  const metrics = await createRefinementObservability({ dataRoot: root, threshold: 1, now: () => NOW }).snapshot();
  assert.equal(metrics.refined_memories, 1, "只有真正指向存在证据的那一条算关联");
});

test("一条记忆同时带 id 与 eventId 也只算一次（去重，不重复计数）", async () => {
  const root = await makeRoot();
  await writeEvidence(root, { id: "conversation-aaa111", eventId: "session-aaa111#turn-1" });
  await writeMemory(root, { id: "m-both", refs: ["conversation-aaa111", "session-aaa111#turn-1"] });
  const metrics = await createRefinementObservability({ dataRoot: root, threshold: 1, now: () => NOW }).snapshot();
  assert.equal(metrics.refined_memories, 1);
});

test("同一类口径：pending() 也不能把 eventId 已关联的证据当成没提炼", async () => {
  const root = await makeRoot();
  await writeEvidence(root, { id: "conversation-linked", eventId: "session-linked#turn-1" });
  await writeEvidence(root, { id: "conversation-untouched", eventId: "session-untouched#turn-1" });
  await writeMemory(root, { id: "m-by-eventid", refs: ["session-linked#turn-1"] });

  const obs = createRefinementObservability({ dataRoot: root, threshold: 3, now: () => NOW });
  const pending = await obs.pending({ since: "1970-01-01", limit: 50 });
  const ids = pending.items.map((item) => item.evidence_id);
  assert.equal(pending.total_count, 1, "只有真正没被提炼过的那条才算待提炼");
  assert.deepEqual(ids, ["conversation-untouched"]);
});

test("eventId 形式关联后，仪表不再按零精炼报警", async () => {
  const root = await makeRoot();
  // 3 条证据、threshold 3：全部只用 eventId 关联 ⇒ 不该触发 alert
  for (const n of [1, 2, 3]) {
    await writeEvidence(root, { id: `conversation-c${n}`, eventId: `session-c${n}#turn-1` });
    await writeMemory(root, { id: `m-c${n}`, refs: [`session-c${n}#turn-1`] });
  }
  const metrics = await createRefinementObservability({ dataRoot: root, threshold: 3, now: () => NOW }).snapshot();
  assert.equal(metrics.refined_memories, 3);
  assert.equal(metrics.refined_last_24h, 3);
  assert.equal(metrics.refinement_ratio, 1);
  assert.equal(metrics.alert.consecutive_zero_refinement, 0);
  assert.equal(metrics.alert.status, "ok");
  assert.equal(metrics.alert.audible, false);
});

// ---------------------------------------------------------------------------
// REFINE-LOOP-1-REJECT1C：巡检报告**不进检索根**（产品岗裁决）
// 历史：6009735 写 project-state/（进检索根）→ bb62f7b 挪到 runtime/ → REJECT1b 一度改回
// project-state/（结果任何身份的 /v1/get 都能读到它，404→200），→ 本单裁决：默认回 runtime/，
// project-state 那份只能由运维**显式指定**。这里把默认落点与"不在检索根"都钉死。
// ---------------------------------------------------------------------------
test("默认落点 = runtime/（检索根之外），且不在任何 REFINED_DIRS 之下", async () => {
  const root = await makeRoot();
  const expected = path.join(root, "runtime", "refinement-inspection.md");
  const obs = createRefinementObservability({ dataRoot: root, threshold: 3, now: () => NOW });
  const result = await obs.inspect();
  assert.equal(result.report_path, expected, "默认必须落在 runtime/（产品岗裁决：巡检报告不进检索根）");
  assert.equal(inspectionReportPath(root), expected, "导出的路径函数必须与 inspect() 实际落的路径一致");
  const body = await fs.readFile(expected, "utf8");
  assert.match(body, /^# 记忆精炼巡检报告/mu, "落点的确是巡检报告本身");
  // 防回退（本单硬要求②）：默认落点绝不许落在任何检索根之下
  assert.equal(isInsideRetrievalRoot(result.report_path, root), false, "巡检报告不许落进检索根");
  for (const dir of REFINED_DIRS) {
    assert.ok(!inspectionReportPath(root).split(path.sep).includes(dir), `默认落点不许在 ${dir}/ 之下`);
  }
  // project-state 那份**不是**默认产物（不许双写）
  const leaked = await fs.stat(path.join(root, "project-state", "memory-system", "refinement-inspection.md")).catch(() => null);
  assert.equal(leaked, null, "默认不许再写 project-state/memory-system/refinement-inspection.md（单落点）");
});

test("落点可配置：显式 reportPath 生效，且默认那份不生成（project-state 只能是显式选择）", async () => {
  const root = await makeRoot();
  // 产品岗裁决：project-state 那份只作为「需要时显式指定」的可选项，不做默认
  const optIn = path.join(root, "project-state", "memory-system", "refinement-inspection.md");
  const obs = createRefinementObservability({ dataRoot: root, threshold: 3, now: () => NOW, reportPath: optIn });
  const result = await obs.inspect();
  assert.equal(result.report_path, path.resolve(optIn));
  assert.ok((await fs.stat(optIn).catch(() => null)), "显式 reportPath 必须被尊重");
  const byDefault = await fs.stat(path.join(root, "runtime", "refinement-inspection.md")).catch(() => null);
  assert.equal(byDefault, null, "配置了别处就不许再写默认位置（单落点，不双写）");
});

test("默认落点常量本身钉死（防止有人悄悄改路径又不打招呼）", () => {
  assert.equal(DEFAULT_INSPECTION_REPORT_RELATIVE_PATH.split(path.sep).join("/"), "runtime/refinement-inspection.md");
  assert.equal(isInsideRetrievalRoot(DEFAULT_INSPECTION_REPORT_RELATIVE_PATH), false, "常量本身就不许指向检索根");
});