import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIndexStore } from "../src/index-store.mjs";

async function fixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "index-retry-"));
  await fs.mkdir(path.join(dataRoot, "curated", "shared"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "curated", "shared", "note.md"), [
    "---", 'id: "retry-note"', 'visibility: "shared"', "---", "这是一条用于重试测试的记忆。", "",
  ].join("\n"), "utf8");
  return { dataRoot };
}

const okFetch = async () => ({ ok: true, json: async () => ({ embedding: Array.from({ length: 1024 }, () => 0.01) }) });
const badFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

test("failed embedding is retried and repaired on the next index run", async () => {
  const { dataRoot } = await fixture();
  const failing = createIndexStore({ dataRoot, fetchImpl: badFetch });
  const first = await failing.index();
  assert.equal(first.failed, 1, JSON.stringify(first));

  const healing = createIndexStore({ dataRoot, fetchImpl: okFetch });
  const second = await healing.index();
  assert.equal(second.retriedFailed, 1, JSON.stringify(second));
  assert.equal(second.recoveredFailed, 1, JSON.stringify(second));

  // 再跑一轮：没有失败行可重试，说明已经真的转回 active
  const third = await healing.index();
  assert.equal(third.retriedFailed, 0, JSON.stringify(third));
  assert.equal(third.recoveredFailed, 0, JSON.stringify(third));
});

test("retry can be disabled with MEMORY_INDEX_NO_RETRY=1", async () => {
  const { dataRoot } = await fixture();
  const failing = createIndexStore({ dataRoot, fetchImpl: badFetch });
  await failing.index();
  const previous = process.env.MEMORY_INDEX_NO_RETRY;
  process.env.MEMORY_INDEX_NO_RETRY = "1";
  try {
    const healing = createIndexStore({ dataRoot, fetchImpl: okFetch });
    const second = await healing.index();
    assert.equal(second.retriedFailed, 0, JSON.stringify(second));
  } finally {
    if (previous === undefined) delete process.env.MEMORY_INDEX_NO_RETRY; else process.env.MEMORY_INDEX_NO_RETRY = previous;
  }
});
