// F3 reproducible comparison: compare dry-run and actual auto-review audit lines.
// Usage: node scripts/auto-review-dry-run-compare.mjs --audit dry.jsonl --audit actual.jsonl
//
// Candidate ids differ across independent proposals, so dry-run and actual runs cannot
// be paired by resourceId. The audit contract carries only decision metadata (decision,
// rule, dryRun); the parity check that matters is whether the two modes produced the SAME
// multiset of (decision, rule) verdicts for the same candidate set. This script aggregates by
// (decision, rule) and never prints candidate content or credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function compareDryRunAudit(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const buckets = { dryRun: new Map(), actual: new Map() };
  for (const line of list) {
    if (!line || line.channel !== "auto-review") continue;
    const bucket = line.dryRun === true ? buckets.dryRun : line.dryRun === false ? buckets.actual : null;
    if (!bucket) continue;
    const key = JSON.stringify([line.decision ?? null, line.rule ?? null]);
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  const pairs = [];
  const mismatches = [];
  const missing = [];
  for (const key of new Set([...buckets.dryRun.keys(), ...buckets.actual.keys()])) {
    const [decision, rule] = JSON.parse(key);
    const dryRun = buckets.dryRun.get(key) ?? 0;
    const actual = buckets.actual.get(key) ?? 0;
    const pair = { decision, rule, dryRun, actual };
    pairs.push(pair);
    if (dryRun === 0 || actual === 0) missing.push(pair);
    else if (dryRun !== actual) mismatches.push(pair);
  }
  pairs.sort((a, b) => JSON.stringify([a.decision, a.rule]).localeCompare(JSON.stringify([b.decision, b.rule])));
  return { pairs, mismatches, missing };
}

async function readAudit(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--audit" && args[i + 1]) files.push(args[++i]);
  const lines = (await Promise.all(files.map(readAudit))).flat();
  const result = compareDryRunAudit(lines);
  console.log(JSON.stringify(result, null, 2));
  console.log(result.mismatches.length === 0 && result.missing.length === 0 ? "AUTO_REVIEW_DRY_RUN_MATCH" : "AUTO_REVIEW_DRY_RUN_MISMATCH");
  process.exitCode = result.mismatches.length === 0 && result.missing.length === 0 ? 0 : 1;
}
