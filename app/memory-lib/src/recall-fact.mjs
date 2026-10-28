// Shared extraction rule for INDEX-2 statistics and recall ranking.
// Keep this as the single definition so the persistent index counts the exact
// same fact text that recall.mjs scores.

/** 记忆正文里“那一句话事实” = frontmatter 之后第一个非引用段落。 */
export function memoryFactOf(body) {
  for (const block of String(body ?? "").split(/\n{2,}/u)) {
    const cleaned = block
      .split(/\r?\n/u)
      .filter((line) => !/^\s*>/u.test(line))
      .join("\n")
      .replace(/^#+\s*/u, "")
      .trim();
    if (cleaned) return cleaned.replace(/\s+/gu, " ");
  }
  return "";
}
