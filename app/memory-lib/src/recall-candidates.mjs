// INDEX-1 — 注入侧的**候选粗筛**：用现成的增量索引（`indexes/sqlite/memory-lib-index.sqlite` 的
// `fts_chunks`，`tokenize="trigram"`）把「要从哪些文件里找」先缩下来，再把候选交给 recall.mjs
// **现有的**取值/打分/排序/打包逻辑。
//
// 为什么要有这一层（范围单 orders/INDEX-1-brief-use-incremental-index.md）：
//   `recentMemories()` 改前每轮都把 `curated/shared` 下所有 md 全读一遍（实测 1445 个文件 ⇒ 顺序读
//   约 195ms，整条 brief 链路 p50 222–300ms）。插件侧 brief 超时 3000ms，库按每天 +300 条增长，
//   约 3–4 周就会触到 ⇒ 注入开始**静默失败**。所以要在"从哪儿找候选"这一步借索引，而不是改排序。
//
// 三条硬规矩（对应范围单 §三）：
//   ① 粗筛只做**词面**：≥3 字片段走 trigram；短问句的 2 字 token 优先走 `recall_df_bigrams` 精确倒排，索引不完整时回退有界 LIKE；
//   ② **新鲜度兜底**：索引会落后。凡是磁盘上有、而索引（`files` 里 status='active'）从没见过的文件，
//      一律并入候选（上限 FRESH_LIMIT）—— 否则"刚写进去的那条"永远问不到；
//   ③ **回退**：索引缺失/损坏/查询报错/候选为空/候选填不满注入位数/新文件过多 ⇒ 由调用方退回全量扫描。
//
// 为什么是"填不满注入位数"也算回退：即使已有两字 LIKE 补候选，索引仍可能落后或因敏感块跳过内容。
// 当候选池小于注入位数时宁可慢一点，也要拿全量扫描的真实结果，绝不因为索引而少注入。
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexPathFor } from "./index-store.mjs";

/** 候选上限（范围单 §三-1 建议 ≤800）。 */
export const CANDIDATE_LIMIT = 800;
/** 索引没覆盖到的新文件上限；超过说明索引落后太多，直接回退全量扫描。 */
export const FRESH_LIMIT = 200;
/** 两字 LIKE 只作精确倒排不可安全使用时的兼容回退；超限就整轮回退。 */
export const LIKE_CANDIDATE_LIMIT = 200;
/** 一次 OR 最多几个片段（片段越多 OR 越慢，实测 12 个片段仍在 1–3ms 量级）。 */
export const MAX_PIECES = 24;

/**
 * 把 query 切成 **≥3 字**的片段（trigram 索引只认这个长度）。
 *   · 中文连续段 ⇒ 所有 3 字滑窗；· 拉丁/数字段（≥3 字符）⇒ 整段。
 * 返回去重后的片段数组（最多 `maxPieces` 个）。
 * 注意：**不要**把整句直接丢进 MATCH —— trigram 的 MATCH 是子串语义，整句几乎永远命中 0。
 */
export function twoCharacterTokens(query, { maxTokens = MAX_PIECES } = {}) {
  const text = String(query ?? "").toLowerCase().replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, "-");
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9._-]{1,}/gu) ?? []) {
    if ([...word].length === 2) tokens.add(word);
  }
  for (const run of text.match(/[\u4e00-\u9fa5\u3400-\u4dbf]+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  const compact = text.trim();
  if ([...compact].length === 2 && /^[a-z0-9\u4e00-\u9fa5\u3400-\u4dbf]{2}$/u.test(compact)) tokens.add(compact);
  return [...tokens].slice(0, Math.max(1, maxTokens));
}

export function trigramPieces(query, { maxPieces = MAX_PIECES } = {}) {
  const text = String(query ?? "").toLowerCase().replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, "-");
  const pieces = [];
  const push = (piece) => {
    if (piece.length >= 3 && !pieces.includes(piece)) pieces.push(piece);
  };
  for (const run of text.match(/[\u4e00-\u9fa5\u3400-\u4dbf]+/gu) ?? []) {
    for (let i = 0; i + 3 <= run.length; i += 1) push(run.slice(i, i + 3));
  }
  for (const run of text.match(/[a-z0-9][a-z0-9._-]{2,}/gu) ?? []) push(run.replace(/[._-]+$/u, ""));
  return pieces.slice(0, Math.max(1, maxPieces));
}

