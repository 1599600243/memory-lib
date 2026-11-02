import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyProject, main, mergeRegistry, normalizeProjectKey } from "../scripts/project-graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "project-graph-test-"));
const registry = path.join(TMP, "registry.json");
const project = path.join(TMP, "project");
const graph = path.join(TMP, "graph.json");
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, "index.js"), "export const fixture = true;\n");
await fs.writeFile(path.join(project, "other.js"), "export const other = true;\n");
await fs.writeFile(graph, JSON.stringify({ nodes: [{ id: "a", source_file: "src/a.js" }, { id: "b", source_file: "src/b.js" }], edges: [{ from: "a", to: "b" }] }));
after(() => fs.rm(TMP, { recursive: true, force: true }));

async function invoke(args) {
  const oldCwd = process.cwd(), oldRegistry = process.env.PROJECT_GRAPH_REGISTRY;
  const logs = [], errors = [];
  const oldLog = console.log, oldError = console.error;
  process.chdir(project);
  process.env.PROJECT_GRAPH_REGISTRY = registry;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  try { return { code: await main(args), stdout: logs.join("\n"), stderr: errors.join("\n") }; }
  finally {
    console.log = oldLog; console.error = oldError; process.chdir(oldCwd);
    if (oldRegistry === undefined) delete process.env.PROJECT_GRAPH_REGISTRY; else process.env.PROJECT_GRAPH_REGISTRY = oldRegistry;
  }
}

test("normalizes Windows drive case and separators", () => {
  assert.equal(normalizeProjectKey("C:\\Work\\Repo"), "c:/Work/Repo");
  assert.equal(normalizeProjectKey("c:/Work/Repo"), "c:/Work/Repo");
});

test("classifies missing registration as NEW", async () => {
  assert.equal(await classifyProject(null, { head: "abc", graphExists: false, files: 1 }), "NEW");
});

test("classifies matching head, graph, and file count as EXISTING", async () => {
  const state = await classifyProject({ last_head: "abc", files: 100 }, { head: "abc", graphExists: true, files: 100 });
  assert.equal(state, "EXISTING");
});

test("missing graph is STALE, but head drift alone is not", async () => {
  assert.equal(await classifyProject({ last_head: "same", files: 10 }, { head: "same", graphExists: false, files: 10 }), "STALE");
  // 只提交/合并、代码文件没有重写 ⇒ 图仍然有效
  assert.equal(await classifyProject({ last_head: "old", files: 10 }, { head: "new", graphExists: true, files: 10 }), "EXISTING");
});

test("classifies file count drift greater than five percent as STALE", async () => {
  assert.equal(await classifyProject({ last_head: "same", files: 100 }, { head: "same", graphExists: true, files: 106 }), "STALE");
});

test("classifies code newer than last build as STALE (uncommitted edits)", async () => {
  const builtAt = "2026-01-01T00:00:00.000Z";
  const state = await classifyProject(
    { last_head: "same", files: 100, last_built_at: builtAt },
    { head: "same", graphExists: true, files: 100, newestMtime: Date.parse("2026-01-02T00:00:00.000Z") },
  );
  assert.equal(state, "STALE");
});

test("merges entries by normalized key without dropping existing projects", () => {
  const merged = mergeRegistry({ projects: { old: { key: "old" } } }, { key: "new", graph: "graph.json" });
  assert.deepEqual(Object.keys(merged.projects), ["old", "new"]);
});

test("status --json emits machine-readable state fields and NEW exit code", async () => {
  const result = await invoke(["status", "--json", "--path", project]);
  assert.equal(result.code, 10, result.stderr);
  const status = JSON.parse(result.stdout);
  for (const field of ["state", "key", "graph", "last_head"]) assert.ok(Object.hasOwn(status, field), `missing ${field}`);
  assert.equal(status.state, "NEW");
});

test("init --graph registers graph counts without Graphify, and duplicate init exits 12", async () => {
  const initialized = await invoke(["init", "--path", project, "--graph", graph, "--name", "Fixture"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const entry = JSON.parse(initialized.stdout);
  assert.equal(entry.nodes, 2);
  assert.equal(entry.edges, 1);
  assert.equal(entry.files, 2);
  const duplicate = await invoke(["init", "--path", project, "--graph", graph]);
  assert.equal(duplicate.code, 12);
  assert.match(duplicate.stderr, /请改用 update/u);
  const status = await invoke(["status", "--json", "--path", project]);
  assert.equal(status.code, 0, `${status.stdout} ${status.stderr}`);
  assert.equal(JSON.parse(status.stdout).state, "EXISTING");
});
