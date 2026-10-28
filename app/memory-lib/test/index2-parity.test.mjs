// INDEX-2: candidate screening must preserve the final included sequence.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIndexStore } from "../src/index-store.mjs";
import { createRecall } from "../src/recall.mjs";

const PRINCIPAL = {
  framework_id: "f1",
  tenant_id: "default",
  agent_id: "agent-1",
  role_id: "role-1",
  group_id: "g1",
  user_id: "u1",
};

function memoryFile({ id, date, fact, visibility = "platform", userId = "unknown" }) {
  return `---
id: "${id}"
layer: "long-term"
container: "long-term"
visibility: "${visibility}"
status: "active"
calendarDate: "${date}"
user_id: "${userId}"
---

${fact}
`;
}

async function writeMemory(shared, spec) {
  await fs.writeFile(path.join(shared, `${spec.id}.md`), memoryFile(spec), "utf8");
}

function fakeFetch() {
  return async () => ({ ok: true, status: 200, json: async () => ({ embedding: [1] }) });
}

async function recallIds(dataRoot, query, memories = 2) {
  const recall = createRecall({ dataRoot, workspaceRoot: dataRoot });
  const result = await recall.recallBrief({
    principal: PRINCIPAL,
    format: "prompt",
    memory_only: true,
    query,
    memories,
    memory_limit_chars: 600,
  });
  return { ids: result.included.map((row) => row.id), source: result.candidate_source };
}

test("INDEX-2 incremental update keeps postings current and ranks updated unique text", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "index2-incremental-"));
  const shared = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(shared, { recursive: true });
  try {
    await writeMemory(shared, { id: "answer", date: "2026-10-01", fact: "丙丁答案事实。" });
    await writeMemory(shared, { id: "noise", date: "2026-10-02", fact: "甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙。" });
    await writeMemory(shared, { id: "filler", date: "2026-10-03", fact: "甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙。" });
    const store = createIndexStore({ dataRoot, ollama: { dimension: 1 }, fetchImpl: fakeFetch() });
    const first = await store.index();
    assert.equal(first.failed, 0);

    const changedPath = path.join(shared, "noise.md");
    await writeMemory(shared, { id: "noise", date: "2026-10-02", fact: "甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙甲乙。更新标记丙丁。" });
    const refreshed = await store.index({ paths: [changedPath] });
    assert.equal(refreshed.changed, 1);
    assert.equal(refreshed.failed, 0);

    const result = await recallIds(dataRoot, "甲乙更新", 3);
    assert.equal(result.source, "full", `two-character matches below the requested pool size must full-fallback, actual ${result.source}`);
    assert.deepEqual(result.ids, ["noise"], `incremental postings and full ranking must reflect the changed text, actual ${JSON.stringify(result.ids)}`);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("INDEX-2 global df: indexed candidates keep the full-scan order for the same principal", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "index2-df-"));
  const shared = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(shared, { recursive: true });
  try {
    await writeMemory(shared, { id: "candidate-a", date: "2026-10-01", fact: "甲乙丙流程采用旧版方案。" });
    await writeMemory(shared, { id: "candidate-b", date: "2026-10-02", fact: "乙丙丁流程采用新版方案。" });
    for (let i = 0; i < 10; i += 1) {
      await writeMemory(shared, { id: `df-only-${i}`, date: "2026-09-01", fact: `第${i}条备注只含甲乙。` });
    }
    for (let i = 0; i < 8; i += 1) {
      await writeMemory(shared, {
        id: `private-df-only-${i}`,
        date: "2026-09-01",
        fact: `私有第${i}条只含丙丁。`,
        visibility: "user",
        userId: "other-user",
      });
    }

    const full = await recallIds(dataRoot, "甲乙丙丁");
    assert.equal(full.source, "full");
    assert.deepEqual(full.ids, ["candidate-b", "candidate-a"]);

    const store = createIndexStore({ dataRoot, ollama: { dimension: 1 }, fetchImpl: fakeFetch() });
    const indexed = await store.index();
    assert.equal(indexed.failed, 0);

    const screened = await recallIds(dataRoot, "甲乙丙丁");
    assert.equal(screened.source, "fts");
    assert.deepEqual(screened.ids, full.ids);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
