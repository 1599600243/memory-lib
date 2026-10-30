#!/usr/bin/env node
// syntax-check.mjs —— 对仓库里所有 .mjs 跑 `node --check`（跨平台，不依赖 xargs）。
// 用法: node scripts/syntax-check.mjs

import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const skipDirs = new Set(["node_modules", ".git", "data", "logs", "indexes", "runtime", "dist", "target", ".github"]);

async function walk(dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      await walk(full, out);
    } else if (entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(repoRoot);
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    failed += 1;
    console.error(`\n✖ ${path.relative(repoRoot, file)}`);
    console.error(`${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(0, 6).join("\n"));
  }
}
console.log(`\n${failed === 0 ? "✅" : "❌"} syntax-check: ${files.length - failed}/${files.length} 个 .mjs 通过`);
process.exit(failed === 0 ? 0 : 1);
