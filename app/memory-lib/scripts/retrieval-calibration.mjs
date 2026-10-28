import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";

async function markdownFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(file);
    }
  }
  await walk(root);
  return out;
}

function bodyFragments(body) {
  return String(body).split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20 && !line.startsWith("#"));
}

async function chooseSelfCalibratingFile(dataRoot, lib) {
  const durableRoot = path.join(dataRoot, "curated", "shared");
  const files = await markdownFiles(durableRoot);
  const records = await Promise.all(files.map(async (file) => {
    const text = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatterTyped(text);
    const id = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()
      ? parsed.frontmatter.id.trim()
      : path.basename(file, ".md");
    return { file, id, body: parsed.body };
  }));
  const bodyCorpus = records.map((record) => ({ file: record.file, body: record.body }));
  const rejected = [];
  for (const record of records) {
    const idHits = await lib.search({ query: record.id, limit: 10, graphExpand: false });
    const idTop = idHits[0]?.path ?? null;
    if (path.resolve(idTop ?? "") !== path.resolve(record.file)) {
      rejected.push({ file: record.file, reason: "id did not rank top1", id: record.id, idTop });
      continue;
    }
    for (const fragment of bodyFragments(record.body)) {
      const occurrences = bodyCorpus.filter((candidate) => candidate.body.includes(fragment));
      if (occurrences.length !== 1 || occurrences[0].file !== record.file) continue;
      const fragmentHits = await lib.search({ query: fragment, limit: 10, graphExpand: false });
      const fragmentTop = fragmentHits[0]?.path ?? null;
      if (path.resolve(fragmentTop ?? "") === path.resolve(record.file)) {
        return { record, fragment, idHits, fragmentHits, rejected };
      }
      rejected.push({ file: record.file, reason: "unique fragment did not rank top1", fragment, fragmentTop });
    }
    rejected.push({ file: record.file, reason: "no unique body fragment of at least 20 characters" });
  }
  return { error: "could not construct self-calibrating durable record", rejected };
}

const dataRoot = process.argv[2];
if (!dataRoot) {
  console.error("usage: node scripts/retrieval-calibration.mjs <dataRoot> [workspaceRoot]");
  process.exit(2);
}
const workspaceRoot = process.argv[3] || path.dirname(dataRoot);
const lib = createMemoryLib({ dataRoot, workspaceRoot, scopes: null });
const selected = await chooseSelfCalibratingFile(dataRoot, lib);
const results = [
  { id: "random-marker-empty", query: "DSH_ACCEPTANCE_RANDOM_9f7b2e31c4", expect: { count: 0 } },
  { id: "random-ascii-token-empty", query: "zqxjkvmwq", expect: { count: 0 } },
  {
    id: "current-durable-id-top1",
    query: selected.record?.id ?? null,
    status: selected.record ? "pass" : "fail",
    count: selected.idHits?.length ?? 0,
    topPath: selected.idHits?.[0]?.path ?? null,
    derivedFrom: selected.record?.file ?? null,
    rejectedCandidates: selected.rejected ?? [],
  },
  {
    id: "current-durable-unique-fragment-top1",
    query: selected.fragment ?? null,
    status: selected.record ? "pass" : "fail",
    count: selected.fragmentHits?.length ?? 0,
    topPath: selected.fragmentHits?.[0]?.path ?? null,
    derivedFrom: selected.record?.file ?? null,
    uniqueBodyFragment: Boolean(selected.fragment),
    fragmentLength: selected.fragment?.length ?? 0,
  },
  { id: "graph-design-target", query: "图谱是可重建派生索引", status: "observe", count: 0, topPath: null, topLanes: [] },
];
for (const item of results) {
  if (item.status) continue;
  const hits = await lib.search({ query: item.query, limit: 10, graphExpand: false });
  item.status = item.expect.count === hits.length ? "pass" : "fail";
  item.count = hits.length;
  item.topPath = hits[0]?.path ?? null;
}
const failed = results.filter((item) => item.status === "fail");
const output = { ok: failed.length === 0, failed: failed.length, results };
if (selected.error) output.selectionError = selected.error;
console.log(JSON.stringify(output, null, 2));
if (failed.length) process.exit(1);
