import fs from "node:fs/promises";
import path from "node:path";

// 代码图与记忆项目的关联：读 project-graphs.json 登记表，按项目名匹配登记项，
// 再扫一遍代码目录判断"图是否过期"（代码 mtime 比建图新）。只读，不触发抽取。
export const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".m", ".mjs", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".swift",
  ".ts", ".tsx", ".vue", ".yaml", ".yml",
]);
export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "target", "coverage", ".next",
  ".dsh-room", "reports", "var", "logs", "tmp", ".cache",
]);

export async function scanCode(root) {
  let files = 0;
  let newestMtime = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files += 1;
        try {
          const stat = await fs.stat(path.join(dir, entry.name));
          if (stat.mtimeMs > newestMtime) newestMtime = stat.mtimeMs;
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
  await walk(root);
  return { files, newestMtime };
}

export function pickEntry(registry, project) {
  const wanted = String(project ?? "").trim().toLowerCase();
  if (!wanted) return null;
  for (const entry of Object.values(registry?.projects ?? {})) {
    const names = [entry?.project, entry?.name, path.basename(String(entry?.path ?? ""))].map((value) => String(value ?? "").toLowerCase());
    if (names.includes(wanted)) return entry;
  }
  return null;
}

// 返回给控制台的摘要：不做抽取、不写任何文件
export async function summarizeCodeGraph({ registryPath, project, now = Date.now() }) {
  const registry = await fs.readFile(registryPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
  const entry = pickEntry(registry, project);
  if (!entry) return { registered: false };
  const graphPath = path.resolve(entry.graph ?? "");
  const graphExists = graphPath ? await fs.access(graphPath).then(() => true, () => false) : false;
  if (!graphExists) return { registered: true, state: "MISSING_GRAPH", graph: graphPath, path: entry.path };
  const scanned = await scanCode(entry.path);
  const builtAt = Date.parse(entry.last_built_at ?? "");
  const staleByMtime = scanned.newestMtime > 0 && Number.isFinite(builtAt) && scanned.newestMtime > builtAt + 2000;
  const oldFiles = Number(entry.files);
  const drift = Number.isFinite(oldFiles) && oldFiles > 0 ? Math.abs(scanned.files - oldFiles) / oldFiles : 0;
  return {
    registered: true,
    state: staleByMtime || drift > 0.05 ? "STALE" : "EXISTING",
    path: entry.path,
    graph: graphPath,
    files: scanned.files,
    indexed_files: oldFiles,
    nodes: Number(entry.nodes ?? 0),
    edges: Number(entry.edges ?? 0),
    last_built_at: entry.last_built_at ?? null,
    stale_reasons: [
      ...(staleByMtime ? ["代码比图新"] : []),
      ...(drift > 0.05 ? [`文件数漂移 ${Math.round(drift * 100)}%`] : []),
    ],
  };
}


// ---- 记忆 ↔ 代码：从记忆正文里抽文件/符号引用，再对到代码图上 ----
const FILE_REF = /[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.(?:mjs|json|tsx|ts|jsx|js|html|md|css|yml|yaml|sql|ps1|py)\b/gu;
const SYMBOL_REF = /[A-Za-z_$][A-Za-z0-9_$]{2,}(?=\()/gu;
const STOP_SYMBOLS = new Set(["if", "for", "while", "return", "function", "catch", "switch", "with", "new", "await", "async", "typeof"]);

export function extractCodeRefs(text) {
  const files = new Set();
  const symbols = new Set();
  for (const match of String(text ?? "").matchAll(FILE_REF)) files.add(match[0]);
  for (const match of String(text ?? "").matchAll(SYMBOL_REF)) {
    const name = match[0];
    if (!STOP_SYMBOLS.has(name)) symbols.add(name);
  }
  return { files: [...files], symbols: [...symbols] };
}

async function loadGraphIndex(graphPath) {
  const cached = graphIndexCache.get(graphPath);
  if (cached && Date.now() - cached.at < 120000) return cached.index;
  const data = JSON.parse(await fs.readFile(graphPath, "utf8"));
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const byFile = new Map();
  const bySymbol = new Map();
  for (const node of nodes) {
    const source = String(node?.source ?? node?.source_file ?? "");
    if (source) {
      const base = path.basename(source);
      if (!byFile.has(base)) byFile.set(base, { file: source, line: node?.loc ? Number(String(node.loc).replace(/\D/gu, "")) || null : null });
      byFile.set(source, { file: source, line: node?.loc ? Number(String(node.loc).replace(/\D/gu, "")) || null : null });
    }
    const label = String(node?.label ?? "");
    const name = label.replace(/\(\)$/u, "");
    if (name && !bySymbol.has(name)) bySymbol.set(name, { file: source || null, line: node?.loc ? Number(String(node.loc).replace(/\D/gu, "")) || null : null });
  }
  const index = { byFile, bySymbol };
  graphIndexCache.set(graphPath, { at: Date.now(), index });
  return index;
}
const graphIndexCache = new Map();

// 返回去重后的引用列表；未命中代码图的直接丢弃（不做模糊猜测）
export async function resolveCodeRefs({ graphPath, texts, limit = 8 }) {
  if (!graphPath) return [];
  let index;
  try { index = await loadGraphIndex(graphPath); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const text of texts) {
    const { files, symbols } = extractCodeRefs(text);
    for (const raw of files) {
      const base = path.basename(raw);
      const hit = index.byFile.get(base) ?? index.byFile.get(raw.replace(/\\/gu, "/"));
      if (!hit) continue;
      const key = hit.file;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: "file", value: base, file: hit.file, line: hit.line ?? null });
    }
    for (const name of symbols) {
      const hit = index.bySymbol.get(name);
      if (!hit) continue;
      const key = "symbol:" + name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: "symbol", value: name, file: hit.file, line: hit.line ?? null });
    }
  }
  return out.slice(0, limit);
}