/** FTS5 字符串字面量：双引号包起来，内部引号翻倍（片段里的 `"` 不会破坏 MATCH 语法）。 */
function ftsLiteral(piece) {
  return `"${String(piece).replace(/"/gu, '""')}"`;
}

/** 磁盘上的 md 列表（**只列名字，不做 stat**：1445 个文件 stat 一遍要 70ms，列举只要 1ms）。 */
async function listDiskMarkdown(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 读不了的目录当作不存在
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("_")) stack.push(full); // 与 walkFiles 同一套冻结区规则
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out;
}

function posix(value) {
  return String(value).split(path.sep).join("/");
}

/** 一次只读查询：候选文件（按命中片段数降序）+ 索引已知的 active 路径集合。 */
function queryIndex(dbPath, pieces, twoChars, { limit, preferExactBigrams = false }) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { ok: false, reason: `index-open-failed:${String(e?.message ?? e).slice(0, 120)}` };
  }
  try {
    const ftsRows = pieces.length
      ? db.prepare("SELECT path, COUNT(*) AS hits FROM fts_chunks WHERE fts_chunks MATCH ? GROUP BY path ORDER BY hits DESC, path LIMIT ?")
        .all(pieces.map(ftsLiteral).join(" OR "), limit + 1)
      : [];
    if (ftsRows.length > limit) return { ok: false, reason: "fts-candidate-overflow" };

    let bigramRows = [];
    let likeRows = [];
    let usedExactBigrams = false;
    if (twoChars.length && preferExactBigrams) {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => String(row.name)));
      if (tables.has("recall_df_docs") && tables.has("recall_df_bigrams")) {
        const incomplete = db.prepare(`SELECT 1
          FROM files f LEFT JOIN recall_df_docs d ON d.file_id=f.id
          WHERE f.status='active' AND f.path LIKE 'curated/shared/%'
            AND (d.file_id IS NULL OR d.path<>f.path OR d.source_sha256<>f.sha256 OR d.complete<>1)
          LIMIT 1`).get();
        if (!incomplete) {
          const placeholders = twoChars.map(() => "?").join(",");
          bigramRows = db.prepare(`SELECT d.path, COUNT(DISTINCT p.token) AS hits
            FROM recall_df_bigrams p
            JOIN recall_df_docs d ON d.file_id=p.file_id
            JOIN files f ON f.id=p.file_id
            WHERE p.token IN (${placeholders}) AND d.complete=1 AND d.path=f.path
              AND d.source_sha256=f.sha256 AND f.status='active' AND f.path LIKE 'curated/shared/%'
            GROUP BY d.path ORDER BY hits DESC,d.path LIMIT ?`).all(...twoChars, limit + 1);
          if (bigramRows.length > limit) return { ok: false, reason: "bigram-candidate-overflow" };
          usedExactBigrams = true;
        }
      }
    }
    if (twoChars.length && !usedExactBigrams) {
      const likeLimit = Math.min(limit, LIKE_CANDIDATE_LIMIT);
      const score = twoChars.map(() => "MAX(CASE WHEN instr(lower(c.text),lower(?))>0 THEN 1 ELSE 0 END)").join(" + ");
      const where = twoChars.map(() => "instr(lower(c.text),lower(?))>0").join(" OR ");
      likeRows = db.prepare(`SELECT f.path, ${score} AS hits
        FROM chunks c JOIN files f ON f.id=c.file_id
        WHERE f.status='active' AND f.path LIKE 'curated/shared/%' AND (${where})
        GROUP BY f.path ORDER BY hits DESC,f.path LIMIT ?`)
        .all(...twoChars, ...twoChars, likeLimit + 1);
      if (likeRows.length > likeLimit) return { ok: false, reason: "like-candidate-overflow" };
    }

    const merged = new Map();
    for (const row of [...ftsRows, ...bigramRows, ...likeRows]) merged.set(String(row.path), (merged.get(String(row.path)) ?? 0) + Number(row.hits ?? 0));
    const rows = [...merged].map(([pathValue, hits]) => ({ path: pathValue, hits })).sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
    if (rows.length > limit) return { ok: false, reason: "combined-candidate-overflow" };
    const known = new Set(
      db.prepare("SELECT path FROM files WHERE status='active' AND path LIKE 'curated/shared/%'").all().map((r) => r.path),
    );
    return { ok: true, rows, known, ftsHits: ftsRows.length, bigramHits: bigramRows.length, likeHits: likeRows.length, usedExactBigrams };
  } catch (e) {
    return { ok: false, reason: `index-query-failed:${String(e?.message ?? e).slice(0, 120)}` };
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉也不影响结果 */
    }
  }
}

