import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles, readTextFile, parseFrontmatter } from "./read-only-core.mjs";

const REFINED_DIRS = ["curated", "project-state", "tools-memory", "plans", "profile"];
const RAW_DIRS = ["episodes", "evidence"];

async function countActive(root) {
  let count = 0;
  for (const filePath of await walkFiles(root)) {
    const normalized = filePath.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => part.startsWith("_"))) continue;
    const text = await readTextFile(filePath);
    if (!text) continue;
    const { frontmatter } = parseFrontmatter(text);
    const status = String(frontmatter.status ?? "active").replace(/^['"]|['"]$/gu, "").toLowerCase();
    if (["active", "promoted", "confirmed", "done"].includes(status)) count += 1;
  }
  return count;
}

export async function buildCapacityReport(dataRoot) {
  let refined = 0;
  let raw = 0;
  for (const dir of REFINED_DIRS) refined += await countActive(path.join(dataRoot, dir));
  for (const dir of RAW_DIRS) raw += await countActive(path.join(dataRoot, dir));
  return {
    refined,
    raw,
    refinedToRawRatio: raw ? Number((refined / raw).toFixed(4)) : null,
  };
}
