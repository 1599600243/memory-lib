export function requireEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new Error("evidence_refs must be a non-empty string array");
  }
  return [...new Set(value.map((ref) => ref.trim()))];
}
