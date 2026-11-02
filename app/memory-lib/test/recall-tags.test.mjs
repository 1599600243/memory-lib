import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRecall } from "../src/recall.mjs";

const PRINCIPAL = {
  tenant_id: "default", framework_id: "f", agent_id: "qq-bot", role_id: "chat-reader",
  group_id: "home-circle", user_id: "u-owner",
};

function memory(id, tags, body) {
  return [
    "---",
    `id: "${id}"`,
    'layer: "long-term"',
    'container: "long-term"',
    'visibility: "user"',
    'status: "active"',
    `tags: ${JSON.stringify(tags)}`,
    'group_id: "home-circle"',
    'user_id: "u-owner"',
    'tenant_id: "default"',
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function fixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recall-tags-"));
  const dir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "a.md"), memory("ev-a", ["place:group:111", "speaker:甲", "audience:group"], "在群 111，甲说要买菜。"), "utf8");
  await fs.writeFile(path.join(dir, "b.md"), memory("ev-b", ["place:group:222", "speaker:乙", "audience:group"], "在群 222，乙说要买米。"), "utf8");
  await fs.writeFile(path.join(dir, "c.md"), memory("ev-c", ["place:group:111", "speaker:丙", "audience:group"], "在群 111，丙说要买油。"), "utf8");
  return { dataRoot };
}

async function brief(dataRoot, extra = {}) {
  const recall = createRecall({ dataRoot, workspaceRoot: dataRoot });
  return recall.recallBrief({ principal: PRINCIPAL, format: "prompt", memory_only: true, query: "要买", memories: 5, memory_limit_chars: 600, ...extra });
}

test("brief returns tags in included receipts", async () => {
  const { dataRoot } = await fixture();
  const result = await brief(dataRoot);
  assert.ok(result.included.length >= 1, JSON.stringify(result.included));
  for (const row of result.included) assert.ok(Array.isArray(row.tags), `missing tags on ${row.id}`);
});

test("brief filters by a single tag", async () => {
  const { dataRoot } = await fixture();
  const result = await brief(dataRoot, { tags: ["place:group:111"] });
  const ids = result.included.map((row) => row.id).sort();
  assert.deepEqual(ids, ["ev-a", "ev-c"], JSON.stringify(ids));
  for (const row of result.included) assert.ok(row.tags.includes("place:group:111"));
});

test("brief tag filter uses AND semantics", async () => {
  const { dataRoot } = await fixture();
  const result = await brief(dataRoot, { tags: ["place:group:111", "speaker:丙"] });
  assert.deepEqual(result.included.map((row) => row.id), ["ev-c"], JSON.stringify(result.included));
  const empty = await brief(dataRoot, { tags: ["place:group:222", "speaker:丙"] });
  assert.equal(empty.included.length, 0, JSON.stringify(empty.included));
});
