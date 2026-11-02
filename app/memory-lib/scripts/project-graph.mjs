import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { atomicWriteFile } from "../src/atomic-write.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const REGISTRY_DEFAULT = path.join(REPO_DIR, "var", "project-graphs.json");
const CODE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".m", ".mjs", ".php", ".ps1", ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".vue"]);
const IGNORED_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "target", "coverage", ".next", ".dsh-room", "reports", "var", "logs", "tmp", ".cache"]);

export function normalizeProjectKey(value) {
  const input = String(value).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//u.test(input)) {
    const normalized = path.win32.normalize(input.replace(/\//g, "\\")).replace(/\\/g, "/");
    return normalized[0].toLowerCase() + normalized.slice(1).replace(/\/$/u, "");
  }
  return path.resolve(input).replace(/\\/g, "/").replace(/\/$/u, "") || "/";
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function resolveProjectPath(inputPath = process.cwd()) {
  const requested = path.resolve(inputPath);
  const root = runGit(["rev-parse", "--show-toplevel"], requested);
  return path.resolve(root || requested);
}

function aliasesFor(projectPath) {
  const output = runGit(["remote", "-v"], projectPath);
  return [...new Set(output.split(/\r?\n/u).map((line) => line.match(/\s(\S+)\s+\((?:fetch|push)\)$/u)?.[1]).filter(Boolean))];
}

export function mergeRegistry(registry, entry) {
  const entries = registry && typeof registry.projects === "object" && !Array.isArray(registry.projects) ? registry.projects : {};
  return { ...registry, version: registry?.version ?? 1, projects: { ...entries, [entry.key]: entry } };
}

async function readRegistry(registryPath) {
  try {
    const data = JSON.parse(await fs.readFile(registryPath, "utf8"));
    return data && typeof data === "object" ? data : { version: 1, projects: {} };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, projects: {} };
    throw new Error(`cannot read registry ${registryPath}: ${error.message}`);
  }
}

async function writeRegistry(registryPath, registry) {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  // 走仓库统一的原子写（Windows EPERM 重试），不要裸 fs.rename
  await atomicWriteFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function scanCode(root) {
  let count = 0, newestMtime = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        count++;
        try { const stat = await fs.stat(path.join(dir, entry.name)); if (stat.mtimeMs > newestMtime) newestMtime = stat.mtimeMs; } catch {}
      }
    }
  }
  await walk(root);
  return { files: count, newestMtime };
}

async function countCodeFiles(root) { return (await scanCode(root)).files; }

async function graphCounts(graphPath) {
  const data = JSON.parse(await fs.readFile(graphPath, "utf8"));
  const nodes = Array.isArray(data.nodes) ? data.nodes : Array.isArray(data.graph?.nodes) ? data.graph.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : Array.isArray(data.graph?.edges) ? data.graph.edges : [];
  const sources = new Set();
  for (const node of nodes) {
    const source = node?.source ?? node?.source_file;
    if (typeof source === "string" && source) sources.add(source);
  }
  return { nodes: nodes.length, edges: edges.length, files: sources.size };
}

export async function classifyProject(entry, { head, graphExists, files, newestMtime = 0 }) {
  if (!entry) return "NEW";
  if (!graphExists) return "STALE";
  // last_head 只记录不判定：只提交/合并、代码没重写时文件 mtime 不会变，图仍然有效

  // 未提交的改动：代码 mtime 比上次建图还新 ⇒ 图已过期（2 秒容差）
  const builtAt = Date.parse(entry.last_built_at ?? "");
  if (newestMtime && Number.isFinite(builtAt) && newestMtime > builtAt + 2000) return "STALE";
  const oldFiles = Number(entry.files);
  if (Number.isFinite(oldFiles) && oldFiles > 0 && Math.abs(files - oldFiles) / oldFiles > 0.05) return "STALE";
  return "EXISTING";
}

