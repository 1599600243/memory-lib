// R7 read-only graph-shape evidence and isolated graph builder.
// --mode=build writes only --out (never the configured production graph).
// --mode=metrics opens --graph read-only and never calls openGraph().
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATA_ROOT_DEFAULT = "I:\\OpenClaw\\memory-data\\memory";
const WORKSPACE_ROOT_DEFAULT = "I:\\OpenClaw\\memory-data";

function argValue(args, name, fallback = null) {
  const prefix = `${name}=`;
  const direct = args.find((value) => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function parseArgs(args) {
  return {
    mode: argValue(args, "--mode", "metrics"),
    preset: argValue(args, "--preset", "ticket3"),
    graph: argValue(args, "--graph"),
    out: argValue(args, "--out"),
    graphModule: argValue(args, "--graph-module"),
    dataRoot: path.resolve(argValue(args, "--data-root", DATA_ROOT_DEFAULT)),
    workspaceRoot: path.resolve(argValue(args, "--workspace-root", WORKSPACE_ROOT_DEFAULT)),
    label: argValue(args, "--label", null),
    json: argValue(args, "--json", null),
    before: argValue(args, "--before", null),
    after: argValue(args, "--after", null),
  };
}

function rootsFor(options) {
  const roots = [
    path.join(options.dataRoot, "curated"),
    path.join(options.workspaceRoot, "learning"),
    path.join(options.workspaceRoot, "knowledge", "approved"),
  ];
  if (options.preset === "server4") roots.push(path.join(options.dataRoot, "project-state"));
  if (options.preset !== "ticket3" && options.preset !== "server4") throw new Error(`unknown preset: ${options.preset}`);
  return roots;
}

function productionGraphPath(dataRoot) {
  return path.join(dataRoot, "indexes", "sqlite", "memory-graph.sqlite");
}

async function countFiles(roots) {
  let count = 0;
  async function walk(root) {
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && [".md", ".json"].includes(path.extname(entry.name).toLowerCase())) count += 1;
    }
  }
  for (const root of roots) await walk(root);
  return count;
}

