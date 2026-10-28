// SHORT-Q-1 — short two-character queries use the exact postings and a narrow eligibility threshold.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIndexStore } from "../src/index-store.mjs";
import { selectCandidates } from "../src/recall-candidates.mjs";
import { createRecall, queryTokens, scoreTokens } from "../src/recall.mjs";

const PRINCIPAL = {
  framework_id: "short-q-test",
  tenant_id: "default",
  agent_id: "agent-1",
  role_id: "reader",
  group_id: "g1",
  user_id: "u1",
};

function memoryFile(id, fact) {
  return `---\nid: "${id}"\nlayer: "long-term"\ncontainer: "long-term"\nvisibility: "platform"\nstatus: "active"\ncalendarDate: "2026-10-22"\n---\n\n${fact}\n`;
}

function fakeFetch() {
  return async () => ({ ok: true, status: 200, json: async () => ({ embedding: [1] }) });
}

async function makeIndexedFixture(specs) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "short-q-1-"));
  const memoriesRoot = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(memoriesRoot, { recursive: true });
  for (const { id, fact } of specs) await fs.writeFile(path.join(memoriesRoot, `${id}.md`), memoryFile(id, fact), "utf8");
  const store = createIndexStore({ dataRoot, ollama: { dimension: 1 }, fetchImpl: fakeFetch() });
  const indexed = await store.index();
  assert.equal(indexed.failed, 0);
  return { dataRoot, memoriesRoot };
}

async function recallOne(dataRoot, query) {
  const recall = createRecall({ dataRoot, workspaceRoot: dataRoot });
  return recall.recallBrief({
    principal: PRINCIPAL,
    format: "prompt",
    memory_only: true,
    query,
    memories: 1,
    memory_limit_chars: 600,
  });
}

test("SHORT-Q-1 threshold admits one two-character token but never one-character queries", () => {
  assert.deepEqual(queryTokens("验收"), ["验收"]);
  assert.equal(scoreTokens(queryTokens("验收"), "验收结论已经通过。 ").enough, true);
  assert.deepEqual(queryTokens("8层"), ["8层"], "mixed digit+CJK short query must stay exact");
  assert.equal(scoreTokens(queryTokens("8层"), "记忆库已经收敛为8层。 ").enough, true);
  assert.equal(scoreTokens(queryTokens("验收是什么"), "只提到了验收。 ").enough, false, "three-or-more-token queries keep the old threshold");
  assert.equal(scoreTokens(["abc"], "abc").enough, false, "one three-character token keeps the old threshold");
  assert.equal(scoreTokens(["abcd"], "abcd").enough, true, "one four-character token keeps the old threshold");
  for (const query of ["层", "验", "8"]) {
    assert.deepEqual(queryTokens(query), [], `single-character query must remain tokenless: ${query}`);
    assert.equal(scoreTokens(queryTokens(query), `噪声也可能包含${query}`).enough, false);
  }
});

test("SHORT-Q-1 threshold is short-query-only and preserves the historical B-query gate", () => {
  const longQuery = "我们上次讨论验收的结论是什么";
  const longTokens = queryTokens(longQuery);
  assert.ok(longTokens.length >= 3, JSON.stringify(longTokens));
  assert.equal(scoreTokens(longTokens, "我们上次讨论验收的结论是什么。 ").enough, true, "control: legacy gate admits multiple matched tokens");
  assert.equal(scoreTokens(["验收", "什么"], "只提到了验收。 ").enough, true, "scoreTokens receives tokens only; recall must determine eligibility from the original query shape");
});

test("SHORT-Q-1 threshold counts original query shape, not deduplicated token count", () => {
  assert.deepEqual(queryTokens("验收 验收"), ["验收"], "repeated short terms collapse to one scoring token");
  assert.equal(scoreTokens(queryTokens("验收 验收"), "只提到了验收。 ").enough, true, "scoreTokens gets tokens only and cannot decide short-query eligibility");
});

test("SHORT-Q-1 bare two-character and mixed queries retrieve their exact facts", async () => {
  const fx = await makeIndexedFixture([
    { id: "acceptance-fact", fact: "验收结论必须保留完整证据。" },
    { id: "eight-layer-fact", fact: "记忆系统采用8层架构，并按层隔离。" },
  ]);
  try {
    const acceptance = await recallOne(fx.dataRoot, "验收");
    assert.equal(acceptance.included[0]?.id, "acceptance-fact", JSON.stringify(acceptance));
    assert.match(acceptance.included[0]?.excerpt ?? "", /验收/u);
    const layers = await recallOne(fx.dataRoot, "8层");
    assert.equal(layers.included[0]?.id, "eight-layer-fact", JSON.stringify(layers));
    assert.match(layers.included[0]?.excerpt ?? "", /8层/u);
    for (const query of ["层", "验", "8"]) {
      const single = await recallOne(fx.dataRoot, query);
      assert.equal(single.included.length, 0, `single-character query must not become a recent-memory query: ${JSON.stringify(single)}`);
    }
    const repeatedShortWord = await recallOne(fx.dataRoot, "验收 验收");
    assert.equal(repeatedShortWord.included.length, 0, `deduplicated two-char tokens must not turn a long original query into a SHORT-Q query: ${JSON.stringify(repeatedShortWord)}`);
    for (const query of ["8层 在 哪", "8层 怎 样", "8层 呢", "8层 是 啥", "8层 有 用 吗"]) {
      const spaced = await recallOne(fx.dataRoot, query);
      assert.equal(spaced.included.length, 1, `multi-character tokenless query must preserve recent-memory fallback: ${JSON.stringify(spaced)}`);
    }
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("SHORT-Q-1 exact bigram postings avoid LIKE overflow", async () => {
  const specs = Array.from({ length: 205 }, (_, index) => ({
    id: `acceptance-${String(index).padStart(3, "0")}`,
    fact: `第${index}条验收记录。`,
  }));
  const fx = await makeIndexedFixture(specs);
  try {
    const scan = await selectCandidates({
      dataRoot: fx.dataRoot,
      memoriesRoot: fx.memoriesRoot,
      query: "验收",
      wanted: 1,
    });
    assert.equal(scan.mode, "candidates", JSON.stringify(scan));
    assert.equal(scan.source, "df-bigram", JSON.stringify(scan));
    assert.equal(scan.reason, null);
    assert.equal(scan.candidateFiles, 205);
    assert.equal(scan.bigramHits, 205);
    assert.equal(scan.likeHits, 0);
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
