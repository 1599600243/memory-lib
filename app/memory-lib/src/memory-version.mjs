import { candidateSimilarity } from "./extraction-quality.mjs";
import { timestampValue } from "./time-util.mjs";

export function compareMemoryVersions(a = {}, b = {}) {
  const similarity = candidateSimilarity(a.body ?? "", b.body ?? "");
  const aEvidence = new Set([...(a.evidence_refs ?? []), ...(a.source_episodes ?? [])].map(String));
  const bEvidence = new Set([...(b.evidence_refs ?? []), ...(b.source_episodes ?? [])].map(String));
  const aStamp = timestampValue(a.frontmatter ?? a, a.mtimeMs);
  const bStamp = timestampValue(b.frontmatter ?? b, b.mtimeMs);
  const aTime = Number.isFinite(aStamp.value) ? aStamp.value : (Date.parse(String(a.eventAt ?? 0)) || 0);
  const bTime = Number.isFinite(bStamp.value) ? bStamp.value : (Date.parse(String(b.eventAt ?? 0)) || 0);
  const evidenceComparison = aEvidence.size === bEvidence.size ? "equal" : aEvidence.size > bEvidence.size ? "a-more-complete" : "b-more-complete";
  const winner = bEvidence.size !== aEvidence.size ? (bEvidence.size > aEvidence.size ? "b" : "a") : (bTime >= aTime ? "b" : "a");
  return { same_fact: similarity >= 0.72, similarity, evidence_comparison: evidenceComparison, a_evidence_count: aEvidence.size, b_evidence_count: bEvidence.size, a_time: aTime, b_time: bTime, winner, reason: similarity >= 0.72 ? "similarity-plus-evidence-and-time" : "distinct-facts" };
}
