import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createConversationMemory } from "../src/conversation-memory.mjs";
import { createRefinementObservability } from "../src/refinement-observability.mjs";
import { createMemoryWriter } from "../src/write-memory.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m2-"));
after(() => fs.rm(root, { recursive: true, force: true }));

test("health exposes zero-refinement metrics, alert, and report without mechanical pointer", async () => {
  const events = [];
  const obs = createRefinementObservability({ dataRoot: root, threshold: 1, audit: { record: async (e) => events.push(e) } });
  const capture = createConversationMemory({ dataRoot: root, onCaptured: (event) => obs.onCapture(event) });
  const result = await capture.capture({ conversationId: "m2-1", eventId: "m2-1", source: "test", messages: [
    { role: "user", content: "请记住这项决定" },
    { role: "assistant", content: "结论：采用窄兜底，并保留证据引用。" },
  ], principal: { group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" } });
  const metrics = await obs.inspect();
  assert.equal(metrics.raw_conversations, 1);
  assert.equal(metrics.refined_memories, 0);
  assert.equal(metrics.alert.audible, true);
  assert.equal(metrics.alert.status, "alert");
  assert.equal(events[0].action, "refinement_alert");
  assert.match(await fs.readFile(metrics.report_path, "utf8"), /最近一次真正记住：从未/u);
  const curated = await fs.readdir(path.join(root, "curated", "shared")).catch(() => []);
  assert.deepEqual(curated, []);
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: path.dirname(root), refinementThreshold: 1, vectorLane: { probe: false } });
  const health = await lib.health();
  assert.equal(health.refinement.last_refined_at, null);
  assert.equal(health.refinement.refined_last_24h, 0);
  assert.equal(health.refinement.alert.audible, true);
  assert.equal(health.refinement.alert.signal, "audible");
  const writer = createMemoryWriter({ dataRoot: root });
  await writer.write({ layer: "curated-shared", id: "real-refinement", body: "正式精炼结论", evidence_refs: [result.evidenceId], principal: { group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" }, visibility: "shared" });
  const cleaned = await lib.refinement.cleanupStubs();
  assert.equal(cleaned.removed, 0);
  const after = await lib.refinement.snapshot();
  assert.equal(after.refined_memories, 1);
  assert.equal(after.alert.audible, false);
});

test("attribution is persisted and scoped metrics filter raw, refined, and alerts", async () => {
  const scopedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m2-scope-"));
  try {
    const obs = createRefinementObservability({ dataRoot: scopedRoot, threshold: 1 });
    const capture = createConversationMemory({ dataRoot: scopedRoot, onCaptured: (event) => obs.onCapture(event) });
    await capture.capture({ conversationId: "g1", eventId: "g1", source: "test", messages: [{ role: "user", content: "g1" }], principal: { group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" } });
    await capture.capture({ conversationId: "g1b", eventId: "g1b", source: "test", messages: [{ role: "user", content: "g1 second" }], principal: { group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" } });
    const g2Result = await capture.capture({ conversationId: "g2", eventId: "g2", source: "test", messages: [{ role: "user", content: "g2" }], principal: { group_id: "g2", user_id: "u2", agent_id: "a2", role_id: "r2" } });
    await assert.rejects(
      capture.capture({ conversationId: "unknown", eventId: "unknown", source: "test", messages: [{ role: "user", content: "unknown" }] }),
      /principal group_id and user_id/u,
    );
    const index = JSON.parse(await fs.readFile(path.join(scopedRoot, "evidence", "conversations", "capture-index.json"), "utf8"));
    const evidenceId = Object.values(index.events)[0].evidenceId;
    const evidence = await fs.readFile(path.join(scopedRoot, "evidence", "conversations", `${evidenceId}.md`), "utf8");
    assert.match(evidence, /groupId: "g[12]"/u);
    assert.match(evidence, /userId: "u[12]"/u);
    const g1 = await obs.snapshot({ group_id: "g1" });
    const g2 = await obs.snapshot({ group_id: "g2" });
    assert.equal(g1.raw_conversations, 2);
    assert.equal(g2.raw_conversations, 1);
    assert.equal(g1.plan.scope, "scoped");
    assert.equal(g1.alert.consecutive_zero_refinement, 2);
    assert.equal(g2.alert.consecutive_zero_refinement, 1);
    const u1 = await obs.snapshot({ user_id: "u1" });
    assert.equal(u1.raw_conversations, 2);
    const writer = createMemoryWriter({ dataRoot: scopedRoot });
    await writer.write({ layer: "curated-shared", id: "g2-refinement", body: "g2 formal", evidence_refs: [g2Result.evidenceId], principal: { group_id: "g2", user_id: "u2", agent_id: "a2", role_id: "r2" }, visibility: "shared" });
    const g2After = await obs.snapshot({ group_id: "g2" });
    const g1After = await obs.snapshot({ group_id: "g1" });
    assert.equal(g2After.refined_memories, 1);
    assert.equal(g2After.alert.audible, false);
    assert.equal(g1After.refined_memories, 0);
    assert.equal(g1After.alert.audible, true);
    const global = await obs.snapshot();
    assert.equal(global.unattributed_conversations_global, 0);
  } finally { await fs.rm(scopedRoot, { recursive: true, force: true }); }
});

test("zero-refinement capture creates no mechanical curated pointer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint8-") );
  try {
    const obs = createRefinementObservability({ dataRoot: dir });
    const capture = createConversationMemory({ dataRoot: dir, onCaptured: (event) => obs.onCapture(event) });
    const captures = [];
    for (let i = 0; i < 5; i += 1) captures.push(await capture.capture({ conversationId: `maint8-${i}`, eventId: `maint8-${i}`, source: "test", messages: [{ role: "user", content: `诉求 ${i} ${"x".repeat(120)}` }, { role: "assistant", content: `UNIQUE-TAIL-${i}` }], principal: { group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" } }));
    const files = (await fs.readdir(path.join(dir, "curated", "shared")).catch(() => [])).filter((name) => name.startsWith("auto-stub-"));
    assert.deepEqual(files, []);
    const parsed = await obs.snapshot({ group_id: "g1", user_id: "u2" });
    assert.equal(parsed.raw_conversations, 0);
    const writer = createMemoryWriter({ dataRoot: dir });
    await writer.write({ layer: "curated-shared", id: "real-maint8", body: "正式精炼", evidence_refs: [captures[0].evidenceId], principal: { group_id: "g1", user_id: "u1" }, visibility: "shared" });
    const cleaned = await obs.cleanupStubs();
    assert.equal(cleaned.removed, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("zero-refinement streak uses captures after latest refinement", async () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const hour = 60 * 60 * 1000;
  async function makeFixture(label, rawTimes, refinedTimes) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `memory-lib-m2-streak-${label}-`));
    await fs.mkdir(path.join(dir, "evidence", "conversations"), { recursive: true });
    await fs.mkdir(path.join(dir, "curated", "shared"), { recursive: true });
    for (let i = 0; i < rawTimes.length; i += 1) await fs.writeFile(path.join(dir, "evidence", "conversations", `raw-${i}.md`), `---\nid: raw-${i}\ntype: conversation\ncapturedAt: ${rawTimes[i]}\ngroupId: "g1"\nuserId: "u1"\n---\n`, "utf8");
    for (let i = 0; i < refinedTimes.length; i += 1) await fs.writeFile(path.join(dir, "curated", "shared", `refined-${i}.md`), `---\nid: refined-${i}\nupdated_at: ${refinedTimes[i]}\nevidence_refs: ["raw-0"]\ngroup_id: "g1"\nuser_id: "u1"\nstatus: active\n---\n历史精炼\n`, "utf8");
    return dir;
  }
  const cases = [
    { label: "historical-stop", raw: [1, 2, 3].map((n) => new Date(now - n * hour).toISOString()), refined: [new Date(now - 48 * hour).toISOString()], count: 3, refinedCount: 1, audible: true },
    { label: "recent-refinement", raw: [new Date(now - 3 * hour).toISOString()], refined: [new Date(now - 2 * hour).toISOString()], count: 0, refinedCount: 1, audible: false },
    { label: "never-refined", raw: [1, 2, 3].map((n) => new Date(now - n * hour).toISOString()), refined: [], count: 3, refinedCount: 0, audible: true },
    { label: "below-threshold", raw: [1, 2].map((n) => new Date(now - n * hour).toISOString()), refined: [], count: 2, refinedCount: 0, audible: false },
  ];
  for (const item of cases) {
    const dir = await makeFixture(item.label, item.raw, item.refined);
    try {
      const metrics = await createRefinementObservability({ dataRoot: dir, threshold: 3, now: () => now }).snapshot({ group_id: "g1" });
      assert.equal(metrics.refined_memories, item.refinedCount, item.label);
      assert.equal(metrics.alert.consecutive_zero_refinement, item.count, item.label);
      assert.equal(metrics.alert.audible, item.audible, item.label);
      if (item.label === "recent-refinement") assert.equal(metrics.last_refined_at, item.refined[0], item.label);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});
