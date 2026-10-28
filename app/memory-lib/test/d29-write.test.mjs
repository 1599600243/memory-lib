import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createToolsMemory } from "../src/tools-memory.mjs";

test("quoted frontmatter ids are readable by bare and quoted public ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-d29-id-"));
  await fs.mkdir(path.join(root, "curated", "shared"), { recursive: true });
  await fs.writeFile(path.join(root, "curated", "shared", "quoted.md"), "---\nid: \"project-memory-lib-state\"\nstatus: active\n---\n\nquoted\n", "utf8");
  await fs.mkdir(path.join(root, "tools-memory"), { recursive: true });
  await fs.writeFile(path.join(root, "tools-memory", "tool-dbx.md"), "---\nid: \"tool-dbx\"\nlayer: tool\n---\n\nquoted tool\n", "utf8");
  const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null });
  for (const id of ["project-memory-lib-state", "\"project-memory-lib-state\""]) assert.equal((await lib.get(id)).id, "project-memory-lib-state");
  assert.equal((await createToolsMemory({ dataRoot: root }).getTool("tool-dbx")).id, "tool-dbx");
  assert.equal((await createToolsMemory({ dataRoot: root }).getTool("\"tool-dbx\"")).id, "tool-dbx");
  assert.equal((await lib.listMemories({ limit: 50 })).find((item) => item.id === "project-memory-lib-state").id, "project-memory-lib-state");
});

test("unified writer writes curated shared and overwrites same id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-d29-"));
  const writer = createMemoryWriter({ dataRoot: root });
  const first = await writer.write({ layer: "curated-shared", id: "x", body: "one", evidence_refs: ["e1"] });
  const second = await writer.write({ layer: "curated-shared", id: "x", body: "two", evidence_refs: ["e1"] });
  assert.equal(first.created, true);
  assert.equal(second.updated, true);
  assert.match(await fs.readFile(second.path, "utf8"), /two/);
});

test("progress keeps defaults and deduplicates date/text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-d29-"));
  const writer = createMemoryWriter({ dataRoot: root });
  const input = { layer: "project-progress", project: "demo", evidence_refs: ["e1"], entries: [{ topic: "进展", at: "2026-10-04", text: "完成写入" }] };
  const first = await writer.writeProgress(input);
  const second = await writer.writeProgress(input);
  assert.equal(first.added, 1);
  assert.equal(second.deduped, 1);
  const text = await fs.readFile(first.path, "utf8");
  assert.match(text, /## 目标与范围/);
  assert.equal((text.match(/完成写入/g) ?? []).length, 1);
});

test("project decisions never overwrite an existing decision id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-d29-"));
  const writer = createMemoryWriter({ dataRoot: root });
  const input = { layer: "project-decision", project: "demo", id: "same", body: "first", evidence_refs: ["e1"] };
  const first = await writer.write(input);
  const second = await writer.write({ ...input, body: "second", evidence_refs: ["e2"] });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.path, second.path);
  assert.match(await fs.readFile(first.path, "utf8"), /first/);
  assert.match(await fs.readFile(second.path, "utf8"), /second/);
});

test("progress duplicate merges refs and concurrent writes retain both entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-d29-"));
  const writer = createMemoryWriter({ dataRoot: root });
  const pathResult = await Promise.all([
    writer.writeProgress({ layer: "project-progress", project: "demo", evidence_refs: ["e1"], entries: [{ topic: "进展", at: "2026-10-04", text: "同一事项", refs: ["r1"] }] }),
    writer.writeProgress({ layer: "project-progress", project: "demo", evidence_refs: ["e2"], entries: [{ topic: "进展", at: "2026-10-05", text: "另一事项", refs: ["r2"] }] }),
  ]);
  const text = await fs.readFile(pathResult[0].path, "utf8");
  assert.match(text, /2026-10-04 · 同一事项/);
  assert.match(text, /2026-10-05 · 另一事项/);
  await writer.writeProgress({ layer: "project-progress", project: "demo", evidence_refs: ["e3"], entries: [{ topic: "进展", at: "2026-10-04", text: "同一事项", refs: ["r3"] }] });
  const merged = await fs.readFile(pathResult[0].path, "utf8");
  assert.match(merged, /r1/);
  assert.match(merged, /r3/);
});
