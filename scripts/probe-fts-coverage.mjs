// 验证：用 FTS 粗筛候选，能不能覆盖到关键记忆（决定 INDEX-1 的实现路线）
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const TARGET = "curated-shared-466787238d86faef";

function pathsFor(matchExpr) {
  try {
    const rows = db.prepare("SELECT DISTINCT path FROM fts_chunks WHERE fts_chunks MATCH ? LIMIT 2000").all(matchExpr);
    return rows.map((r) => r.path);
  } catch (e) {
    return { error: e.message };
  }
}

const trials = ["记忆库", '"记忆库"', "记忆库 OR 几层", "收敛为8层", "记忆库收敛为8层", "层"];
for (const m of trials) {
  const t0 = performance.now();
  const res = pathsFor(m);
  const ms = performance.now() - t0;
  if (!Array.isArray(res)) { console.log(`${m.padEnd(20)} 报错 ${res.error}`); continue; }
  const hit = res.some((p) => p.includes(TARGET));
  console.log(`${m.padEnd(20)} ${ms.toFixed(1).padStart(7)}ms  候选文件=${String(res.length).padStart(4)}  含目标=${hit ? "✅" : "❌"}`);
}

// 关键：目标文件在 FTS 里到底有没有 chunk、文本长什么样
const rows = db.prepare("SELECT c.id, c.heading, substr(c.text,1,80) t FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.path LIKE ?").all(`%${TARGET}%`);
console.log(`\n目标文件在索引里的 chunk 数: ${rows.length}`);
for (const r of rows.slice(0, 3)) console.log(`  · [${r.heading ?? ""}] ${r.t.replace(/\s+/g, " ")}`);
const f = db.prepare("SELECT path, status, mtime, updated_at FROM files WHERE path LIKE ?").get(`%${TARGET}%`);
console.log("files 行:", JSON.stringify(f));
