#!/usr/bin/env node
/**
 * retire-probe-artifacts.mjs —— 把"探针/冒烟/测试"产生的对话原文从**生产记忆库**里退役
 *
 * 依据：用户 2026-10-14 批准「那 20 条探针/冒烟条目退役/隔离」。
 * 机制**照既有先例** `retire-autostub-artifacts.mjs`：
 *   · **把文件移出数据根**（不是删），落到 `backups\probe-retire-<stamp>\` 并写 `manifest.json`（含 sha256）
 *   · 默认**干跑**，`--apply` 才动；动之前检查"有没有别的文件引用它"（安全闸）
 *   · 后置校验：备份哈希有效 · 该清的全清了 · 其余文件字节不变
 *
 * 判据（"这条是探针产物"）：满足任一
 *   ① 归属缺失或为 `unknown`（无法归属 ⇒ 见 BACKFILL-ATTR-1，这类就是没回填的那批）
 *   ② `conversationId` 形如 probe-* / r17-test-* / deploy-verify-* / workspace-smoke-* /
 *      handoff-validation-* / protocol-schema-probe / verify-r16-* / d7-rebuild-* / agent:main:*
 *   ③ `source` 属于冒烟集合（deploy8-smoke / deploy11-smoke / probe / …）
 *   ④ 正文自述是探针（如「幂等探针：这条应只出现一次」）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dataRoot = path.resolve("D:/MemoryLib/data/memory");
const backupRoot = path.resolve("D:/MemoryLib/backups");
const evidenceRoot = path.join(dataRoot, "evidence", "conversations");

const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const rel = (f) => path.relative(dataRoot, f).split(path.sep).join("/");
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const walk = (root, pred = () => true) => { const out = []; const stack = [root]; while (stack.length) { const cur = stack.pop(); let es; try { es = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") continue; throw e; } for (const e of es) { const full = path.join(cur, e.name); if (e.isDirectory()) stack.push(full); else if (e.isFile() && pred(full)) out.push(full); } } return out.sort(); };
const snapshot = (root) => walk(root).map((f) => ({ path: rel(f), size: fs.statSync(f).size, sha256: sha256(f) }));

const fm = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/u)) { const i = line.indexOf(":"); if (i < 0) continue; out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/gu, ""); }
  return out;
};

const PROBE_CID = /^(probe[-_]|protocol-schema-probe$|r17-test-|deploy-verify-|workspace-smoke-|handoff-validation-|verify-r1|d7-rebuild-|agent:main:)/iu;
const PROBE_SOURCE = new Set(["deploy8-smoke", "deploy11-smoke", "probe", "capture-attr-unbound", "capture-attr-test"]);
const PROBE_BODY = /幂等探针|测试探针|probe marker|smoke marker/u;

const files = walk(evidenceRoot, (f) => f.endsWith(".md"));
const evidenceBefore = snapshot(evidenceRoot);
const candidates = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const f = fm(text);
  if (f.type !== "conversation") continue;
  const reasons = [];
  const g = f.groupId ?? "", u = f.userId ?? "";
  if (!g || !u || g === "unknown" || u === "unknown") reasons.push("无归属/unknown");
  if (PROBE_CID.test(f.conversationId ?? "")) reasons.push(`conversationId=${f.conversationId}`);
  if (PROBE_SOURCE.has(f.source ?? "")) reasons.push(`source=${f.source}`);
  if (PROBE_BODY.test(text.slice(0, 900))) reasons.push("正文自述探针");
  if (reasons.length) candidates.push({ file, id: f.id ?? "", conversationId: f.conversationId ?? "", source: f.source ?? "", reasons });
}

// 安全闸：被别的文件引用（evidence_refs / supersedes）的不许动
const others = walk(dataRoot, (f) => f.endsWith(".md") && f !== undefined);
const refs = [];
const ids = new Set(candidates.map((c) => c.id).filter(Boolean));
for (const file of others) {
  if (file.startsWith(evidenceRoot + path.sep) && candidates.some((c) => c.file === file)) continue;
  const f = fm(fs.readFileSync(file, "utf8"));
  for (const field of ["evidence_refs", "supersedes"]) {
    const raw = f[field] ?? "";
    const list = raw.replace(/^\[|\]$/gu, "").split(",").map((s) => s.trim().replace(/^"|"$/gu, "")).filter(Boolean);
    for (const id of list) if (ids.has(id)) refs.push({ id, referenced_by: rel(file), field });
  }
}
const blocked = new Set(refs.map((r) => r.id));
const movable = candidates.filter((c) => !blocked.has(c.id));
const skipped = candidates.filter((c) => blocked.has(c.id));

console.log(`evidence/conversations 共 ${files.length} 个文件`);
console.log(`判定为探针产物 ${candidates.length} 个：`);
const byReason = new Map();
for (const c of candidates) { const k = c.reasons.map((r) => r.split("=")[0]).join(" + "); byReason.set(k, (byReason.get(k) ?? 0) + 1); }
for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`   ${v} 个：${k}`);
console.log(`\n可移动 ${movable.length} 个 · 被引用而**拦住** ${skipped.length} 个`);
for (const c of movable) console.log(`   · ${path.basename(c.file)}  cid=${c.conversationId.slice(0, 34)}  source=${c.source}`);

if (!apply) { console.log("\n（干跑：未移动任何文件。加 --apply 才动。）"); process.exit(0); }
// 安全闸按**逐条**生效：被别的文件引用的**跳过**（移动它会打断那条引用），其余照移。
// 被跳过的一定会出现在输出与后置校验里，不许静默。
if (skipped.length) console.log(`\n⚠️ 安全闸：跳过 ${skipped.length} 条**被引用**的候选（不移动）：\n${skipped.map((s) => `   · ${path.basename(s.file)}（id ${s.id}）← 被 ${refs.filter((r) => r.id === s.id).map((r) => r.referenced_by).join(", ")} 引用`).join("\n")}`);
if (!movable.length) { console.log("\n没有可移动的候选。"); process.exit(0); }

const backupDir = path.join(backupRoot, `probe-retire-${stamp()}`);
fs.mkdirSync(backupDir, { recursive: true });
const movedAt = new Date().toISOString();
const manifest = [];
for (const c of movable) {
  const relativePath = rel(c.file);
  const newPath = path.join(backupDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  const entry = { original_path: c.file, new_path: newPath, relative_path: relativePath, size: fs.statSync(c.file).size, sha256: sha256(c.file), reasons: c.reasons, conversationId: c.conversationId, source: c.source, moved_at: movedAt };
  fs.renameSync(c.file, newPath);
  manifest.push(entry);
}
const manifestPath = path.join(backupDir, "manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const remaining = walk(evidenceRoot, (f) => f.endsWith(".md")).length;
const invalid = manifest.filter((e) => !fs.existsSync(e.new_path) || fs.statSync(e.new_path).size !== e.size || sha256(e.new_path) !== e.sha256);
const survivors = walk(evidenceRoot, (f) => f.endsWith(".md")).filter((f) => { const t = fs.readFileSync(f, "utf8"); const x = fm(t); return !x.groupId || !x.userId || PROBE_CID.test(x.conversationId ?? "") || PROBE_SOURCE.has(x.source ?? "") || PROBE_BODY.test(t.slice(0, 900)); });
const before = new Map(evidenceBefore.map((e) => [e.path, e.sha256]));
const changedSurvivors = snapshot(evidenceRoot).filter((e) => before.has(e.path) && before.get(e.path) !== e.sha256);

const post = { moved: manifest.length, backup_hashes_valid: invalid.length === 0, probe_candidates_remaining: survivors.length, expected_remaining_blocked: skipped.length, untouched_files_unchanged: changedSurvivors.length === 0, evidence_files_before: files.length, evidence_files_after: remaining };
console.log(`\n${JSON.stringify({ backup_dir: backupDir, manifest: manifestPath, postconditions: post }, null, 2)}`);
const okPost = invalid.length === 0 && survivors.length === skipped.length && changedSurvivors.length === 0;
if (!okPost) { console.error("POSTCONDITION_FAILED"); process.exit(1); }