async function graphifyPath() {
  if (process.env.GRAPHIFY_BIN) return process.env.GRAPHIFY_BIN;
  const command = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(command, ["graphify"], { encoding: "utf8", windowsHide: true });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/u)[0];
  const home = process.env.USERPROFILE || os.homedir();
  const candidate = path.join(home, ".local", "bin", process.platform === "win32" ? "graphify.exe" : "graphify");
  try { await fs.access(candidate); return candidate; } catch { return null; }
}

function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function runGraphify(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw new Error(`graphify failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`graphify exited with status ${result.status}`);
}

async function createGraph(projectPath, reportsDir, outputPath = null) {
  const binary = await graphifyPath();
  if (!binary) { const error = new Error("graphify 未安装；请运行 uv tool install graphifyy"); error.exitCode = 13; throw error; }
  const out = outputPath || path.join(reportsDir, `graphify-${timestampName()}`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  runGraphify(binary, ["extract", projectPath, "--code-only", "--no-cluster", "--out", out], projectPath);
  const expected = path.join(out, "graph.json");
  try { await fs.access(expected); return expected; } catch { /* check the legacy nested output layout too */ }
  const nested = path.join(out, "graphify-out", "graph.json");
  try { await fs.access(nested); return nested; } catch { throw new Error(`graphify finished but graph.json was not found under ${out}`); }
}

function statusOutput(result, asJson) {
  if (asJson) console.log(JSON.stringify(result));
  else {
    const messages = { NEW: "新项目：尚未登记图谱", EXISTING: "已有图谱：登记与当前代码一致", STALE: "图谱已过期：需要 update" };
    console.log(`${result.state} ${result.key}\n${messages[result.state]}${result.graph ? `\ngraph: ${result.graph}` : ""}`);
  }
}

export async function getProjectStatus(projectPath, registryPath = REGISTRY_DEFAULT) {
  const key = normalizeProjectKey(projectPath);
  const head = runGit(["rev-parse", "HEAD"], projectPath);
  const scanned = await scanCode(projectPath);
  const files = scanned.files;
  const registry = await readRegistry(registryPath);
  const entry = registry.projects?.[key] || null;
  const graphPath = entry?.graph ? path.resolve(entry.graph) : "";
  const graphExists = graphPath ? await fs.access(graphPath).then(() => true, () => false) : false;
  const state = await classifyProject(entry, { head: head || null, graphExists, files, newestMtime: scanned.newestMtime });
  return { state, key, graph: graphPath || null, last_head: entry?.last_head ?? null, head: head || null, files, entry };
}

function parseArgs(args) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") result.json = true;
    else if (["--path", "--name", "--graph", "--project", "--mode", "--a", "--b", "--depth"].includes(arg)) result[arg.slice(2)] = args[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else result._.push(arg);
  }
  return result;
}

async function doInit(options) {
  const projectPath = resolveProjectPath(options.path || process.cwd());
  const key = normalizeProjectKey(projectPath);
  const registryPath = path.resolve(process.env.PROJECT_GRAPH_REGISTRY || REGISTRY_DEFAULT);
  const registry = await readRegistry(registryPath);
  if (registry.projects?.[key]) { const error = new Error(`项目已登记，请改用 update：${key}`); error.exitCode = 12; throw error; }
  const head = runGit(["rev-parse", "HEAD"], projectPath) || null;
  const graphPath = path.resolve(options.graph || await createGraph(projectPath, path.join(REPO_DIR, "reports")));
  const counts = await graphCounts(graphPath);
  const entry = {
    key,
    ...(options.project ? { project: String(options.project) } : {}), name: options.name || path.basename(projectPath), path: projectPath,
    aliases: aliasesFor(projectPath), graph: graphPath, last_head: head,
    last_built_at: new Date().toISOString(), files: await countCodeFiles(projectPath),
    nodes: counts.nodes, edges: counts.edges,
  };
  await writeRegistry(registryPath, mergeRegistry(registry, entry));
  console.log(JSON.stringify({ ok: true, ...entry }));
  return 0;
}

async function doUpdate(options) {
  const projectPath = resolveProjectPath(options.path || process.cwd());
  const key = normalizeProjectKey(projectPath);
  const registryPath = path.resolve(process.env.PROJECT_GRAPH_REGISTRY || REGISTRY_DEFAULT);
  const registry = await readRegistry(registryPath);
  const previous = registry.projects?.[key];
  if (!previous) { const error = new Error(`项目尚未登记，请先 init：${key}`); error.exitCode = 10; throw error; }
  const oldGraph = path.resolve(previous.graph);
  const produced = await createGraph(projectPath, path.dirname(path.dirname(oldGraph)), path.dirname(path.dirname(oldGraph)));
  const graphPath = produced;
  const counts = await graphCounts(graphPath);
  const entry = { ...previous, key, ...(options.project ? { project: String(options.project) } : {}), path: projectPath, aliases: aliasesFor(projectPath), graph: graphPath, last_head: runGit(["rev-parse", "HEAD"], projectPath) || null, last_built_at: new Date().toISOString(), files: await countCodeFiles(projectPath), nodes: counts.nodes, edges: counts.edges };
  await writeRegistry(registryPath, mergeRegistry(registry, entry));
  console.log(JSON.stringify({ ok: true, ...entry }));
  return 0;
}

async function doQuery(options) {
  const projectPath = resolveProjectPath(options.path || process.cwd());
  const status = await getProjectStatus(projectPath, path.resolve(process.env.PROJECT_GRAPH_REGISTRY || REGISTRY_DEFAULT));
  if (status.state !== "EXISTING" && status.state !== "STALE") { const error = new Error(`项目尚无已登记图谱：${status.key}`); error.exitCode = 10; throw error; }
  if (!status.graph || !await fs.access(status.graph).then(() => true, () => false)) { const error = new Error("登记的 graph 文件不存在，请先 update"); error.exitCode = 11; throw error; }
  const mode = options.mode || "explain", binary = await graphifyPath();
  if (!binary) { const error = new Error("graphify 未安装；请运行 uv tool install graphifyy"); error.exitCode = 13; throw error; }
  let args;
  if (mode === "explain" || mode === "affected") {
    const symbol = options._[1]; if (!symbol) throw new Error(`query --mode ${mode} 需要符号参数`);
    args = [mode, symbol]; if (mode === "affected") args.push("--depth", options.depth || "2"); args.push("--graph", status.graph);
  } else if (mode === "path") {
    const a = options.a || options._[1], b = options.b || options._[2]; if (!a || !b) throw new Error("query --mode path 需要 --a A --b B");
    args = ["path", a, b, "--graph", status.graph];
  } else if (mode === "query") {
    const question = options._.slice(1).join(" "); if (!question) throw new Error("query --mode query 需要问题文本");
    args = ["query", question, "--budget", "800", "--graph", status.graph];
  } else throw new Error(`unknown query mode: ${mode}`);
  runGraphify(binary, args, projectPath);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(error.message); return 2; }
  const command = options._[0];
  try {
    if (command === "status") {
      const projectPath = resolveProjectPath(options.path || process.cwd());
      const result = await getProjectStatus(projectPath, path.resolve(process.env.PROJECT_GRAPH_REGISTRY || REGISTRY_DEFAULT));
      statusOutput(result, options.json);
      return result.state === "NEW" ? 10 : result.state === "STALE" ? 11 : 0;
    }
    if (command === "init") return await doInit(options);
    if (command === "update") return await doUpdate(options);
    if (command === "query") return await doQuery(options);
    console.error("用法: project-graph.mjs status|init|update|query [选项]");
    return 2;
  } catch (error) {
    console.error(error.message);
    return error.exitCode || 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
