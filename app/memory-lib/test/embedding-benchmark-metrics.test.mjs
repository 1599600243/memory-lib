import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, summarizePairScores, summarizeRetrieval } from "../src/embedding-benchmark-metrics.mjs";

test("D18 fixed vectors calculate cosine, gap, threshold accuracy, and AUC", () => {
  const pairs = summarizePairScores([
    { label: "synonym", score: cosineSimilarity([1, 0], [1, 0]) },
    { label: "synonym", score: cosineSimilarity([0.8, 0.6], [1, 0]) },
    { label: "unrelated", score: cosineSimilarity([0, 1], [1, 0]) },
    { label: "unrelated", score: cosineSimilarity([0.6, 0.8], [1, 0]) },
  ]);
  assert.equal(pairs.meanSynonym, 0.9);
  assert.equal(pairs.meanUnrelated, 0.3);
  assert.equal(pairs.gap, 0.6);
  assert.equal(pairs.bestThresholdAccuracy, 1);
  assert.equal(pairs.bestThreshold, 0.7);
  assert.equal(pairs.auc, 1);
});

test("D18 retrieval metrics calculate reciprocal rank, recall, and top-three false positives", () => {
  const metrics = summarizeRetrieval([
    { expected: "a.md", ranked: ["a.md", "noise.md"] },
    { expected: "b.md", ranked: ["noise.md", "b.md"] },
    { expected: "c.md", ranked: ["noise.md", "other.md", "c.md"] },
    { expected: "d.md", ranked: ["noise.md", "other.md"] },
  ]);
  assert.equal(metrics.mrr, 0.458333);
  assert.equal(metrics.recallAt1, 0.25);
  assert.equal(metrics.recallAt3, 0.75);
  assert.equal(metrics.recallAt5, 0.75);
  assert.equal(metrics.top3FalsePositiveRate, 0.25);
});