/**
 * 选出这一轮的候选文件。
 *
 * @param {object} options
 * @param {string} options.dataRoot 数据根（索引相对它定位）
 * @param {string} options.memoriesRoot 记忆目录（`dataRoot/curated/shared`）
 * @param {string|null} options.query 本轮问句
 * @param {number} options.wanted 这一轮最多要注入几条（候选填不满它就回退全量）
 * @returns {Promise<{mode:"candidates"|"full", source:"fts"|"mixed"|"full", paths:string[]|null,
 *   candidateFiles:number, scanMs:number, reason:string|null, pieces:number, indexHits:number, freshFiles:number}>}
 */
export async function selectCandidates({ dataRoot, memoriesRoot, query = null, wanted = 6, limit = CANDIDATE_LIMIT, freshLimit = FRESH_LIMIT } = {}) {
  if (!dataRoot) throw new Error("selectCandidates requires dataRoot");
  const started = performance.now();
  const done = (payload) => ({ ...payload, scanMs: Math.round((performance.now() - started) * 100) / 100 });

  const pieces = trigramPieces(query);
  const twoChars = twoCharacterTokens(query);
  const disk = await listDiskMarkdown(memoriesRoot);
  const diskByRel = new Map();
  for (const abs of disk) {
    const rel = posix(path.relative(dataRoot, abs));
    if (!rel || rel.startsWith("../")) continue;
    diskByRel.set(rel, abs);
  }
  const full = (reason) => done({ mode: "full", source: "full", paths: null, candidateFiles: disk.length, reason, pieces: pieces.length, twoCharTokens: twoChars.length, indexHits: 0, bigramHits: 0, likeHits: 0, freshFiles: 0 });

  if (!pieces.length && !twoChars.length) return full("no-indexable-token");

  // SHORT-Q-1：只在短 token 形态上优先走精确 bigram postings；有 trigram 的长问句保持原候选路径。
  const preferExactBigrams = pieces.length === 0 && twoChars.length > 0 && twoChars.length <= 2;
  const indexed = queryIndex(indexPathFor(dataRoot), pieces, twoChars, { limit, preferExactBigrams });
  if (!indexed.ok) return full(indexed.reason);

  // ① 索引候选：只要本库（curated/shared）且**磁盘上确实存在**的路径，保持"命中片段数降序"
  const ranked = [];
  for (const row of indexed.rows) {
    const rel = String(row?.path ?? "");
    if (!rel.startsWith("curated/shared/")) continue;
    const abs = diskByRel.get(rel);
    if (!abs) continue; // 索引里有、磁盘上没了（已删）⇒ 不是候选
    ranked.push(abs);
    if (ranked.length >= limit) break;
  }

  // ② 新鲜度兜底：磁盘上有、索引从没见过（或已被标 deleted）的文件 ⇒ 直接进候选
  const fresh = [];
  const others = [];
  for (const [rel, abs] of diskByRel) {
    if (indexed.known.has(rel)) continue;
    if (fresh.length < freshLimit) fresh.push(abs);
    else others.push(abs);
  }
  if (others.length) return full("index-too-stale"); // 新文件过多 ⇒ 别猜，退回全量

  const seen = new Set();
  const paths = [];
  for (const abs of [...ranked, ...fresh]) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    paths.push(abs);
  }

  if (!paths.length) return full("no-candidate");
  if (paths.length < Math.max(1, Number(wanted) || 1)) return full("candidate-pool-too-thin");

  return done({
    mode: "candidates",
    source: fresh.length ? "mixed" : indexed.usedExactBigrams ? "df-bigram" : "fts",
    paths,
    candidateFiles: paths.length,
    reason: null,
    pieces: pieces.length,
    twoCharTokens: twoChars.length,
    indexHits: indexed.ftsHits ?? 0,
    bigramHits: indexed.bigramHits ?? 0,
    likeHits: indexed.likeHits ?? 0,
    freshFiles: fresh.length,
  });
}
