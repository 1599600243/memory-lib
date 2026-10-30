import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d8-rank-"));
test.after(() => fs.rm(root, { recursive: true, force: true }));

test("search exposes a monotonic rankKey while score remains same-tier relevance", async () => {
  for (const [name, body, importance] of [["current-state.md", "记忆核心 当前进展 下一步 阻塞", "critical"], ["candidate.md", "记忆核心 普通候选", "ordinary"], ["third.md", "记忆核心 旧内容", "ordinary"]]) {
    const file = path.join(root, "curated", "shared", name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nid: ${name}\nstatus: active\nimportance: ${importance}\nupdated_at: ${new Date().toISOString()}\n---\n\n${body}\n`);
  }
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null });
  const hits = await lib.search({ query: "记忆核心", limit: 3, graphExpand: false });
  assert.ok(hits.every((hit) => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1 && Number.isInteger(hit.tier) && Number.isFinite(hit.rankKey) && hit.rankSource));
  assert.ok(hits.every((hit, index) => index === 0 || hits[index - 1].rankKey >= hit.rankKey));
  assert.ok(hits.every((hit, index) => index === 0 || hits[index - 1].tier !== hit.tier || (hits[index - 1].score >= hit.score && hits[index - 1].rankKey >= hit.rankKey)));
  assert.equal(path.basename(hits[0].path), "current-state.md");
  const pure = await lib.search({ query: "记忆核心", limit: 3, graphExpand: false, rankWeights: { relevance: 1, recency: 0, importance: 0 } });
  assert.ok(pure.every((hit, index) => index === 0 || pure[index - 1].rankKey >= hit.rankKey));
  const relevanceOnly = pure.map((hit) => hit.path);
  const repeated = await lib.search({ query: "记忆核心", limit: 3, graphExpand: false, rankWeights: { relevance: 1, recency: 0, importance: 0 } });
  assert.deepEqual(repeated.map((hit) => hit.path), relevanceOnly);
});

test("D9.2 canonical state outranks a fresher ordinary file regardless of score", async () => {
  const dataRoot = path.join(root, "d9-canonical");
  const canonical = path.join(dataRoot, "project-state", "memory-lib", "current-state.md");
  const fresh = path.join(dataRoot, "curated", "shared", "fresh.md");
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.mkdir(path.dirname(fresh), { recursive: true });
  await fs.writeFile(canonical, "---\nid: memory-lib-current\nkind: current-state\nstatus: active\nupdated_at: 2020-01-01T00:00:00Z\n---\n\n记忆核心规范状态。\n");
  await fs.writeFile(fresh, `---\nid: fresh\nstatus: active\nimportance: critical\nupdated_at: ${new Date().toISOString()}\n---\n\n记忆核心 记忆核心 记忆核心 极新普通记录。\n`);
  const lib = createMemoryLib({ dataRoot, workspaceRoot: root, scopes: null });
  const hits = await lib.search({ query: "记忆核心", limit: 5, graphExpand: false });
  assert.equal(hits[0]?.path, canonical);
  assert.equal(hits[0]?.rankSource, "canonical");
  const freshHit = hits.find((hit) => hit.path === fresh);
  assert.ok(hits[0]?.tier < freshHit?.tier);
  assert.ok(hits[0]?.score < freshHit?.score, "score remains relevance even when tier policy wins");
  assert.ok(hits[0]?.rankKey > freshHit?.rankKey, "rankKey exposes the actual tier-aware order");
});

test("D9.3 lexical token coverage leads same-tier composite ranking", async () => {
  const dataRoot = path.join(root, "d9-lexical");
  const shared = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(shared, { recursive: true });
  const target = path.join(shared, "target.md");
  await fs.writeFile(target, "---\nid: target\nstatus: active\nimportance: ordinary\nupdated_at: 2020-01-01T00:00:00Z\n---\n\n解析器能够接受单对象，避免格式不匹配。\n");
  for (let index = 0; index < 4; index++) {
    await fs.writeFile(path.join(shared, `competitor-${index}.md`), `---\nid: competitor-${index}\nstatus: active\nimportance: critical\nupdated_at: ${new Date().toISOString()}\n---\n\n无关但新近的重要记录 ${index}。\n`);
  }
  const lib = createMemoryLib({ dataRoot, workspaceRoot: root, scopes: null });
  const hits = await lib.search({ query: "解析器 单对象 格式不匹配", limit: 5, graphExpand: false });
  assert.ok(hits.slice(0, 3).some((hit) => hit.path === target));
  const targetHit = hits.find((hit) => hit.path === target);
  assert.equal(targetHit?.rankSource, "lexical");
  assert.ok(targetHit?.scoreParts?.matchedTokens > 0);
  assert.ok(targetHit?.scoreParts?.tokenCoverage > 0);
  assert.equal(targetHit?.scoreParts?.freshFile, 0);
});
