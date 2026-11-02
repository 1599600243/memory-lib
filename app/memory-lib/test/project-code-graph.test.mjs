import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractCodeRefs, pickEntry, resolveCodeRefs, scanCode, summarizeCodeGraph } from "../src/project-code-graph.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-"));
  const codeDir = path.join(root, "repo");
  await fs.mkdir(path.join(codeDir, "src"), { recursive: true });
  await fs.writeFile(path.join(codeDir, "src", "a.mjs"), "export const a = 1;\n");
  await fs.writeFile(path.join(codeDir, "src", "b.mjs"), "export const b = 2;\n");
  await fs.mkdir(path.join(codeDir, "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(codeDir, "node_modules", "x", "index.js"), "ignored\n");
  const graph = path.join(root, "graph.json");
  await fs.writeFile(graph, JSON.stringify({ nodes: [{ id: "a" }], edges: [] }));
  const registry = path.join(root, "registry.json");
  await fs.writeFile(registry, JSON.stringify({
    version: 1,
    projects: {
      "d:/repo": {
        key: "d:/repo", name: "repo", project: "memory-lib", path: codeDir, graph,
        last_head: "abc", last_built_at: new Date().toISOString(), files: 2, nodes: 1, edges: 0,
      },
    },
  }));
  return { root, codeDir, graph, registry };
}

test("scanCode ignores node_modules and counts code files", async () => {
  const { codeDir } = await fixture();
  const scanned = await scanCode(codeDir);
  assert.equal(scanned.files, 2);
  assert.ok(scanned.newestMtime > 0);
});

test("pickEntry matches by memory project name", async () => {
  const { registry } = await fixture();
  const parsed = JSON.parse(await fs.readFile(registry, "utf8"));
  assert.equal(pickEntry(parsed, "memory-lib")?.project, "memory-lib");
  assert.equal(pickEntry(parsed, "nope"), null);
});

test("summarize reports EXISTING for fresh graph", async () => {
  const { registry } = await fixture();
  const summary = await summarizeCodeGraph({ registryPath: registry, project: "memory-lib" });
  assert.equal(summary.registered, true);
  assert.equal(summary.state, "EXISTING");
  assert.equal(summary.nodes, 1);
  assert.equal(summary.files, 2);
});

test("summarize reports STALE when code is newer than the graph", async () => {
  const { registry, codeDir } = await fixture();
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(codeDir, "src", "a.mjs"), future, future);
  const summary = await summarizeCodeGraph({ registryPath: registry, project: "memory-lib" });
  assert.equal(summary.state, "STALE");
  assert.ok(summary.stale_reasons.some((reason) => reason.includes("代码比图新")));
});

test("summarize reports unregistered project without touching files", async () => {
  const { registry } = await fixture();
  const summary = await summarizeCodeGraph({ registryPath: registry, project: "other" });
  assert.deepEqual(summary, { registered: false });
});

test("extractCodeRefs finds files and call-like symbols without truncating .json", () => {
  const refs = extractCodeRefs("见 src/visibility.mjs 的 canSeePath()，登记表在 memory-lib/var/project-graphs.json");
  assert.deepEqual(refs.files.sort(), ["memory-lib/var/project-graphs.json", "src/visibility.mjs"]);
  assert.ok(refs.symbols.includes("canSeePath"));
});

test("resolveCodeRefs maps mentions onto graph nodes with file and line", async () => {
  const { root } = await fixture();
  const graph = path.join(root, "graph2.json");
  await fs.writeFile(graph, JSON.stringify({
    nodes: [
      { id: "n1", label: "canSeePath()", source_file: "src/visibility.mjs", loc: "L34" },
      { id: "n2", label: "summarizeCodeGraph()", source_file: "src/project-code-graph.mjs", loc: "L70" },
    ],
    edges: [],
  }));
  const refs = await resolveCodeRefs({
    graphPath: graph,
    texts: ["改动 src/visibility.mjs 里的 canSeePath()，同时看 summarizeCodeGraph"], 
  });
  const file = refs.find((ref) => ref.type === "file" && ref.value === "visibility.mjs");
  const symbol = refs.find((ref) => ref.type === "symbol" && ref.value === "canSeePath");
  assert.ok(file, JSON.stringify(refs));
  assert.equal(file.line, 34);
  assert.ok(symbol, JSON.stringify(refs));
  assert.equal(symbol.file, "src/visibility.mjs");
});

test("resolveCodeRefs drops references that are not in the graph", async () => {
  const { root } = await fixture();
  const graph = path.join(root, "graph3.json");
  await fs.writeFile(graph, JSON.stringify({ nodes: [{ id: "n1", label: "known()", source_file: "src/known.mjs" }], edges: [] }));
  const refs = await resolveCodeRefs({ graphPath: graph, texts: ["提到 src/unknown.mjs 和 missingSymbol()"] });
  assert.deepEqual(refs, []);
});
