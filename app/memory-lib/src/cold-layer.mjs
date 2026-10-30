import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { parseFrontmatterTyped, renderFrontmatter, unquote, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { readTimestamp } from "./time-util.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const DEFAULT_ROOTS = ["curated", "project-state", "tools-memory", "plans", "profile"];

export function createColdLayer({ dataRoot, countFor = async () => 0, audit = null, now = () => Date.now(), roots = DEFAULT_ROOTS, backupAvailable = null } = {}) {
  if (!dataRoot) throw new Error("cold layer requires dataRoot");
  const isoNow = () => new Date(now()).toISOString();

  async function atomicMove(source, target, content) {
    // ATOMICWRITE-1：写目标走统一助手（含建目录 + rename 重试），成功后再删源文件。
    // 顺序刻意不变：先保证目标写成功，才删源 —— 中途失败不会两头都没有。
    await atomicWriteFile(target, content);
    await fs.unlink(source);
  }

  async function allFiles(root) {
    const out = [];
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const filePath = path.join(root, entry.name);
      if (entry.isDirectory()) out.push(...await allFiles(filePath));
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") out.push(filePath);
    }
    return out;
  }

  async function inventory() {
    const counts = { cold: 0, byLayer: {} };
    for (const rootName of roots) {
      for (const filePath of await allFiles(path.join(dataRoot, rootName))) {
        if (!filePath.split(path.sep).some((part) => part.startsWith("_cold-"))) continue;
        counts.cold += 1;
        const layer = rootName === "project-state" ? "project-state" : rootName === "curated" ? "curated" : rootName;
        counts.byLayer[layer] = (counts.byLayer[layer] ?? 0) + 1;
      }
    }
    return counts;
  }

  async function candidates() {
    const out = [];
    for (const rootName of roots) {
      for (const filePath of await walkFiles(path.join(dataRoot, rootName))) {
        const text = await readTextFile(filePath);
        if (!text) continue;
        const parsed = parseFrontmatterTyped(text);
        const fm = parsed.frontmatter;
        if (fm.status !== "active") continue;
        out.push({ id: fm.id ? unquote(fm.id) : null, path: filePath, frontmatter: fm, body: parsed.body });
      }
    }
    return out;
  }

  async function cleanupCandidates({ olderThanDays = 90, maxRecallCount = 0 } = {}) {
    const cutoff = now() - olderThanDays * 24 * 60 * 60 * 1000;
    const out = [];
    for (const rootName of roots) {
      for (const filePath of await allFiles(path.join(dataRoot, rootName))) {
        if (!filePath.split(path.sep).some((part) => part.startsWith("_cold-"))) continue;
        const parsed = parseFrontmatterTyped(await readTextFile(filePath));
        if (parsed.frontmatter.status !== "cold" || !parsed.frontmatter.id) continue;
        const date = Date.parse(String(parsed.frontmatter.cold_since ?? parsed.frontmatter.updated_at ?? ""));
        const recallCount = Number(await countFor(filePath)) || 0;
        if (Number.isFinite(date) && date <= cutoff && recallCount <= maxRecallCount) out.push({ id: String(parsed.frontmatter.id), path: filePath, layer: layerFor(filePath), recallCount, age_days: Math.floor((now() - date) / 86400000) });
      }
    }
    return out;
  }

  async function cold({ olderThanDays = 90, maxRecallCount = 0 } = {}) {
    const cutoff = now() - olderThanDays * 24 * 60 * 60 * 1000;
    const items = [];
    const refresh_candidates = [];
    const skipped = { not_expired: 0, high_recall: 0, unparsable_time: 0, missing_id: 0 };
    for (const item of await candidates()) {
      const timestamp = await readTimestamp(item.frontmatter, item.path);
      const date = timestamp.value;
      if (!item.id) { skipped.missing_id += 1; continue; }
      if (!Number.isFinite(date)) { skipped.unparsable_time += 1; continue; }
      if (date > cutoff) { skipped.not_expired += 1; continue; }
      const recallCount = Number(await countFor(item.path)) || 0;
      if (recallCount > maxRecallCount) {
        refresh_candidates.push({ id: item.id, path: item.path, recallCount, reason: "frequently-borrowed-old" });
        skipped.high_recall += 1;
        continue;
      }
      const relative = path.relative(dataRoot, item.path);
      const parts = relative.split(path.sep);
      parts[parts.length - 1] = `_cold-${new Date(now()).toISOString().slice(0, 10)}`;
      parts.push(path.basename(item.path));
      const target = path.join(dataRoot, ...parts);
      const movedContent = updateFrontmatterFields(await readTextFile(item.path), {
        status: "cold",
        cold_since: isoNow(),
        cold_reason: "old-and-zero-recall",
        cold_original_path: item.path,
      });
      await atomicMove(item.path, target, movedContent);
      const event = { channel: "librarian", action: "cold", allow: true, resourceId: item.id, source: item.path, target, reason: "old-and-zero-recall", recallCount, updatedAt: isoNow() };
      if (audit?.record) await audit.record(event);
      items.push({ id: item.id, source: item.path, target, recallCount, reason: event.reason });
    }
    return { cold: items.length, items, refresh_candidates, skipped };
  }

  async function refresh(id, { reason = "explicit-refresh", body = null, evidence_refs = [], source_episodes = [], principal = null } = {}) {
    const stack = roots.map((rootName) => path.join(dataRoot, rootName));
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(filePath); continue; }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
        const text = await readTextFile(filePath);
        const parsed = parseFrontmatterTyped(text);
        if (unquote(parsed.frontmatter.id) !== unquote(id) || parsed.frontmatter.status !== "cold") continue;
        const original = parsed.frontmatter.cold_original_path;
        const target = original && path.isAbsolute(original) ? original : path.join(dataRoot, String(original ?? ""));
        if (!target || target === filePath || !target.startsWith(path.resolve(dataRoot))) throw new Error("cold refresh target is invalid");
        const entriesOut = Object.entries(parsed.frontmatter).filter(([key]) => !["status", "refreshed_at", "refresh_reason", "evidence_refs", "source_episodes"].includes(key));
        entriesOut.push(["status", "active"], ["refreshed_at", isoNow()], ["refresh_reason", reason], ["evidence_refs", [...new Set([...(parsed.frontmatter.evidence_refs ?? []), ...evidence_refs])]], ["source_episodes", [...new Set([...(parsed.frontmatter.source_episodes ?? []), ...source_episodes])]]);
        const output = renderFrontmatter(entriesOut) + (body ?? parsed.body);
        await atomicMove(filePath, target, output);
        const event = { channel: "librarian", action: "refresh", allow: true, resourceId: String(id), source: filePath, target, reason, evidence_refs: [...new Set([...(parsed.frontmatter.evidence_refs ?? []), ...evidence_refs])], source_episodes: [...new Set([...(parsed.frontmatter.source_episodes ?? []), ...source_episodes])] };
        if (audit?.record) await audit.record(event);
        return { id: String(id), source: filePath, target, frontmatter: parseFrontmatterTyped(output).frontmatter, body: body ?? parsed.body };
      }
    }
    return null;
  }

  const purgePreviews = new Map();

  function purgeAuthorized(principal) {
    const role = String(principal?.role_id ?? "").toLowerCase();
    return role === "admin" || role === "librarian" || role.startsWith("librarian-") || role.endsWith("-admin");
  }

  async function purge({ ids, reason, dry_run = true, principal } = {}) {
    if (!purgeAuthorized(principal)) return { status: "rejected", reason: "ROLE_REQUIRED", message: "purge requires admin or librarian identity" };
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) return { status: "rejected", reason: "EXPLICIT_IDS_REQUIRED", message: "provide a non-empty, duplicate-free ids list" };
    if (typeof reason !== "string" || !reason.trim()) return { status: "rejected", reason: "REASON_REQUIRED", message: "reason is required" };
    const items = [];
    for (const id of ids) {
      const found = await retrieve(id);
      if (!found) { items.push({ id, eligible: false, reason: "NOT_FOUND" }); continue; }
      const filePath = await findPathById(id);
      const isColdPath = filePath.split(path.sep).some((part) => part.startsWith("_cold-"));
      if (found.frontmatter.status !== "cold" && !isColdPath) items.push({ id, path: filePath, layer: layerFor(filePath), eligible: false, reason: "NOT_COLD" });
      else items.push({ id, path: filePath, layer: layerFor(filePath), eligible: true });
    }
    if (items.some((item) => !item.eligible)) return { status: "rejected", reason: items.find((item) => !item.eligible)?.reason ?? "NOT_COLD", message: "all requested ids must resolve to cold-layer entries", items };
    const manifest = { ids: [...ids].sort(), reason: reason.trim(), items: items.map(({ id, path: itemPath, eligible }) => ({ id, path: itemPath, eligible })) };
    const previewKey = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    if (dry_run !== false) {
      purgePreviews.set(previewKey, now());
      const layers = {};
      for (const item of items) if (item.eligible) layers[item.layer] = (layers[item.layer] ?? 0) + 1;
      return { status: "dry-run", preview_id: previewKey, count: items.filter((item) => item.eligible).length, items, impact: { by_layer: layers } };
    }
    if (!purgePreviews.has(previewKey)) return { status: "rejected", reason: "DRY_RUN_REQUIRED", message: "run dry_run first with the same ids and reason", items };
    purgePreviews.delete(previewKey);
    if (items.some((item) => !item.eligible)) return { status: "rejected", reason: "NOT_ALL_COLD", message: "all requested ids must resolve to cold-layer entries", items };
    const backup = typeof backupAvailable === "function" ? await backupAvailable() : false;
    if (!(backup === true || backup?.available === true)) return { status: "rejected", reason: "BACKUP_UNAVAILABLE", message: "Memory-Archive-Daily backup is unavailable; deletion refused", backup: backup || null, items };
    const results = [];
    for (const item of items) {
      const current = await readTextFile(item.path);
      if (!current) { results.push({ id: item.id, deleted: false, reason: "CHANGED_OR_MISSING" }); continue; }
      const parsed = parseFrontmatterTyped(current);
      const coldPath = item.path.split(path.sep).some((part) => part.startsWith("_cold-"));
      if (parsed.frontmatter.status !== "cold" && !coldPath) { results.push({ id: item.id, deleted: false, reason: "NOT_COLD" }); continue; }
      await fs.unlink(item.path);
      const auditId = crypto.randomUUID();
      if (audit?.record) await audit.record({ channel: "purge", action: "purge", allow: true, resourceId: item.id, source: item.path, target: item.layer, reason: reason.trim(), agent: principal.agent_id, role: principal.role_id, audit_id: auditId, deleted_at: isoNow() });
      results.push({ id: item.id, path: item.path, layer: item.layer, deleted: true, audit_id: auditId, deleted_at: isoNow() });
    }
    return { status: "completed", count: results.filter((item) => item.deleted).length, items: results };
  }

  async function findPathById(id) {
    for (const rootName of roots) {
      for (const filePath of await allFiles(path.join(dataRoot, rootName))) {
        const parsed = parseFrontmatterTyped(await readTextFile(filePath));
        if (unquote(parsed.frontmatter.id) === unquote(id)) return filePath;
      }
    }
    return null;
  }

  function layerFor(filePath) {
    const relative = path.relative(dataRoot, filePath);
    const first = relative.split(path.sep)[0];
    return first === "project-state" ? "project-state" : first;
  }

  async function retrieve(id) {
    const stack = roots.map((rootName) => path.join(dataRoot, rootName));
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(filePath); continue; }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
        const text = await readTextFile(filePath);
        if (!text) continue;
        const parsed = parseFrontmatterTyped(text);
        if (String(parsed.frontmatter.id ?? "") === String(id)) return parsed;
      }
    }
    return null;
  }

  return { cold, refresh, retrieve, candidates, cleanupCandidates, inventory, purge };
}
