// 标识符重排：查询里如果有 MAINT7 / TZ-CONFIG-1 / canSeePath 这类拉丁标识符，
// 候选里正文命中它的往前排。不换模型、不加依赖，只改最后一步排序。
export const IDENTIFIER_PATTERN = /[A-Za-z][A-Za-z0-9._-]{2,}/gu;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "what", "why", "when", "where", "this", "that",
  "from", "into", "about", "are", "was", "were", "has", "have", "not", "but", "you", "your",
]);

export function queryIdentifiers(query) {
  const found = String(query ?? "").match(IDENTIFIER_PATTERN) ?? [];
  const unique = new Set();
  for (const raw of found) {
    const value = raw.toLowerCase();
    if (value.length < 3 || STOPWORDS.has(value)) continue;
    unique.add(value);
  }
  return [...unique];
}

export function identifierHits(text, identifiers) {
  if (!identifiers?.length) return 0;
  const lower = String(text ?? "").toLowerCase();
  let hits = 0;
  for (const id of identifiers) if (lower.includes(id)) hits += 1;
  return hits;
}

// score = 1/(名次) + 命中数 × boost：保持原有排序信息，只让"正文真的提到该标识符"的往前
export async function rerankByIdentifiers(results, identifiers, readText, { boost = 1 } = {}) {
  if (!Array.isArray(results) || results.length <= 1 || !identifiers?.length) return results ?? [];
  const scored = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const file = String(result?.path ?? result?.id ?? "");
    let text = "";
    try { text = String(await readText(file)); } catch { text = ""; }
    const hits = identifierHits(text, identifiers);
    scored.push({ result, hits, score: 1 / (index + 1) + hits * boost });
  }
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
  return scored.map((entry) => entry.result);
}

export function identifierRerankEnabled(options = {}) {
  if (options?.identifierRerank === false) return false;
  return process.env.MEMORY_IDENTIFIER_RERANK !== "0";
}
