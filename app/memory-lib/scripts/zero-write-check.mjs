// memory-lib — zero-write verification helper.
// Snapshots a tree (relative path, size, mtimeMs, sha256 per file) and diffs two snapshots.
// Usage: node scripts/zero-write-check.mjs <root> [before.json]
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export async function snapshotTree(root, { skipDirs = [] } = {}) {
  const skip = new Set(skipDirs);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue; // 豁免目录（如 runtime sidecar）
        stack.push(full);
      } else {
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        let hash = "";
        try {
          const buf = await fs.readFile(full);
          hash = crypto.createHash("sha256").update(buf).digest("hex");
        } catch {
          hash = "<unreadable>";
        }
        out.push({ path: path.relative(root, full).replace(/\\/g, "/"), size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash });
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Diff two snapshots. Strict by default: every size/mtime/byte change is reported.
//
// `allowWal` (default false) is the ONLY opt-in relaxation: a SQLite database in
// WAL journal mode legitimately touches its `-shm`/`-wal` sidecar files when it is
// opened READ-ONLY (the shared-memory index is created/refreshed, and the WAL may
// be checkpointed by the reader). The main `.sqlite` file must still be byte-identical:
// only files ending in `-shm` or `-wal` are exempted from added/deleted/modified
// reporting. Every caller stays strict unless it explicitly passes `{ allowWal: true }`.
export function diffSnapshots(before, after, { allowWal = false } = {}) {
  const isWalSidecar = (filePath) => allowWal && /(?:-shm|-wal)$/u.test(filePath);
  const changes = [];
  const byPath = new Map(after.map((f) => [f.path, f]));
  for (const f of before) {
    const a = byPath.get(f.path);
    if (isWalSidecar(f.path)) continue;
    if (!a) { changes.push({ path: f.path, change: "deleted" }); continue; }
    if (a.size !== f.size || a.mtimeMs !== f.mtimeMs || a.sha256 !== f.sha256) {
      changes.push({ path: f.path, change: "modified", before: f, after: a });
    }
  }
  for (const a of after) {
    if (isWalSidecar(a.path)) continue;
    if (!before.some((f) => f.path === a.path)) changes.push({ path: a.path, change: "added" });
  }
  return changes;
}

// CLI usage: node scripts/zero-write-check.mjs <root>          -> prints snapshot JSON
//            node scripts/zero-write-check.mjs <root> <before> -> prints diff vs before.json
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2];
  if (!root) { console.error("usage: node scripts/zero-write-check.mjs <root> [before.json]"); process.exit(1); }
  if (process.argv[3]) {
    const before = JSON.parse(await fs.readFile(process.argv[3], "utf8"));
    const after = await snapshotTree(root);
    const changes = diffSnapshots(before, after);
    console.log(JSON.stringify(changes, null, 2));
    if (changes.length === 0) console.log("ZERO_WRITE_OK");
  } else {
    console.log(JSON.stringify(await snapshotTree(root), null, 2));
  }
}
