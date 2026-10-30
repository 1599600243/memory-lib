function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, digits = 6) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return null;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]); const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b; leftNorm += a * a; rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function summarizePairScores(rows) {
  const synonym = rows.filter((row) => row.label === "synonym").map((row) => Number(row.score)).filter(Number.isFinite);
  const unrelated = rows.filter((row) => row.label === "unrelated").map((row) => Number(row.score)).filter(Number.isFinite);
  const values = [...synonym.map((score) => ({ score, positive: true })), ...unrelated.map((score) => ({ score, positive: false }))].sort((a, b) => a.score - b.score);
  const thresholds = [...new Set([0, 1, ...values.map((row) => row.score), ...values.slice(1).map((row, index) => (row.score + values[index].score) / 2)])].sort((a, b) => a - b);
  let best = { accuracy: 0, threshold: null };
  for (const threshold of thresholds) {
    const correct = values.filter((row) => (row.score >= threshold) === row.positive).length;
    const accuracy = values.length ? correct / values.length : 0;
    if (accuracy > best.accuracy || (accuracy === best.accuracy && (best.threshold === null || threshold < best.threshold))) best = { accuracy, threshold };
  }
  let concordant = 0; let ties = 0; const positiveCount = synonym.length; const negativeCount = unrelated.length;
  for (const positive of synonym) for (const negative of unrelated) {
    if (positive > negative) concordant += 1;
    else if (positive === negative) ties += 1;
  }
  return {
    synonymCount: synonym.length,
    unrelatedCount: unrelated.length,
    meanSynonym: round(mean(synonym)),
    meanUnrelated: round(mean(unrelated)),
    gap: synonym.length && unrelated.length ? round(mean(synonym) - mean(unrelated)) : null,
    bestThreshold: round(best.threshold),
    bestThresholdAccuracy: round(best.accuracy),
    auc: positiveCount && negativeCount ? round((concordant + ties / 2) / (positiveCount * negativeCount)) : null,
  };
}

export function summarizeRetrieval(rows) {
  const count = rows.length;
  const reciprocalRanks = rows.map((row) => {
    const rank = row.ranked.findIndex((path) => path === row.expected);
    return rank < 0 ? 0 : 1 / (rank + 1);
  });
  const recall = (limit) => count ? rows.filter((row) => row.ranked.slice(0, limit).includes(row.expected)).length / count : 0;
  const falsePositive = count ? rows.filter((row) => !row.ranked.slice(0, 3).includes(row.expected)).length / count : 0;
  return {
    queryCount: count,
    mrr: round(mean(reciprocalRanks) ?? 0),
    recallAt1: round(recall(1)),
    recallAt3: round(recall(3)),
    recallAt5: round(recall(5)),
    top3FalsePositiveRate: round(falsePositive),
  };
}
