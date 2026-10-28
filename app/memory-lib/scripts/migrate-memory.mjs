import fs from "node:fs/promises";
import path from "node:path";
import { applyMigration, planMigration } from "../src/migrate-memory.mjs";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
function option(name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
}
function actual(name, envName) { return option(name) ?? process.env[envName] ?? null; }
function resolved(value) { return path.resolve(String(value)); }
function inside(parent, child) { return resolved(child).startsWith(`${resolved(parent)}${path.sep}`); }
async function directory(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const stat = await fs.stat(value).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`${label} must be an existing directory: ${value}`);
}

const dataRoot = actual("--data-root", "MEMORY_DATA_ROOT");
const snapshotRoot = actual("--snapshot-root", "MEMORY_MIGRATION_SNAPSHOT");
try {
  if (apply) {
    await directory(dataRoot, "dataRoot");
    if (!snapshotRoot) throw new Error("snapshotRoot is required for --apply");
    if (inside(dataRoot, snapshotRoot)) throw new Error("snapshotRoot must be outside dataRoot");
    await fs.mkdir(snapshotRoot, { recursive: true });
  }
  const effectiveDataRoot = dataRoot ?? path.resolve(process.cwd(), "../../data/memory");
  const effectiveSnapshotRoot = snapshotRoot ?? `${effectiveDataRoot}.migration-snapshot`;
  const plan = await planMigration({ dataRoot: effectiveDataRoot });
  const output = {
    mode: apply ? "apply" : "dry-run",
    dataRoot: effectiveDataRoot,
    snapshotRoot: effectiveSnapshotRoot,
    tenant_id: plan.tenantId,
    rows: plan.rows.map(({ file, action, changes, bodyShaBefore, bodyShaAfter }) => ({ file, action, changes, body_sha256_before: bodyShaBefore, body_sha256_after: bodyShaAfter, body_sha256_same: bodyShaBefore === bodyShaAfter })),
    classifications: plan.classifications,
  };
  if (apply) output.apply = await applyMigration({ dataRoot: effectiveDataRoot, plan, snapshotRoot: effectiveSnapshotRoot });
  else if (argv.includes("--snapshot")) { await fs.mkdir(effectiveSnapshotRoot, { recursive: true }); output.snapshot_ready = effectiveSnapshotRoot; }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(`migration refused: ${error.message}`);
  process.exitCode = 1;
}
