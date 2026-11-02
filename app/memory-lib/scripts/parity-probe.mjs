// memory-lib Slice 1 — parity probe: compare memory-lib search vs the LIVE plugin
// (~\.openclaw\workspace\openclaw-memory) on the same fixture.
// Run: node --experimental-strip-types scripts/parity-probe.mjs
//
// This is the strongest "behavior identical" check: we execute the plugin's own
// createMemoryService (it has zero openclaw imports) with a fake api object and
// compare its file-first search results with memory-lib (scopes=null parity mode).
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_WORKSPACE = path.join(here, "..", "test", "fixtures", "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");

const PLUGIN_SRC = "C:\\Users\\admin\\.openclaw\\workspace\\openclaw-memory\\src";
const QUERIES = ["原则", "主智能体", "共享事实", "记忆", "管家"];

// Replicate the plugin scripts' trick: copy TS sources to a temp dir and rewrite
// relative ".js" import specifiers to ".ts" so node --experimental-strip-types
// can load service.ts directly (it has zero openclaw imports).
async function copyPluginSrcForDirectImport() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-parity-"));
  await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  // junction the plugin's node_modules so unified/remark-parse resolve
  const pluginNodeModules = path.join(PLUGIN_SRC, "..", "node_modules");
  try {
    await fs.symlink(pluginNodeModules, path.join(tempRoot, "node_modules"), "junction");
  } catch {
    /* symlink may fail; unified/remark-parse will fail loudly below if needed */
  }
  async function copyDir(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) await copyDir(source, target);
      else {
        let content = await fs.readFile(source, "utf8");
        content = content.replace(/(["'])(\.\.?\/[^"']*)\.js\1/g, "$1$2.ts$1");
        await fs.writeFile(target, content, "utf8");
      }
    }
  }
  await copyDir(PLUGIN_SRC, path.join(tempRoot, "src"));
  return tempRoot;
}

const lib = createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes: null });

const tempRoot = await copyPluginSrcForDirectImport();
const { createMemoryService } = await import(pathToFileURL(path.join(tempRoot, "src", "service.ts")).href);
const pluginService = createMemoryService({
  pluginConfig: { dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, backend: "file-first" },
  runtime: {},
});

function normalize(results) {
  return results.map((r) => ({
    rel: path.relative(FIXTURE_WORKSPACE, r.path).replace(/\\/g, "/"),
    line: r.line,
    sourceType: r.sourceType,
  })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
}

let failed = 0;
for (const q of QUERIES) {
  const pluginResults = await pluginService.search(q, undefined, 50);
  const libResults = await lib.search({ query: q, limit: 50 });
  const a = normalize(pluginResults);
  const b = normalize(libResults);
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${same ? "MATCH" : "DIFF "} query="${q}"  plugin=${a.length} lib=${b.length}`);
  if (!same) {
    failed++;
    console.log("  plugin:", JSON.stringify(a, null, 2));
    console.log("  lib   :", JSON.stringify(b, null, 2));
  }
}

console.log(failed === 0 ? "PARITY_OK" : `PARITY_FAILED (${failed}/${QUERIES.length})`);
process.exit(failed === 0 ? 0 : 1);
