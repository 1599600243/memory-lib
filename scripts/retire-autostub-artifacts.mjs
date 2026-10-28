#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function valueFor(...names) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1] ?? null;
  }
  return null;
}
const apply = args.includes("--apply");
const dataRoot = path.resolve(valueFor("--data-root", "--root") ?? "D:/MemoryLib/data/memory");
const backupRoot = path.resolve(valueFor("--backup-root") ?? "D:/MemoryLib/backups");
const curatedRoot = path.join(dataRoot, "curated");
const evidenceRoot = path.join(dataRoot, "evidence", "conversations");

function walkFiles(root, predicate = () => true) {
  const output = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(full)) output.push(full);
    }
  }
  return output.sort();
}
function parseValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  try { return JSON.parse(value); } catch { return value.replace(/^["']|["']$/gu, ""); }
}
function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    result[line.slice(0, index).trim()] = parseValue(line.slice(index + 1));
  }
  return result;
}
function arrayValue(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === "") return [];
  return [String(value)];
}
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function relative(file) { return path.relative(dataRoot, file).split(path.sep).join("/"); }
function snapshot(root) {
  return walkFiles(root).map((file) => ({ path: relative(file), size: fs.statSync(file).size, sha256: sha256(file) }));
}
function sameSnapshot(before, after) { return JSON.stringify(before) === JSON.stringify(after); }
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function candidateFor(file) {
  const frontmatter = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const id = String(frontmatter.id ?? "");
  const tags = arrayValue(frontmatter.tags);
  if (!tags.includes("auto-stub") && !id.startsWith("auto-stub-")) return null;
  return { file, id, tags, evidence_refs: arrayValue(frontmatter.evidence_refs), frontmatter };
}

if (!fs.existsSync(curatedRoot)) throw new Error(`curated root not found: ${curatedRoot}`);
const evidenceBefore = snapshot(evidenceRoot);
const curatedFiles = walkFiles(curatedRoot, (file) => path.extname(file).toLowerCase() === ".md");
const candidates = curatedFiles.map(candidateFor).filter(Boolean);
const memoryFiles = walkFiles(dataRoot, (file) => path.extname(file).toLowerCase() === ".md" && !relative(file).startsWith("evidence/"));
const references = [];
for (const candidate of candidates) {
  for (const file of memoryFiles) {
    if (file === candidate.file) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const fields = { evidence_refs: arrayValue(fm.evidence_refs), supersedes: arrayValue(fm.supersedes) };
    for (const [field, ids] of Object.entries(fields)) if (ids.includes(candidate.id)) references.push({ id: candidate.id, candidate: relative(candidate.file), referenced_by: relative(file), field });
  }
}
const blockedIds = new Set(references.map((item) => item.id));
const movable = candidates.filter((item) => !blockedIds.has(item.id)).map((item) => ({ path: relative(item.file), id: item.id, size: fs.statSync(item.file).size, sha256: sha256(item.file), tags: item.tags, evidence_refs: item.evidence_refs }));
const skippedReferenced = candidates.filter((item) => blockedIds.has(item.id)).map((item) => ({ path: relative(item.file), id: item.id, references: references.filter((ref) => ref.id === item.id) }));
const dryResult = { mode: apply ? "apply" : "dry-run", data_root: dataRoot, backup_root: backupRoot, curated_files: curatedFiles.length, evidence_conversations: { count: evidenceBefore.length, files: evidenceBefore }, candidates: candidates.length, movable, skipped_referenced: skippedReferenced };
if (!apply) { console.log(JSON.stringify(dryResult, null, 2)); process.exit(0); }
if (skippedReferenced.length) {
  console.error(JSON.stringify({ ...dryResult, error: "SAFETY_GATE_REFERENCED_STUBS", message: "Referenced auto-stub artifacts were found; no files were moved." }, null, 2));
  process.exit(1);
}
if (!movable.length) {
  const evidenceAfter = snapshot(evidenceRoot);
  if (!sameSnapshot(evidenceBefore, evidenceAfter)) throw new Error("postcondition failed: evidence/conversations changed");
  console.log(JSON.stringify({ ...dryResult, backup_dir: null, manifest: null, moved: [], postconditions: { curated_clear: true, evidence_unchanged: true, backup_hashes_valid: true }, rerun: true }, null, 2));
  process.exit(0);
}
const backupDir = path.join(backupRoot, `autostub-cleanup-${stamp()}`);
fs.mkdirSync(backupRoot, { recursive: true });
fs.mkdirSync(backupDir, { recursive: false });
const movedAt = new Date().toISOString();
const manifest = [];
for (const candidate of candidates) {
  const originalPath = candidate.file;
  const relativePath = relative(originalPath);
  const newPath = path.join(backupDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  const entry = { original_path: originalPath, new_path: newPath, relative_path: relativePath, size: fs.statSync(originalPath).size, sha256: sha256(originalPath), tags: candidate.tags, evidence_refs: candidate.evidence_refs, moved_at: movedAt };
  fs.renameSync(originalPath, newPath);
  manifest.push(entry);
}
const manifestPath = path.join(backupDir, "manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const remaining = walkFiles(curatedRoot, (file) => path.extname(file).toLowerCase() === ".md").map(candidateFor).filter(Boolean);
const evidenceAfter = snapshot(evidenceRoot);
const invalidBackups = manifest.filter((entry) => !fs.existsSync(entry.new_path) || fs.statSync(entry.new_path).size !== entry.size || sha256(entry.new_path) !== entry.sha256);
const postconditions = { curated_clear: remaining.length === 0, evidence_unchanged: sameSnapshot(evidenceBefore, evidenceAfter), backup_hashes_valid: invalidBackups.length === 0 };
if (!Object.values(postconditions).every(Boolean)) {
  console.error(JSON.stringify({ error: "POSTCONDITION_FAILED", backup_dir: backupDir, manifest: manifestPath, postconditions, remaining: remaining.map((item) => relative(item.file)), invalid_backups: invalidBackups.map((item) => item.relative_path) }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ...dryResult, backup_dir: backupDir, manifest: manifestPath, moved: manifest, postconditions }, null, 2));
