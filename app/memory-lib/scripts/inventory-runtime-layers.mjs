import fs from "node:fs/promises";
import path from "node:path";

const dataRoot = process.argv[2] || "D:\\MemoryLib\\data\\memory";
const runtimeRoot = path.join(dataRoot, "runtime");
const retrievalRoots = [
  "curated/shared",
  "curated/agents",
  "project-state",
  "tools-memory",
  "plans",
  "profile",
  "evidence/documents",
];

async function walk(root) {
  const result = [];
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(full);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function relative(file) {
  return path.relative(dataRoot, file).split(path.sep).join("/");
}
function layerOf(text) {
  const match = text.match(/^layer:\s*["']?([^\r\n"']+?)["']?\s*$/mu);
  return match ? match[1].trim() : "无";
}
function disposition(rel, layer) {
  if (rel.startsWith("runtime/episode-regen-backup/")) return { decision: "保留", reason: "episode regeneration backup；runtime 不在索引/检索根内" };
  if (rel.startsWith("runtime/acceptance-probe-")) return { decision: "保留", reason: "acceptance/probe 证据；runtime 不在索引/检索根内" };
  if (rel.startsWith("runtime/purged-")) return { decision: "归档/删除（另单）", reason: "已 purge 的 legacy runtime 资料；本轮只读，不执行处置" };
  if (layer === "无") return { decision: "保留（待 owner 决策）", reason: "没有 layer frontmatter；runtime 排除，不能仅凭路径删除" };
  return { decision: "保留（待 owner 决策）", reason: "legacy runtime artifact；runtime 排除，不能仅凭 layer 删除" };
}

const files = await walk(runtimeRoot);
const rows = [];
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  const rel = relative(file);
  const layer = layerOf(text);
  const inRetrievalRoots = retrievalRoots.some((root) => rel === root || rel.startsWith(`${root}/`));
  const choice = disposition(rel, layer);
  rows.push({ path: rel, bytes: Buffer.byteLength(text), layer, inRetrievalRoots, ...choice });
}
const distribution = {};
for (const row of rows) distribution[row.layer] = (distribution[row.layer] ?? 0) + 1;
console.log(JSON.stringify({ dataRoot, runtimeRoot, retrievalRoots, count: rows.length, distribution, rows }, null, 2));
