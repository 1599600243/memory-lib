import { candidateSimilarity } from "./extraction-quality.mjs";

export function rankCandidateNeighbors(candidate, memories, { topK = 10 } = {}) {
  const content = String(candidate ?? "").trim();
  return (Array.isArray(memories) ? memories : []).map((memory) => ({
    id: String(memory?.id ?? ""),
    path: String(memory?.path ?? ""),
    content: String(memory?.content ?? memory?.body ?? ""),
    score: Number.isFinite(Number(memory?.score)) && !memory?.content && !memory?.body ? Number(memory.score) : candidateSimilarity(content, String(memory?.content ?? memory?.body ?? "")),
  })).filter((row) => row.id && row.path).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(50, Number(topK) || 10)));
}
