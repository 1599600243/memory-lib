import fs from "node:fs/promises";
import { parseFrontmatterTyped, unquote } from "./frontmatter-util.mjs";

export function normalizeSourceTrust(value) {
  const text = unquote(value).trim();
  if (!text) return "";
  // frontmatter 里通常写双引号（JSON），但手写文件可能出现单引号；两种都剥掉
  if (text.length > 1 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).trim();
  return text;
}

// 读侧 source_trust 取值器：带 mtime+size 缓存。
// 背景：库里 2000+ 个历史记忆没有 source_trust 字段，旧实现对每次请求的每个命中项都读一遍盘。
// 这里只缓存"文件没变过"的结果；文件一改（mtime/size 变）就重新读，不会把旧值当新值。
export function createSourceTrustReader({ readFile = fs.readFile, stat = fs.stat, maxEntries = 5000, ttlMs = 2000 } = {}) {
  const cache = new Map();
  const limit = Math.max(1, Number(maxEntries) || 5000);
  const ttl = Math.max(0, Number(ttlMs) || 0);

  async function readTrust(filePath, mtimeMs, size) {
    const cached = cache.get(filePath);
    const now = Date.now();
    // TTL 内直接命中（连 stat 都不做）；文件记忆基本不变，2 秒窗口足够安全
    if (cached && ttl > 0 && now - cached.checkedAt < ttl) return cached.trust;
    if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
      cached.checkedAt = now;
      return cached.trust;
    }
    let trust = "unknown";
    try {
      const parsed = parseFrontmatterTyped(await readFile(filePath, "utf8"));
      const normalized = normalizeSourceTrust(parsed?.frontmatter?.source_trust ?? "");
      if (normalized) trust = normalized;
    } catch {
      trust = "unknown";
    }
    if (cache.size >= limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(filePath, { mtimeMs, size, trust, checkedAt: now });
    return trust;
  }

  return {
    async trustOf(filePath) {
      if (typeof filePath !== "string" || !filePath) return "unknown";
      const cached = cache.get(filePath);
      if (cached && ttl > 0 && Date.now() - cached.checkedAt < ttl) return cached.trust;
      let info;
      try { info = await stat(filePath); } catch { return "unknown"; }
      return readTrust(filePath, info.mtimeMs, info.size);
    },
    clear() { cache.clear(); },
    get size() { return cache.size; },
  };
}
