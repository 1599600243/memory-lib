#!/usr/bin/env node
/**
 * verify-deploy8.mjs —— DEPLOY-8 后的**机械核对**（任何人可复跑）
 *
 * ⚠️ 这是**产品岗侧的测量**，用来给数据事实留原始输出。
 *    **它不是验收岗的独立复核** —— 那条仍应由验收岗做（执行者不自证）。
 *
 * 核三件事：
 *   ① curated 下是否还有"机械兜底产物"（tags 含 auto-stub 或 id 以 auto-stub- 开头）
 *   ② 清理前的原文基线（1059 条，取自 autostub-cleanup 目录下 manifest 的 evidence_baseline）
 *      是否**逐条未变**；新增文件只算"增长"，不算"被改"
 *   ③ 被搬走的 3 个 stub 备份，逐个 sha256 是否与 manifest 一致
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = "D:\\MemoryLib\\data\\memory";
const BACKUP = "D:\\MemoryLib\\backups\\autostub-cleanup-20261009-124339";
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function walk(dir, filter = () => true) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let es = [];
    try { es = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && filter(full)) out.push(full);
    }
  }
  return out.sort();
}

const manifestDir = BACKUP;
const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, "manifest.json"), "utf8"));
const out = { checked_at: new Date().toISOString(), backup_manifest_dir: manifestDir, backup_manifest_file: path.join(manifestDir, "manifest.json") };

// ① 机械兜底产物
const curated = walk(path.join(ROOT, "curated"), (f) => f.endsWith(".md"));
const mechanical = curated.filter((f) => {
  const text = fs.readFileSync(f, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  const fm = m ? m[1] : "";
  const idLine = /^id\s*:\s*(.*)$/mu.exec(fm)?.[1]?.replace(/^["']|["']$/gu, "") ?? "";
  const tagLine = /^tags\s*:\s*(.*)$/mu.exec(fm)?.[1] ?? "";
  return /(^|[^\w-])auto-stub/u.test(tagLine) || idLine.startsWith("auto-stub-");
});
out.curated_md_total = curated.length;
out.mechanical_remaining = mechanical.length;
out.mechanical_paths = mechanical.map((f) => path.relative(ROOT, f).replaceAll("\\", "/"));

// ② 原文基线逐条比对
// ⚠️ 范围必须与基线一致：retire 脚本的 EVIDENCE = ROOT/evidence（**整个 evidence 树**），
//    不是只 evidence/conversations。第一版只扫 conversations，导致其他子目录的 79 条被误判为"已不存在"。
const evidenceDir = path.join(ROOT, "evidence");
const now = new Map();
for (const f of walk(evidenceDir, (x) => x.endsWith(".md"))) {
  const rel = path.relative(ROOT, f).replaceAll("\\", "/");
  now.set(rel, { size: fs.statSync(f).size, sha256: sha(f) });
}
const base = manifest.evidence_baseline ?? [];
const changed = [];
for (const b of base) {
  const cur = now.get(b.rel);
  if (!cur) changed.push({ rel: b.rel, why: "**已不存在**" });
  else if (cur.sha256 !== b.sha256) changed.push({ rel: b.rel, why: `sha256 变了（基线 ${b.sha256.slice(0, 12)}… → 现在 ${cur.sha256.slice(0, 12)}…）` });
}
const baseRels = new Set(base.map((b) => b.rel));
const added = [...now.keys()].filter((r) => !baseRels.has(r));
out.evidence_baseline_count = base.length;
out.evidence_now_count = now.size;
out.evidence_added = added.length;
out.evidence_changed = changed.length;
out.evidence_changed_detail = changed;

// ③ 备份文件校验
const movedChecks = manifest.moved.map((m) => {
  let actual = null;
  try { actual = sha(m.target); } catch { return { rel: m.rel, ok: false, why: "备份文件读不到" }; }
  return { rel: m.rel, ok: actual === m.sha256, sha256: actual.slice(0, 16) + "…" };
});
out.moved_verified = movedChecks.filter((m) => m.ok).length;
out.moved_total = movedChecks.length;
out.moved_detail = movedChecks;

console.log(JSON.stringify(out, null, 2));
const bad = [];
if (out.mechanical_remaining !== 0) bad.push(`curated 下仍有 ${out.mechanical_remaining} 个机械兜底产物`);
if (out.evidence_changed !== 0) bad.push(`原文基线里有 ${out.evidence_changed} 条被改动/丢失`);
if (out.moved_verified !== out.moved_total) bad.push(`备份校验失败 ${out.moved_total - out.moved_verified} 个`);
console.log("");
console.log(bad.length ? `❌ ${bad.join("；")}` : "✅ 三条机械核对全部通过（本输出为机械测量结果；**复核者须与执行者不同人**）");
process.exit(bad.length ? 1 : 0);