function noiseLabel(label) {
  return /[`$(){}[\]<>|;=\\/]/u.test(String(label ?? "")) || String(label ?? "").includes("\n") || String(label ?? "").length > 40;
}

function sourceKind(file) {
  if (!file) return "stub";
  const ext = path.extname(file).toLowerCase();
  if (path.basename(file).toLowerCase() === "plan.json") return "plan_json";
  if (ext === ".md") return "md";
  if (ext === ".json") return "other_json";
  return "other";
}

function countBy(rows, key) {
  const result = {};
  for (const row of rows) result[row[key]] = (result[row[key]] ?? 0) + 1;
  return result;
}

function collectMetrics(db, options, graphBuild = null) {
  const nodes = db.prepare("SELECT id, type, label, file, meta FROM nodes").all();
  const edges = db.prepare("SELECT from_id, to_id, type, source FROM edges").all();
  const files = db.prepare("SELECT file_path, item_id FROM file_index").all();
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1);
    degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1);
  }
  const topics = nodes.filter((node) => node.type === "topic");
  const topicRows = topics.map((node) => {
    const taggedIn = edges.filter((edge) => edge.to_id === node.id && edge.type === "tagged").length;
    const mentionsIn = edges.filter((edge) => edge.to_id === node.id && edge.type === "mentions").length;
    return { ...node, taggedIn, mentionsIn, degree: degree.get(node.id) ?? 0 };
  });
  const topicReuse = new Map();
  for (const topic of topics) {
    const neighbors = new Set();
    for (const edge of edges) {
      if (edge.type !== "tagged" && edge.type !== "mentions") continue;
      if (edge.to_id !== topic.id && edge.from_id !== topic.id) continue;
      const otherId = edge.from_id === topic.id ? edge.to_id : edge.from_id;
      const other = nodes.find((node) => node.id === otherId);
      if (other && (other.type === "item" || other.type === "knowledge")) neighbors.add(other.id);
    }
    topicReuse.set(topic.id, neighbors.size);
  }
  const orphans = nodes.filter((node) => !degree.has(node.id));
  const learning = nodes.filter((node) => node.type === "learning_module");
  const learningZero = learning.filter((node) => !degree.has(node.id));
  const moduleIds = learning.filter((node) => String(node.id).startsWith("module:"));
  const moduleGroups = new Map();
  for (const node of moduleIds) {
    const key = node.id;
    if (!moduleGroups.has(key)) moduleGroups.set(key, []);
    moduleGroups.get(key).push(node);
  }
  const collisionGroups = files.reduce((map, row) => {
    if (!map.has(row.item_id)) map.set(row.item_id, []);
    map.get(row.item_id).push(row.file_path);
    return map;
  }, new Map());
  const collisions = [...collisionGroups.entries()].filter(([, paths]) => paths.length > 1).map(([itemId, paths]) => ({ itemId, paths }));
  const danglingFrom = edges.filter((edge) => !nodes.some((node) => node.id === edge.from_id)).length;
  const danglingTo = edges.filter((edge) => !nodes.some((node) => node.id === edge.to_id)).length;
  const selfEdges = edges.filter((edge) => edge.from_id === edge.to_id).length;
  const byDegree = countBy(topicRows.map((row) => ({ degree: row.degree })), "degree");
  const reused = [...topicReuse.values()].filter((value) => value >= 2).length;
  const singletons = [...topicReuse.values()].filter((value) => value === 1).length;
  const isolated = [...topicReuse.values()].filter((value) => value === 0).length;
  const metaTopics = new Map();
  for (const node of moduleIds) {
    let topic = "";
    try { topic = JSON.parse(node.meta ?? "{}").topic ?? ""; } catch { /* ignore malformed derived metadata */ }
    const key = `${node.file ?? "<stub>"}|${topic}`;
    metaTopics.set(node.id, (metaTopics.get(node.id) ?? new Set()).add(key));
  }
  return {
    generatedAt: new Date().toISOString(),
    label: options.label,
    mode: "metrics",
    graphPath: options.graph,
    roots: { preset: options.preset, paths: rootsFor(options), filesScanned: options.filesScanned ?? null },
    graphBuild,
    totals: { nodes: nodes.length, edges: edges.length, fileIndex: files.length, byNodeType: countBy(nodes, "type"), byEdgeType: countBy(edges, "type") },
    topics: {
      total: topics.length,
      tagBacked: topicRows.filter((row) => row.taggedIn > 0).length,
      mentionsOnly: topicRows.filter((row) => row.taggedIn === 0 && row.mentionsIn > 0).length,
      noiseMentions: topicRows.filter((row) => row.taggedIn === 0 && row.mentionsIn > 0 && noiseLabel(row.label)).length,
      isolated: topicRows.filter((row) => row.degree === 0).length,
      singleton: topicRows.filter((row) => row.degree <= 1).length,
      slugTruncated: topics.filter((row) => /-[0-9a-f]{8}$/i.test(row.id)).length,
      reused,
      singletons,
      maxReuse: Math.max(0, ...topicReuse.values()),
      byDegree,
    },
    learningModules: {
      total: learning.length,
      degreeZeroAll: learningZero.length,
      degreeZeroByKind: countBy(learningZero.map((node) => ({ kind: sourceKind(node.file) })), "kind"),
      bySourceKind: countBy(learning.map((node) => ({ kind: sourceKind(node.file) })), "kind"),
      mentionsOnlyConnectivity: learning.filter((node) => (degree.get(node.id) ?? 0) > 0 && edges.filter((edge) => edge.from_id === node.id || edge.to_id === node.id).every((edge) => edge.type === "mentions")).length,
      fileNull: learning.filter((node) => !node.file).length,
    },
    moduleIdentity: { ids: moduleIds.length, colliding: [...moduleGroups.entries()].filter(([, rows]) => rows.length > 1).map(([id]) => id), metadataCollisions: [...metaTopics.entries()].filter(([, values]) => values.size > 1).map(([id]) => id) },
    idCollisions: { groups: collisions.length, learningGroups: collisions.filter(({ itemId }) => itemId.startsWith("learning_module:")).length, details: collisions },
    danglingEdges: { from: danglingFrom, to: danglingTo },
    selfEdges,
    orphans: { total: orphans.length, byType: countBy(orphans, "type") },
    integrity: { danglingEdges: danglingFrom + danglingTo, selfEdges, unresolvedMentions: edges.filter((edge) => edge.type === "mentions" && !nodes.some((node) => node.id === edge.to_id)).length },
    productionDataWritten: false,
  };
}

function flatten(value, prefix = "") {
  const result = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) Object.assign(result, flatten(child, prefix ? `${prefix}.${key}` : key));
  } else if (typeof value === "number") result[prefix] = value;
  return result;
}

function diffReports(before, after) {
  const left = flatten(before);
  const right = flatten(after);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const diff = {};
  for (const key of keys) {
    if (left[key] !== undefined || right[key] !== undefined) diff[key] = { before: left[key] ?? 0, after: right[key] ?? 0, delta: (right[key] ?? 0) - (left[key] ?? 0) };
  }
  return { before: before.label, after: after.label, diff, verdict: { topicsMovedDown: after.topics.total < before.topics.total, noiseMentionsZero: after.topics.noiseMentions === 0, moduleCollisionsGone: after.moduleIdentity.colliding.length === 0, learningIdCollisionsGone: after.idCollisions.learningGroups === 0 } };
}

export async function runMetrics(options) {
  if (options.mode === "diff") return diffReports(JSON.parse(await fs.readFile(options.before, "utf8")), JSON.parse(await fs.readFile(options.after, "utf8")));
  const roots = rootsFor(options);
  options.filesScanned = await countFiles(roots);
  if (options.mode === "build") {
    if (!options.out) throw new Error("--out is required for build");
    const out = path.resolve(options.out);
    if (out === path.resolve(productionGraphPath(options.dataRoot))) throw new Error("refusing to write the production graph");
    await fs.rm(out, { force: true });
    const modulePath = options.graphModule ? path.resolve(options.graphModule) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "graph.mjs");
    const graph = await import(pathToFileURL(modulePath).href);
    const graphBuild = await graph.buildGraph({ dataRoot: options.dataRoot, graphPath: out, roots });
    options.graph = out;
    const db = new DatabaseSync(out, { readOnly: true });
    try { return collectMetrics(db, options, { scanned: graphBuild.scanned, changed: graphBuild.changed }); } finally { db.close(); }
  }
  if (options.mode !== "metrics") throw new Error(`unknown mode: ${options.mode}`);
  if (!options.graph) throw new Error("--graph is required for metrics");
  const db = new DatabaseSync(path.resolve(options.graph), { readOnly: true });
  try { return collectMetrics(db, options); } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runMetrics(parseArgs(process.argv.slice(2)));
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (parseArgs(process.argv.slice(2)).json) await fs.writeFile(parseArgs(process.argv.slice(2)).json, output, "utf8");
    process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
