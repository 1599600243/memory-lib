import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listKnowledgeDocuments } from "../src/knowledge-list.mjs";

async function fixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-list-"));
  const dir = path.join(dataRoot, "evidence", "documents");
  await fs.mkdir(path.join(dir, "nested"), { recursive: true });
  await fs.writeFile(path.join(dir, "a.md"), "---\nid: \"doc-a\"\ntitle: \"甲文档\"\ntype: \"document\"\nupdated_at: \"2026-01-02T00:00:00Z\"\n---\n正文\n");
  await fs.writeFile(path.join(dir, "nested", "b.md"), "# 乙文档标题\n\n无 frontmatter 的正文\n");
  return { dataRoot };
}

test("lists documents from evidence/documents including nested dirs", async () => {
  const { dataRoot } = await fixture();
  const result = await listKnowledgeDocuments({ dataRoot });
  assert.equal(result.count, 2);
  const ids = result.items.map((item) => item.id).sort();
  assert.deepEqual(ids, ["b", "doc-a"]);
});

test("uses frontmatter title, falls back to first heading", async () => {
  const { dataRoot } = await fixture();
  const result = await listKnowledgeDocuments({ dataRoot });
  const a = result.items.find((item) => item.id === "doc-a");
  const b = result.items.find((item) => item.id === "b");
  assert.equal(a.title, "甲文档");
  assert.equal(b.title, "乙文档标题");
  assert.equal(a.path, "evidence/documents/a.md");
});

test("empty directory yields zero documents", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-empty-"));
  const result = await listKnowledgeDocuments({ dataRoot });
  assert.equal(result.count, 0);
  assert.deepEqual(result.items, []);
});
