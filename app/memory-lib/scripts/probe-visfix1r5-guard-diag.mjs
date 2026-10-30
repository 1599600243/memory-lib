// 一次性诊断：打印守卫实际扫到的调用点分布（只读，不改变任何东西）。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGuard } from "../test/identity-required-call-sites.test.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(ROOT, "..");
const dirs = ["memory-lib/src", "memory-lib/mcp", "memory-lib/scripts"];
async function collect(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collect(p, out);
    else if (e.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}
const files = [];
for (const d of dirs) for (const p of await collect(path.join(REPO, d))) files.push({ path: path.relative(REPO, p).split(path.sep).join("/"), text: await fs.readFile(p, "utf8") });
const { violations, sites, allowedByRule } = runGuard({ files });
console.log("sites:", sites.length);
for (const s of sites) console.log(`${s.passed ? "PASS" : s.allowed ? "ALLOW" : "VIOL "} ${s.id} ${s.path}:${s.line} ${s.viaArgs ? "args" : ""}${s.viaBuilder ? "builder" : ""} :: ${s.args}`);
console.log("violations:", violations.length);
console.log("allowedByRule:", JSON.stringify([...allowedByRule]));
