// 量化 VISIBILITY-UNKNOWN-1 的影响面：private 且身份字段为 "unknown" 的条目有多少
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:\\MemoryLib\\data\\memory";
const SKIP = new Set(["indexes", "quarantine", "backups", "runtime", "snapshots", "tmp", "refinement-jobs", "transcript-import"]);

const stats = { files: 0, withFrontmatter: 0, privateVis: 0, privateUnknownUser: 0, privateUnknownAgent: 0, privateUnknownRole: 0, unknownAny: 0 };
const samples = [];
const byDir = {};

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
    if (!e.name.endsWith(".md")) continue;
    stats.files++;
    const raw = fs.readFileSync(p, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const fm = m[1];
    if (!/^layer:/m.test(fm)) continue;
    stats.withFrontmatter++;
    const get = (k) => {
      const mm = fm.match(new RegExp("^" + k + ":\\s*\"?([^\"\\r\\n]*)\"?\\s*$", "m"));
      return mm ? mm[1].trim() : "";
    };
    const vis = get("visibility");
    const u = get("user_id");
    const a = get("agent_id");
    const r = get("role_id");
    const rel = path.relative(ROOT, p).split(path.sep)[0];
    if (vis === "private") {
      stats.privateVis++;
      if (u === "unknown") { stats.privateUnknownUser++; byDir[rel] = (byDir[rel] ?? 0) + 1; if (samples.length < 6) samples.push({ file: path.relative(ROOT, p), vis, u, a, r }); }
      if (a === "unknown") stats.privateUnknownAgent++;
      if (r === "unknown") stats.privateUnknownRole++;
    }
    if (u === "unknown" || a === "unknown" || r === "unknown") stats.unknownAny++;
  }
}

walk(ROOT);
console.log(JSON.stringify(stats, null, 1));
console.log("private+unknown(user) 按层:", JSON.stringify(byDir));
console.log("样例:", JSON.stringify(samples, null, 1));
