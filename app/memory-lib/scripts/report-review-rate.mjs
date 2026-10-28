// R6 review-rate report.
// File-state counts are a reproducible snapshot, not a reconstructed historical event stream:
// old inbox documents do not retain every transition timestamp. The report therefore labels the
// denominator and excludes pending/quarantined entries instead of inventing decisions.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ""));
  const result = {};
  if (!match) return result;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (pair) result[pair[1]] = pair[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}

async function listMarkdown(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
    }
  }
  await walk(root);
  return files;
}

function withinWindow(value, from, to) {
  if (!value) return !from && !to;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return !from && !to;
  if (from && time < Date.parse(from)) return false;
  if (to && time >= Date.parse(to)) return false;
  return true;
}

export async function summarizeReviewStates(root, { from = null, to = null } = {}) {
  const counts = { rejected: 0, reviewed: 0, pending: 0, quarantined: 0, other: 0 };
  let files = 0;
  for (const file of await listMarkdown(root)) {
    const frontmatter = parseFrontmatter(await fs.readFile(file, "utf8").catch(() => ""));
    const observedAt = frontmatter.updatedAt || frontmatter.createdAt || null;
    if (!withinWindow(observedAt, from, to)) continue;
    files += 1;
    const state = String(frontmatter.reviewState ?? "missing").toLowerCase();
    if (Object.hasOwn(counts, state)) counts[state] += 1;
    else counts.other += 1;
  }
  const denominator = counts.rejected + counts.reviewed;
  return {
    root,
    window: { from, to, timestampField: "updatedAt || createdAt" },
    files,
    counts,
    reviewToReject: {
      numerator: counts.rejected,
      denominator,
      rate: denominator ? counts.rejected / denominator : null,
      definition: "rejected / (rejected + reviewed); pending and quarantined excluded",
      source: "persisted frontmatter snapshot, not a complete transition history",
    },
  };
}

export async function summarizeAutoReviewAudit(auditPath, { from = null, to = null } = {}) {
  const counts = { approve: 0, promote: 0, reject: 0, leave: 0, other: 0 };
  for (const line of (await fs.readFile(auditPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.channel !== "auto-review" || !withinWindow(event.ts, from, to)) continue;
    const decision = String(event.decision ?? "other");
    if (Object.hasOwn(counts, decision)) counts[decision] += 1;
    else counts.other += 1;
  }
  const denominator = counts.approve + counts.promote + counts.reject + counts.leave;
  return {
    auditPath,
    counts,
    decisionRejectRate: {
      numerator: counts.reject,
      denominator,
      rate: denominator ? counts.reject / denominator : null,
      definition: "auto-review reject / all recorded auto-review decisions",
      source: "channel:auto-review audit records",
    },
  };
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function numberAfter(args, name) {
  const value = Number(valueAfter(args, name));
  return Number.isFinite(value) ? value : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = valueAfter(args, "--root") ?? "I:\\OpenClaw\\memory-data\\memory";
  const auditPath = valueAfter(args, "--audit") ?? path.join(root, "runtime", "audit", "access.jsonl");
  const from = valueAfter(args, "--from");
  const to = valueAfter(args, "--to");
  const fileTruth = await summarizeReviewStates(root, { from, to });
  const autoReview = await summarizeAutoReviewAudit(auditPath, { from, to });
  const baselineRejected = numberAfter(args, "--baseline-rejected");
  const baselineReviewed = numberAfter(args, "--baseline-reviewed");
  const baselineDenominator = baselineRejected !== null && baselineReviewed !== null ? baselineRejected + baselineReviewed : 0;
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    fileTruth,
    autoReview,
    ...(baselineDenominator ? {
      suppliedHistoricalBaseline: {
        rejected: baselineRejected,
        reviewed: baselineReviewed,
        denominator: baselineDenominator,
        rate: baselineRejected / baselineDenominator,
        note: "Caller-supplied legacy window; not inferred from current files",
      },
    } : {}),
    productionDataWritten: false,
  }, null, 2));
}
