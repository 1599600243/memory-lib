// stats.mjs —— 记忆库全库统计（只读，文件为真相）
//
// 为什么单独一个模块：控制台概览页要一次拿到"谁有多少条、可见性分布、来源分布、异常项"，
// SQLite 索引只覆盖已索引文件，而概览必须能看见"没索引的"和"索引失败的"，所以直接扫文件。
// 1880 个 md 全扫约 100–200ms，按请求节流（默认 15 秒缓存）足够。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const CACHE_MS = 15_000;
let cache = { at: 0, key: "", value: null };

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return fm;
}

function sourceOf(fm) {
  const ev = String(fm.evidence_refs ?? "").toLowerCase();
  if (ev.includes("napcat-group")) return "群聊";
  if (ev.includes("napcat")) return "私聊(QQ)";
  if (ev.includes("session-") || ev.includes("dsh-session")) return "DSH 会话";
  if (ev.includes("soul")) return "灵魂包";
  if (ev.includes("runtime-event")) return "运行时事件";
  return "其他/历史迁移";
}

export async function collectStats(dataRoot) {
  const key = dataRoot;
  if (cache.value && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

  const curatedDir = path.join(dataRoot, "curated", "shared");
  const evidenceDir = path.join(dataRoot, "evidence", "conversations");

  const files = await walk(curatedDir);
  const byUserId = {};
  const byVisibility = {};
  const bySource = {};
  const byLayer = {};
  const checks = { missingUserId: 0, badVisibility: 0, missingEvidence: 0 };
  let oldest = null;
  let newest = null;

  const counts = new Map();
  for (const f of files) {
    let text;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    const fm = frontmatter(text);
    const uid = (fm.user_id ?? "").trim();
    const vis = (fm.visibility ?? "").trim();
    if (!uid) checks.missingUserId += 1;
    if (vis && !["user", "private", "shared", "project", "agent", "platform", "role", "daily"].includes(vis)) checks.badVisibility += 1;
    if (!fm.evidence_refs) checks.missingEvidence += 1;

    byUserId[uid || "(缺失)"] = (byUserId[uid || "(缺失)"] ?? 0) + 1;
    counts.set(uid || "(缺失)", (counts.get(uid || "(缺失)") ?? 0) + 1);
    byVisibility[vis || "(缺失)"] = (byVisibility[vis || "(缺失)"] ?? 0) + 1;
    byLayer[fm.layer || "(缺失)"] = (byLayer[fm.layer || "(缺失)"] ?? 0) + 1;
    const src = sourceOf(fm);
    bySource[src] = (bySource[src] ?? 0) + 1;

    const t = fm.occurred_at || fm.updated_at;
    if (t) {
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) {
        if (!oldest || d < oldest) oldest = d;
        if (!newest || d > newest) newest = d;
      }
    }
  }

  const evidenceFiles = await walk(evidenceDir);

  const value = {
    generatedAt: new Date().toISOString(),
    totals: { memories: files.length, evidence: evidenceFiles.length },
    identities: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([userId, stored]) => ({ userId, stored })),
    byVisibility,
    byLayer,
    sources: Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    checks: [
      { name: "user_id 为空", count: checks.missingUserId, level: checks.missingUserId === 0 ? "ok" : "warn" },
      { name: "非法 visibility", count: checks.badVisibility, level: checks.badVisibility === 0 ? "ok" : "bad" },
      { name: "缺 evidence_refs", count: checks.missingEvidence, level: checks.missingEvidence === 0 ? "ok" : "warn" },
    ],
    range: {
      oldest: oldest ? oldest.toISOString().slice(0, 10) : null,
      newest: newest ? newest.toISOString().slice(0, 10) : null,
    },
  };

  cache = { at: Date.now(), key, value };
  return value;
}

// 按身份列出记忆（管理端用）：扫 curated/shared，按 user_id 过滤，按时间倒序。
// 这是 /v1/memory/list 不满足的地方——list 只返回调用者自己授权范围里的最近 N 条，
// 想"看米汐记了什么"必须由服务端按身份扫，否则前端过滤永远为空。
export async function listByIdentity(dataRoot, userId, { limit = 200, offset = 0 } = {}) {
  const curatedDir = path.join(dataRoot, "curated", "shared");
  const files = await walk(curatedDir);
  const rows = [];
  for (const f of files) {
    let text;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    const fm = frontmatter(text);
    if ((fm.user_id ?? "").trim() !== userId) continue;
    const bodyMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const body = (bodyMatch ? bodyMatch[1] : text).trim();
    rows.push({
      id: fm.id ?? path.basename(f, ".md"),
      path: f,
      frontmatter: fm,
      body,
      updatedAt: fm.updated_at || fm.occurred_at || null,
    });
  }
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Math.min(500, Number(limit) || 200));
  return { total: rows.length, items: rows.slice(start, start + size) };
}

// 管理员用的全库字面命中检索：不按身份过滤，正文/frontmatter 里出现关键词即命中。
// 与 /v1/search 的分工：search 是语义检索且遵守身份隔离；find 是"我记得有就能找到"。
export async function findMemories(dataRoot, query, { limit = 100 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { total: 0, items: [] };
  const curatedDir = path.join(dataRoot, "curated", "shared");
  const files = await walk(curatedDir);
  const hits = [];
  for (const f of files) {
    let text;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    if (!text.toLowerCase().includes(q)) continue;
    const fm = frontmatter(text);
    const bodyMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const body = (bodyMatch ? bodyMatch[1] : text).trim();
    hits.push({
      id: fm.id ?? path.basename(f, ".md"),
      path: f,
      frontmatter: fm,
      body,
      matchedIn: body.toLowerCase().includes(q) ? "body" : "frontmatter",
      updatedAt: fm.updated_at || fm.occurred_at || null,
    });
  }
  hits.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  return { total: hits.length, items: hits.slice(0, size) };
}
