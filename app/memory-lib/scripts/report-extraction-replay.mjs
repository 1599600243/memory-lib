// R5/R6 read-only replay report.
// Reads an inbox tree, never writes production data, and reports only aggregate counts.
import fs from "node:fs/promises";
import path from "node:path";
import { classifyCandidateChatter, splitInboxDocument } from "../src/extraction-quality.mjs";

const inboxRoot = path.resolve(process.argv[2] ?? "I:\\OpenClaw\\memory-data\\memory\\inbox");
const names = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && entry.name.endsWith(".md")) names.push(file);
  }
}
await walk(inboxRoot);
let oldSurvivors = 0;
let newSurvivors = 0;
let oldProcessSurvivors = 0;
let newProcessSurvivors = 0;
let candidates = 0;
for (const file of names) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const { frontmatter, body } = splitInboxDocument(text);
  const content = body.replace(/^#\s*Candidate Memory\s*$/m, "").trim();
  const reviewState = String(frontmatter.reviewState ?? "pending").toLowerCase();
  const status = String(frontmatter.status ?? "proposed").toLowerCase();
  if (!content || status === "rejected" || ["rejected", "quarantined", "approved", "promoted"].includes(reviewState)) continue;
  candidates += 1;
  const processHits = classifyCandidateChatter(content).processHits;
  const oldDrop = (processHits >= 2 && classifyCandidateChatter(content).strongHits === 0)
    || (processHits >= 1 && classifyCandidateChatter(content).strongHits === 0 && classifyCandidateChatter(content).moderateHits === 0);
  const newDrop = classifyCandidateChatter(content).drop;
  if (!oldDrop) {
    oldSurvivors += 1;
    if (processHits >= 1) oldProcessSurvivors += 1;
  }
  if (!newDrop) {
    newSurvivors += 1;
    if (processHits >= 1) newProcessSurvivors += 1;
  }
}
console.log(JSON.stringify({ inboxRoot, pendingCandidates: candidates, oldGate: { survivors: oldSurvivors, processFragmentSurvivors: oldProcessSurvivors }, newGate: { survivors: newSurvivors, processFragmentSurvivors: newProcessSurvivors }, productionDataWritten: false }, null, 2));
