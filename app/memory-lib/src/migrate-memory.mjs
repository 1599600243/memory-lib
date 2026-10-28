import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterTyped, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { CONTAINERS } from "./container-policy.mjs";

const INDEX_ROOTS = ["curated/shared", "curated/agents", "project-state", "tools-memory", "plans", "profile", "evidence/documents"];
const DEFAULT_TENANT = "default";

function posix(value) { return String(value).split(path.sep).join("/"); }
function bodySha(text) { return crypto.createHash("sha256").update(parseFrontmatterTyped(text).body, "utf8").digest("hex"); }
function resolved(value) { return path.resolve(String(value)); }
function inside(parent, child) { const root = `${resolved(parent)}${path.sep}`; return resolved(child).startsWith(root); }
async function assertDirectory(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const stat = await fs.stat(value).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`${label} must be an existing directory: ${value}`);
}
function visibilityFor(container, prior) {
  if (container === "project") return "project";
  if (container === "tool" || container === "knowledge") return "platform";
  if (container === "role") return "role";
  return prior || "private";
}
export function layerForContainer(container) {
  const layers = { "long-term": "long-term", role: "role", project: "project", tool: "tool", plan: "plan", knowledge: "knowledge" };
  return layers[container] ?? null;
}
export function migrationContainer(relativePath) {
  const rel = posix(relativePath);
  if (rel.startsWith("curated/shared/")) return "long-term";
  if (rel.startsWith("curated/agents/")) return "role";
  if (rel.startsWith("project-state/")) return "project";
  if (rel.startsWith("tools-memory/")) return "tool";
  if (rel.startsWith("plans/")) return "plan";
  if (rel.startsWith("profile/")) return "long-term";
  if (rel.startsWith("evidence/documents/")) return "knowledge";
  return null;
}
export function classifyNoFrontmatter(relativePath, text) {
  const rel = posix(relativePath);
  if (rel === "project-state/README.md" || /(^|\/)README\.md$/iu.test(rel)) return { kind: "documentation", reason: "README documentation" };
  if (rel.startsWith("curated/agents/")) return { kind: "memory", reason: "agent memory path" };
  if (rel.startsWith("project-state/")) return { kind: "memory", reason: "project memory path" };
  return { kind: "documentation", reason: "outside migration roots" };
}
async function walk(root) {
  const out = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await visit(root).catch(() => {});
  return out.sort();
}
export async function planMigration({ dataRoot, tenantId = DEFAULT_TENANT } = {}) {
  if (!dataRoot) throw new Error("dataRoot is required");
  const rows = [];
  const classifications = [];
  for (const root of INDEX_ROOTS) {
    for (const filePath of await walk(path.join(dataRoot, ...root.split("/")))) {
      const relativePath = posix(path.relative(dataRoot, filePath));
      const original = await fs.readFile(filePath, "utf8");
      const parsed = parseFrontmatterTyped(original);
      if (!Object.keys(parsed.frontmatter).length) {
        const classification = classifyNoFrontmatter(relativePath, original);
        classifications.push({ file: relativePath, ...classification });
        if (classification.kind !== "memory") continue;
        const container = migrationContainer(relativePath);
      const layer = layerForContainer(container);
        const after = `---\ntenant_id: ${JSON.stringify(tenantId)}\ncontainer: ${JSON.stringify(container)}\nlayer: ${JSON.stringify(layer)}\nvisibility: ${JSON.stringify(visibilityFor(container, null))}\n---\n${original}`;
        rows.push({ file: relativePath, action: "classify-memory", changes: { tenant_id: [null, tenantId], container: [null, container], layer: [null, layer], visibility: [null, visibilityFor(container, null)] }, before: original, after, bodyShaBefore: bodySha(original), bodyShaAfter: bodySha(after) });
        continue;
      }
      const container = migrationContainer(relativePath);
      if (!container) continue;
      const updates = {};
      const changes = {};
      const layer = layerForContainer(container);
      if (parsed.frontmatter.tenant_id !== tenantId) { updates.tenant_id = JSON.stringify(tenantId); changes.tenant_id = [parsed.frontmatter.tenant_id ?? null, tenantId]; }
if (parsed.frontmatter.container !== container) { updates.container = JSON.stringify(container); changes.container = [parsed.frontmatter.container ?? null, container]; }
if (parsed.frontmatter.layer !== layer) { updates.layer = JSON.stringify(layer); changes.layer = [parsed.frontmatter.layer ?? null, layer]; }
      const visibility = visibilityFor(container, parsed.frontmatter.visibility);
      if (parsed.frontmatter.visibility !== visibility) { updates.visibility = JSON.stringify(visibility); changes.visibility = [parsed.frontmatter.visibility ?? null, visibility]; }
      if (!Object.keys(changes).length) continue;
      const after = updateFrontmatterFields(original, updates);
      rows.push({ file: relativePath, action: "update-frontmatter", changes, before: original, after, bodyShaBefore: bodySha(original), bodyShaAfter: bodySha(after) });
    }
  }
  return { tenantId, containers: [...CONTAINERS], rows, classifications };
}
export async function applyMigration({ dataRoot, plan, snapshotRoot } = {}) {
  if (!dataRoot || !plan) throw new Error("dataRoot and plan are required");
  await assertDirectory(dataRoot, "dataRoot");
  if (!snapshotRoot) throw new Error("snapshotRoot is required");
  if (inside(dataRoot, snapshotRoot)) throw new Error("snapshotRoot must be outside dataRoot");
  const snapshotStat = await fs.stat(snapshotRoot).catch(() => null);
  if (snapshotStat && !snapshotStat.isDirectory()) throw new Error(`snapshotRoot must be a directory: ${snapshotRoot}`);
  await fs.mkdir(snapshotRoot, { recursive: true });
  for (const row of plan.rows) {
    const source = path.join(dataRoot, ...row.file.split("/"));
    const backup = path.join(snapshotRoot, ...row.file.split("/"));
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(source, backup);
    if (row.before !== row.after) await fs.writeFile(source, row.after, "utf8");
  }
  return { changed: plan.rows.filter((row) => row.before !== row.after).length, snapshotRoot, bodySha256: plan.rows.map((row) => ({ file: row.file, before: row.bodyShaBefore, after: bodySha(row.after), same: row.bodyShaBefore === bodySha(row.after) })) };
}
export { DEFAULT_TENANT, INDEX_ROOTS };
