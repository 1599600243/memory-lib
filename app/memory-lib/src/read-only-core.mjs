// memory-lib — read-only core, extracted VERBATIM from the live plugin.
//
// PROVENANCE: source = C:\Users\admin\.openclaw\workspace\openclaw-memory\src\service.ts
// (live plugin, last modified 2026-08-16). Each function below is copied byte-for-byte
// from that file; the source line numbers are recorded in the header comment of each
// function. Do NOT "improve" these functions here — if the plugin changes, re-extract
// (see README "sync checklist"). New library-level behavior (scope resolution, wrapper)
// lives in memory-lib.mjs and is clearly marked there.
//
// Only node built-ins are used (node:fs/promises, node:path). No openclaw imports.

import fs from "node:fs/promises";
import path from "node:path";
import { unquote } from "./frontmatter-util.mjs";

// --- buildHealthChecks — D29 searchable layers + storage-only evidence ---------
export function buildHealthChecks(dataRoot, workspaceRoot, recoveryRoot) {
  return [
    ["curated", path.join(dataRoot, "curated")],
    ["project-state", path.join(dataRoot, "project-state")],
    ["tools-memory", path.join(dataRoot, "tools-memory")],
    ["plans", path.join(dataRoot, "plans")],
    ["profile", path.join(dataRoot, "profile")],
    ["evidence-documents", path.join(dataRoot, "evidence", "documents")],
    ["evidence-conversations", path.join(dataRoot, "evidence", "conversations")],
    ["recovery-policies", path.join(recoveryRoot, "policies")],
    ["recovery-plans", path.join(recoveryRoot, "plans")],
  ];
}

// --- readTextFile — service.ts:293-299 (verbatim) ------------------------------
export async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// --- parseFrontmatter — service.ts:301-315 (verbatim) --------------------------
export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, body: text.slice(match[0].length) };
}

// --- walkFiles — service.ts:359-377 (D1 modified) ------------------------------
// D1：目录名以 `_` 开头的（`_legacy-*` / `_archive-*`）被视作「冻结区」，不参与任何
// 检索/列表（数据只移不删）。这是唯一相对原 verbatim 实现的改动，用于 D1.5 数据冻结。
export async function walkFiles(root, exts = [".md", ".json"]) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("_")) stack.push(full);
      } else if (exts === null || exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  return out;
}

// --- searchMatches — service.ts:379-397 (verbatim) -----------------------------
export function searchMatches(text, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(q)) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + 2);
      const excerpt = lines.slice(start, end + 1).map((line, idx) => {
        const lineNo = start + idx + 1;
        const prefix = lineNo === i + 1 ? ">" : " ";
        return `${prefix}${lineNo}: ${line}`;
      }).join("\n");
      hits.push({ line: i + 1, excerpt });
    }
  }
  return hits;
}

// --- findCuratedItemById — service.ts:427-438 (verbatim) -----------------------
export async function findCuratedItemById(root, id) {
  const files = await walkFiles(root);
  for (const filePath of files) {
    const text = await readTextFile(filePath);
    if (!text) continue;
    const { frontmatter, body } = parseFrontmatter(text);
    if (unquote(frontmatter.id) === unquote(id) || path.basename(filePath).includes(unquote(id))) {
      return { filePath, text, frontmatter, body };
    }
  }
  return null;
}

// --- findInboxItemById — service.ts:414-425 (verbatim) -------------------------
export async function findInboxItemById(root, id) {
  const files = await walkFiles(root);
  for (const filePath of files) {
    const text = await readTextFile(filePath);
    if (!text) continue;
    const { frontmatter } = parseFrontmatter(text);
    if (unquote(frontmatter.id) === unquote(id) || path.basename(filePath).includes(unquote(id))) {
      return { filePath, text, frontmatter };
    }
  }
  return null;
}

// --- inferSourceType — D29 eight-layer vocabulary ------------------------------
export function inferSourceType(filePath) {
  if (filePath.includes(`${path.sep}curated${path.sep}`)) return "curated";
  if (filePath.includes(`${path.sep}project-state${path.sep}`)) return "project-state";
  if (filePath.includes(`${path.sep}evidence${path.sep}documents${path.sep}`)) return "document";
  if (filePath.includes(`${path.sep}evidence${path.sep}conversations${path.sep}`)) return "conversation-evidence";
  if (filePath.includes(`${path.sep}tools-memory${path.sep}`)) return "tool";
  if (filePath.includes(`${path.sep}plans${path.sep}`)) return "plan";
  if (filePath.includes(`${path.sep}profile${path.sep}`)) return "profile";
  return "curated";
}

// --- rootsForSourceType — D29 searchable-layer roots ----------------------------
export function rootsForSourceType(sourceType, dataRoot) {
  switch (sourceType) {
    case "curated": return [path.join(dataRoot, "curated")];
    case "project-state": return [path.join(dataRoot, "project-state")];
    case "document": return [path.join(dataRoot, "evidence", "documents")];
    case "tool": return [path.join(dataRoot, "tools-memory")];
    case "plan": return [path.join(dataRoot, "plans")];
    case "profile": return [path.join(dataRoot, "profile")];
    case "raw":
    case "conversation-evidence": return [path.join(dataRoot, "evidence", "conversations")];
    default: return [path.join(dataRoot, "curated"), path.join(dataRoot, "project-state"), path.join(dataRoot, "tools-memory"), path.join(dataRoot, "plans"), path.join(dataRoot, "profile"), path.join(dataRoot, "evidence", "documents"), path.join(dataRoot, "evidence", "conversations")];
  }
}

// --- default search roots — D29 seven searchable layers -------------------------
export function defaultSearchRoots(dataRoot) {
  return [
    path.join(dataRoot, "curated"),
    path.join(dataRoot, "project-state"),
    path.join(dataRoot, "tools-memory"),
    path.join(dataRoot, "plans"),
    path.join(dataRoot, "profile"),
    path.join(dataRoot, "evidence", "documents"),
    path.join(dataRoot, "evidence", "conversations"),
  ];
}
