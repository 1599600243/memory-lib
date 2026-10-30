// vector 生产启用验收 —— 用生产 ledger 副本 + 真实 Ollama 跑 hybrid 检索（只读副本，不碰生产）
// Run: node --experimental-strip-types scripts/hybrid-probe.mjs
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const PLUGIN_SRC = "C:\\Users\\admin\\.openclaw\\workspace\\openclaw-memory\\src";
const PROD_LEDGER = "I:\\OpenClaw\\memory-data\\memory\\indexes\\sqlite\\openclaw-memory-ledger.sqlite";

// 1) copy plugin src to temp (js->ts rewrite)
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-hybrid-"));
await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");
try { await fs.symlink(path.join(PLUGIN_SRC, "..", "node_modules"), path.join(tempRoot, "node_modules"), "junction"); } catch {}
async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const t = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(s, t);
    else { let c = await fs.readFile(s, "utf8"); c = c.replace(/(["'])(\.\.?\/[^"']*)\.js\1/g, "$1$2.ts$1"); await fs.writeFile(t, c, "utf8"); }
  }
}
await copyDir(PLUGIN_SRC, path.join(tempRoot, "src"));

// 2) build temp data root with production ledger COPY
const dataRoot = path.join(tempRoot, "data", "memory");
await fs.mkdir(path.join(dataRoot, "indexes", "sqlite"), { recursive: true });
await fs.copyFile(PROD_LEDGER, path.join(dataRoot, "indexes", "sqlite", "openclaw-memory-ledger.sqlite"));

// 3) fake api with vector enabled (real Ollama)
const { createMemoryService } = await import(pathToFileURL(path.join(tempRoot, "src", "service.ts")).href);
const service = createMemoryService({
  pluginConfig: {
    dataRoot,
    workspaceRoot: path.join(tempRoot, "data"),
    backend: "ledger-first",
    vector: { enabled: true, endpoint: "http://127.0.0.1:11434", model: "nomic-embed-text", dimension: 768, timeoutMs: 15000 },
  },
  runtime: {},
});

// 4) run hybrid + fts searches
for (const q of ["记忆库", "memory core", "审批"]) {
  const hybrid = await service.searchLedger({ query: q, limit: 5, mode: "hybrid" });
  const fts = await service.searchLedger({ query: q, limit: 5, mode: "fts" });
  const diag = hybrid.diagnostics ?? hybrid.warnings ?? {};
  const lanes = diag.lanes ?? {};
  console.log(`query="${q}"`);
  console.log(`  hybrid: ok=${hybrid.ok} candidates=${hybrid.candidates?.length ?? "?"} lanes=${JSON.stringify(lanes)}`);
  console.log(`  fts   : ok=${fts.ok} candidates=${fts.candidates?.length ?? "?"}`);
}

// cleanup
await fs.rm(tempRoot, { recursive: true, force: true });
console.log("HYBRID_PROBE_DONE");
