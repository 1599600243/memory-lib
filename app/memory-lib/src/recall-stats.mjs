// memory-lib D4.3/D4G2 — 精确召回计数（带外 sidecar，检索零写）。
// 检索命中不写盘：命中由服务端记录到 pending（recall-hits-pending.jsonl），
// 由显式命令 scripts/recall-stats.mjs --update 合并进 recall-counts.json。
// 衰减可选用计数：updated_at > 180 天 且 计数 = 0 才置 stale。
// D4G2：计数键用「相对 dataRoot 的路径」（含扩展名、正斜杠），同名文件不互相污染。
import fs from "node:fs/promises";
import path from "node:path";

export function createRecallStats({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("recall-stats: dataRoot is required");
  const runtimeRoot = path.join(dataRoot, "runtime");
  const pendingPath = path.join(runtimeRoot, "recall-hits-pending.jsonl");
  const countsPath = path.join(runtimeRoot, "recall-counts.json");

  // 计数键 = 相对 dataRoot 的路径（正斜杠、保留扩展名）。
  // 不在 dataRoot 之下的文件回退到 basename（不应发生，防御性）。
  function keyFor(filePath) {
    const abs = path.resolve(String(filePath ?? ""));
    const rel = path.relative(path.resolve(dataRoot), abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(abs);
    return rel.replace(/\\/g, "/");
  }

  async function readJson(filePath) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return {}; } }

  let legacyPathMapPromise = null;
  async function legacyPathMap() {
    if (legacyPathMapPromise) return legacyPathMapPromise;
    legacyPathMapPromise = (async () => {
      const map = new Map();
      const stack = [path.resolve(dataRoot)];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!entry.name.startsWith("_") && entry.name !== "runtime" && entry.name !== "indexes") stack.push(path.join(dir, entry.name));
            continue;
          }
          if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
          const filePath = path.join(dir, entry.name);
          const rel = path.relative(path.resolve(dataRoot), filePath).replace(/\\/g, "/");
          const key = path.basename(filePath, path.extname(filePath));
          const paths = map.get(key) ?? [];
          paths.push(rel);
          map.set(key, paths);
        }
      }
      return map;
    })();
    return legacyPathMapPromise;
  }

  async function migrateUniqueLegacyCounts(counts) {
    const paths = await legacyPathMap();
    let migrated = 0;
    for (const [key, value] of Object.entries(counts)) {
      if (key.includes("/") || !Number.isFinite(Number(value))) continue;
      const matches = paths.get(key) ?? [];
      if (matches.length !== 1) continue;
      const rel = matches[0];
      if (counts[rel] === undefined) counts[rel] = Number(value);
      else counts[rel] += Number(value);
      delete counts[key];
      migrated += 1;
    }
    return migrated;
  }

  async function recordHits(filePaths) {
    const keys = (Array.isArray(filePaths) ? filePaths : []).map(keyFor).filter(Boolean);
    if (!keys.length) return { recorded: 0 };
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.appendFile(pendingPath, `${keys.join("\n")}\n`, "utf8");
    return { recorded: keys.length };
  }

  async function update() {
    const counts = await readJson(countsPath);
    const migrated = await migrateUniqueLegacyCounts(counts);
    let pending = "";
    try { pending = await fs.readFile(pendingPath, "utf8"); } catch { /* no pending */ }
    const keys = pending.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
    let added = 0;
    for (const key of keys) { counts[key] = (counts[key] ?? 0) + 1; added += 1; }
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.writeFile(countsPath, JSON.stringify(counts, null, 2), "utf8");
    await fs.writeFile(pendingPath, "", "utf8");
    return { added, migrated, total: Object.keys(counts).length };
  }

  async function listCounts() {
    const counts = await readJson(countsPath);
    await migrateUniqueLegacyCounts(counts);
    return counts;
  }

  async function countFor(filePath) {
    const counts = await readJson(countsPath);
    await migrateUniqueLegacyCounts(counts);
    return counts[keyFor(filePath)] ?? 0;
  }

  return { recordHits, update, countFor, listCounts, countsPath, pendingPath };
}
