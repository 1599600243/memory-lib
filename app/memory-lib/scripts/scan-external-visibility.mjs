import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { externalSourcesOf } from "../src/external-source-guard.mjs";

const defaultDataRoot = "D:\\MemoryLib\\data\\memory";
const args = process.argv.slice(2);
const rootArg = args.indexOf("--data-root");
const dataRoot = path.resolve(rootArg >= 0 ? args[rootArg + 1] : defaultDataRoot);
if (rootArg >= 0 && (!args[rootArg + 1] || args[rootArg + 1].startsWith("--"))) {
  throw new Error("--data-root requires a path");
}

async function collectMarkdown(directory, output = []) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectMarkdown(fullPath, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(fullPath);
  }
  return output;
}

const roots = [path.join(dataRoot, "curated")];
for (const entry of await fs.readdir(dataRoot, { withFileTypes: true }).catch((error) => {
  if (error?.code === "ENOENT") return [];
  throw error;
})) {
  if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith("project-")) roots.push(path.join(dataRoot, entry.name));
}
const files = [];
for (const root of roots) await collectMarkdown(root, files);
const hits = [];
const mismatches = [];
for (const file of files) {
  let parsed;
  try { parsed = parseFrontmatterTyped(await fs.readFile(file, "utf8")); }
  catch (error) {
    console.warn(`skip unreadable file: ${file}: ${error.message}`);
    continue;
  }
  const frontmatter = parsed.frontmatter ?? {};
  // 目录按 **layer** 分（curated-shared → data/curated/shared），可见性是 frontmatter 的另一个维度：
  // 同一层里可以既有 shared 也有 user 可见性的记忆，所以「目录 shared 而 visibility=user」是**正常设计**，
  // 不是缺陷。这里统计它只是为了提醒：隔离只靠 frontmatter，按目录读文件的工具（备份/grep/脚本）会绕过它。
  const underSharedDir = path.relative(dataRoot, file).replace(/\\/g, "/").startsWith("curated/shared/");
  if (underSharedDir && frontmatter.visibility && frontmatter.visibility !== "shared") {
    mismatches.push({ file, id: frontmatter.id ?? null, visibility: frontmatter.visibility, user: frontmatter.user_id ?? null });
  }
  if (frontmatter.visibility !== "shared" && frontmatter.visibility !== "platform") continue;
  const refs = Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs : [];
  const sources = [...externalSourcesOf(refs)];
  if (!sources.length) continue;
  hits.push({ file, id: frontmatter.id ?? null, sources });
}
console.log(`scanned files: ${files.length}`);
console.log(`hits: ${hits.length}`);
for (const hit of hits) console.log(`${hit.file}\tid=${hit.id ?? "(missing)"}\tsources=${hit.sources.join(",")}`);
console.log(`curated/shared 层里可见性不是 shared 的文件（正常，仅作"按目录读会绕过隔离"的提醒）: ${mismatches.length}`);
const mismatchByVisibility = {};
for (const item of mismatches) mismatchByVisibility[item.visibility] = (mismatchByVisibility[item.visibility] ?? 0) + 1;
console.log(`  按 visibility 分布: ${JSON.stringify(mismatchByVisibility)}`);
for (const item of mismatches.slice(0, 10)) console.log(`  ${item.file}\tid=${item.id ?? "(missing)"}\tvisibility=${item.visibility}\tuser=${item.user ?? "—"}`);
