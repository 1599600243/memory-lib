import fs from "node:fs/promises";
import path from "node:path";

async function markdownFiles(root) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await markdownFiles(filePath));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") out.push(filePath);
  }
  return out;
}

export async function scanDuplicateFrontmatter(root) {
  const findings = [];
  for (const filePath of (await markdownFiles(root)).sort()) {
    const text = await fs.readFile(filePath, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    if (!match) continue;
    const counts = new Map();
    for (const line of match[1].split(/\r?\n/u)) {
      const index = line.indexOf(":");
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
    if (keys.length) findings.push({ path: filePath, keys });
  }
  return findings;
}
