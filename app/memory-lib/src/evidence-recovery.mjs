// D29 retained evidence/recovery file APIs. Knowledge quarantine/approval is retired.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const FORBIDDEN_RESTORE_PATHS = ["old-memory-core.sqlite", "old-session", "session-cold-storage", "profile-cold-storage", "vector", "sqlite", "sessions"];

export function createEvidenceRecoveryApi({ dataRoot, workspaceRoot }) {
  const evidenceRoot = path.join(dataRoot, "evidence");
  const recoveryRoot = path.join(workspaceRoot, "recovery");
  const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "unnamed";
  async function atomicWrite(target, content) { return atomicWriteFile(target, content); }
  async function write(root, id, content) { const filePath = path.join(root, `${slugify(id)}.md`); await atomicWrite(filePath, content); return { path: filePath, id }; }
  async function find(root, id) { const wanted = slugify(id); for (const filePath of await walkFiles(root)) if (path.basename(filePath, path.extname(filePath)) === wanted) return filePath; return null; }
  async function read(root, id) { const filePath = await find(root, id); return filePath ? { path: filePath, content: await readTextFile(filePath) } : null; }
  async function evidenceImport(id, content) { return write(path.join(evidenceRoot, "documents"), id, content); }
  async function evidenceGet(id) { return read(evidenceRoot, id); }
  async function evidenceList() { return { root: evidenceRoot, files: await walkFiles(evidenceRoot) }; }
  async function recoveryPlanGet(id) { return read(recoveryRoot, id); }
  async function recoveryPlanPut(id, content) { return write(recoveryRoot, id, content); }
  async function recoveryStatus() { const files = await walkFiles(recoveryRoot); return { root: recoveryRoot, files }; }
  async function recoveryRestoreValidate(pathValue) {
    if (!pathValue) return { path: "", allowed: true, forbiddenHits: [] };
    const root = path.resolve(pathValue); const hits = [];
    for (const filePath of await walkFiles(root)) { const lower = filePath.toLowerCase(); if (FORBIDDEN_RESTORE_PATHS.some((part) => lower.includes(part))) hits.push(filePath); }
    return { path: pathValue, allowed: hits.length === 0, forbiddenHits: hits };
  }
  return { evidenceImport, evidenceGet, evidenceList, recoveryPlanGet, recoveryPlanPut, recoveryStatus, recoveryRestoreValidate };
}
