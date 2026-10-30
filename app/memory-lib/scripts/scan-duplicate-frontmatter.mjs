#!/usr/bin/env node
import path from "node:path";
import { scanDuplicateFrontmatter } from "../src/duplicate-frontmatter.mjs";

const root = path.resolve(process.argv[2] ?? process.env.MEMORY_DATA_ROOT ?? "data");
const findings = await scanDuplicateFrontmatter(root);
if (!findings.length) {
  console.log(`No duplicate frontmatter keys found under ${root}`);
  process.exit(0);
}
console.log(JSON.stringify({ root, count: findings.length, findings }, null, 2));
process.exitCode = 1;
