// 知识库文档列表：扫 evidence/documents 下的 Markdown（前端"知识文档"页的数据源）。
// 只读，不写任何文件；用 frontmatter 的 title/summary，没有就用首个标题或文件名。
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterTyped } from "./frontmatter-util.mjs";

async function walk(dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

function firstHeading(text) {
  const body = String(text).split(/^---\r?\n[\s\S]*?^---\r?\n/m).slice(-1)[0] ?? "";
  for (const line of body.split(/\r?\n/)) {
    const match = /^#{1,3}\s+(.+)$/u.exec(line.trim());
    if (match) return match[1].trim().slice(0, 80);
  }
  return "";
}

export async function listKnowledgeDocuments({ dataRoot }) {
  const root = path.join(dataRoot, "evidence", "documents");
  const files = await walk(root);
  const items = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text == null) continue;
    const stat = await fs.stat(file).catch(() => null);
    const { frontmatter } = parseFrontmatterTyped(text);
    const rel = path.relative(dataRoot, file).replaceAll("\\", "/");
    const title = String(frontmatter.title ?? firstHeading(text) ?? "").trim() || path.basename(file, ".md");
    items.push({
      id: String(frontmatter.id ?? path.basename(file, ".md")),
      path: rel,
      title,
      type: String(frontmatter.type ?? "document"),
      source: frontmatter.source ?? null,
      updated_at: frontmatter.updated_at ?? (stat ? new Date(stat.mtimeMs).toISOString() : null),
      size_bytes: stat?.size ?? null,
    });
  }
  items.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  return { count: items.length, items };
}
