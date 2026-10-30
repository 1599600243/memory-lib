// memory-lib — 共享 frontmatter 工具（D2）。
// 所有值用 JSON 编码（字符串带引号、null 为 null、数组为 [...]），读回时 JSON.parse 还原；
// 与 read-only-core 的 verbatim parseFrontmatter（平文本）并存，互不影响。
export function unquote(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

function parseValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "null") return null;
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 解析带类型 frontmatter；body 为 frontmatter 之后的正文。
export function parseFrontmatterTyped(text) {
  const match = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: String(text ?? "") };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = parseValue(line.slice(idx + 1).trim());
  }
  return { frontmatter, body: String(text ?? "").slice(match[0].length) };
}

// entries: [[key, value], ...]；所有值 JSON 编码。
export function renderFrontmatter(entries) {
  const lines = ["---"];
  for (const [key, value] of entries) {
    const normalized = typeof value === "string" ? unquote(value) : value;
    lines.push(`${key}: ${normalized === undefined ? "null" : JSON.stringify(normalized)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

// Update only named frontmatter fields while preserving all existing header lines.
export function updateFrontmatterFields(text, updates = {}, removeKeys = []) {
  const match = String(text ?? "").match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/u);
  if (!match) return String(text ?? "");
  const remove = new Set(removeKeys);
  const changed = new Set(Object.keys(updates));
  const lines = match[2].split(/\r?\n/u);
  const output = [];
  const seen = new Set();
  for (const line of lines) {
    const index = line.indexOf(":");
    const key = index < 0 ? null : line.slice(0, index).trim();
    if (!key || (!changed.has(key) && !remove.has(key))) {
      output.push(line);
      continue;
    }
    if (remove.has(key) && !changed.has(key)) continue;
    if (changed.has(key)) {
      output.push(`${line.slice(0, index + 1)} ${updates[key]}`);
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) output.push(`${key}: ${value}`);
  }
  return `${match[1]}${output.join("\n")}${match[3]}${String(text ?? "").slice(match[0].length)}`;
}

// 把「段落正文」切成 { 标题 -> 正文 }（`## 标题` 之后的文本）。
export function parseSections(body, headings) {
  const out = {};
  for (const h of headings) out[h] = "";
  let current = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) {
      current = headings.includes(m[1].trim()) ? m[1].trim() : null;
    } else if (current !== null) {
      out[current] += `${line}\n`;
    }
  }
  for (const h of headings) out[h] = out[h].trim();
  return out;
}

export function slugify(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unnamed";
}
