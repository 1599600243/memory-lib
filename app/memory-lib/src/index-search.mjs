// memory-lib D5.2 — read-only search adapter for memory-lib-index.sqlite.
//
// 2026-11-02（检索前置过滤）：隔离原先只在**取完 Top-N 之后**做（post-filter）：
//   · FTS  : WHERE fts_chunks MATCH ? AND f.status='active' LIMIT ?   ← 先全局取，再过滤
//   · 向量 : SELECT ... FROM embeddings ...（无任何授权条件）          ← 全库扫描
// 后果有两个：① 每次查询扫全库向量；② 别人的热门结果会挤掉调用者自己的召回。
// 现在两路都在 SQL 里先按 **路径根 + 主体维度** 过滤（file_principals 表），
// 返回后再走一遍 inAuthRoots（索引不是权威，文件才是）。
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexPathFor } from "./index-store.mjs";
import { inferSourceType } from "./read-only-core.mjs";
import { inAuthRoots } from "./ledger-search.mjs";

function open(dataRoot) {
  try { return new DatabaseSync(indexPathFor(dataRoot), { readOnly: true }); } catch { return null; }
}
function safeMatchQuery(query) {
  return String(query ?? "").trim().split(/\s+/u).map((part) => part.replace(/["*:^(){}\[\]]/gu, "")).filter(Boolean).map((part) => `"${part.replace(/"/g, '""')}"`).join(" OR ");
}
function bodyExcerpt(text, limit = 400) {
  const source = String(text ?? "");
  const body = source.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").replace(/^\s+/u, "");
  return (body || source).slice(0, limit);
}

function rowToCandidate(row, dataRoot, authRoots, lane) {
  if (!row?.path || row.file_status !== "active") return null;
  if (String(row.path).split("/").some((part) => part.startsWith("_"))) return null;
  const absPath = path.resolve(dataRoot, ...String(row.path).split("/"));
  // Authorization is rechecked on resolved paths. The index is never an authority.
  if (!inAuthRoots(absPath, authRoots)) return null;
  return { path: absPath, line: 1, excerpt: bodyExcerpt(row.text, 400), sourceType: inferSourceType(absPath), lanes: [lane], chunkId: row.chunk_id };
}
function rrf(lists, limit) {
  const scores = new Map(); const entries = new Map();
  for (const list of lists) list.forEach((item, i) => {
    const old = entries.get(item.path);
    entries.set(item.path, old ? { ...old, lanes: [...new Set([...old.lanes, ...item.lanes])] } : item);
    scores.set(item.path, (scores.get(item.path) ?? 0) + 1 / (60 + i + 1));
  });
  return [...entries.values()].sort((a, b) => scores.get(b.path) - scores.get(a.path)).slice(0, limit);
}
function norm(v) { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); }

function escapeLike(value) {
  return String(value).replace(/[\\%_]/gu, (c) => `\\${c}`);
}

// authRoots（绝对路径）→ dataRoot 相对前缀（`curated/shared` 这种），只保留落在 dataRoot 内的。
export function relativeRootPrefixes(authRoots, dataRoot) {
  if (!Array.isArray(authRoots)) return null; // null/非数组 = 不限制
  const prefixes = [];
  for (const root of authRoots) {
    const relative = path.relative(dataRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      if (!relative) prefixes.push("");
      continue;
    }
    prefixes.push(relative.replaceAll("\\", "/"));
  }
  return prefixes;
}

function identityOr(identity, params) {
  const clauses = [];
  if (identity.user_id) { clauses.push("p.user_id = :user"); params.user = identity.user_id; }
  if (identity.agent_id) { clauses.push("p.agent_id = :agent"); params.agent = identity.agent_id; }
  if (identity.role_id) { clauses.push("p.role_id = :role"); params.role = identity.role_id; }
  return clauses;
}

/**
 * 生成前置过滤 SQL（AND 到 WHERE 后面）。没有 principal 或索引没有 principal 表时返回空串。
 * 语义是 canSeePath/principalAllowsContainer 的**超集**：宁可多取，交给返回后的复核去删。
 */
export function buildAuthFilter({ authz = null, authRoots = null, dataRoot, hasPrincipals = false } = {}) {
  const clauses = [];
  const params = {};
  if (!hasPrincipals || !authz?.principal) return { sql: "", params };

  const prefixSql = (() => {
    const prefixes = relativeRootPrefixes(authRoots, dataRoot);
    if (prefixes === null) return "";
    if (!prefixes.length) return " AND 0";
    const parts = prefixes.map((prefix, index) => {
      const key = `root${index}`;
      params[key] = prefix === "" ? "%" : `${escapeLike(prefix)}/%`;
      return `f.path LIKE :${key} ESCAPE '\\'`;
    });
    return ` AND (${parts.join(" OR ")})`;
  })();
  if (prefixSql === " AND 0") return { sql: " AND 0", params };

  const p = authz.principal;
  const tenant = p.tenant_id ?? authz.tenantId ?? "default";
  const group = p.group_id ?? null;
  const user = p.user_id ?? null;
  const agent = p.agent_id ?? null;
  const role = p.role_id ?? null;
  const visibility = "COALESCE(NULLIF(p.visibility,''), CASE p.container WHEN 'project' THEN 'project' WHEN 'tool' THEN 'platform' WHEN 'knowledge' THEN 'platform' WHEN 'role' THEN 'role' ELSE 'private' END)";

  // platform：所有人可读
  clauses.push(`(${visibility} = 'platform')`);
  // shared：分组之间严格比较；无 group 的旧记录不限制
  if (group) {
    params.group = group;
    clauses.push(`((${visibility} = 'shared') AND (p.group_id IS NULL OR p.group_id = '' OR p.group_id = :group))`);
  } else {
    clauses.push(`(${visibility} = 'shared')`);
  }
  // user：必须同一 user_id
  if (user) {
    params.user = user;
    clauses.push(`((${visibility} = 'user') AND p.user_id = :user)`);
  }
  // agent / private / long-term / tool / knowledge：身份位命中任一即可
  const identityParams = { user, agent, role };
  const ors = identityOr(identityParams, params);
  if (ors.length) {
    clauses.push(`((${visibility} IN ('agent','private')) AND (${ors.join(" OR ")}))`);
    clauses.push(`((p.container IN ('long-term','tool','knowledge')) AND (${ors.join(" OR ")}))`);
  }
  // role 容器 / role 可见性：role_id 必须相等
  if (role) {
    params.role = role;
    clauses.push(`((p.container = 'role' OR ${visibility} = 'role') AND p.role_id = :role)`);
  }
  // role 容器且 frontmatter 没写 role_id：canSeePath 会从 curated/agents/<agent>/ 路径推出 agent
  if (agent) {
    params.rolePathPrefix = `curated/agents/${agent}/%`;
    clauses.push(`(p.container = 'role' AND p.role_id IS NULL AND p.path LIKE :rolePathPrefix ESCAPE '\\')`);
  }
  // 项目：canSeePath 对 project 容器只判 group 兼容（项目名由路径根/调用方限定），这里保持一致。
  const projectGroupPart = group
    ? `(p.group_id IS NULL OR p.group_id = '' OR p.group_id IN ('unknown','null','n/a','-') OR p.group_id = :group)`
    : "1";
  clauses.push(`((${visibility} = 'project') OR p.container = 'project') AND ${projectGroupPart}`);
  // evidence：group + user 同时匹配（原文层特例）
  if (group && user) {
    clauses.push(`(p.container = 'evidence' AND p.group_id = :group AND p.user_id = :user)`);
  }
  // 无任何身份标记的旧记录：canSeePath 按 container 默认放行
  clauses.push(`(p.group_id IS NULL AND p.user_id IS NULL AND p.agent_id IS NULL AND p.role_id IS NULL AND p.container IN ('long-term','tool','knowledge','project'))`);

  params.tenant = tenant;
  const sql = prefixSql + ` AND (p.tenant_id IS NULL OR p.tenant_id = '' OR p.tenant_id = :tenant) AND (${clauses.join(" OR ")})`;
  return { sql, params };
}

export async function memoryIndexSearch(dataRoot, query, limit, authRoots, ollama = {}, fetchImpl = globalThis.fetch, authz = null) {
  const db = open(dataRoot);
  if (!db) return null;
  const endpoint = ollama.endpoint ?? "http://127.0.0.1:11434";
  const model = ollama.model ?? "bge-m3";
  const dimension = Number(ollama.dimension ?? 1024);
  const lists = [];
  try {
    const hasPrincipals = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_principals'").get());
    const auth = buildAuthFilter({ authz, authRoots, dataRoot, hasPrincipals });
    const joinPrincipals = hasPrincipals && auth.sql ? " LEFT JOIN file_principals p ON p.path = f.path" : "";
    const match = safeMatchQuery(query);
    if (match) {
      let rows = [];
      try {
        rows = db.prepare(`SELECT c.id AS chunk_id,c.text,f.path,f.status AS file_status FROM fts_chunks x JOIN chunks c ON c.id=x.chunk_id JOIN files f ON f.path=x.path${joinPrincipals} WHERE fts_chunks MATCH :match AND f.status='active'${auth.sql} LIMIT :limit`)
          .all({ ...auth.params, match, limit: Math.max(limit * 8, 32) });
      } catch {
        rows = [];
      }
      lists.push(rows.map((r) => rowToCandidate(r, dataRoot, authRoots, "fts")).filter(Boolean));
    }

    try {
      const response = await fetchImpl(`${endpoint}/api/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt: String(query ?? "") }) });
      if (response?.ok) {
        const embedding = (await response.json())?.embedding;
        if (Array.isArray(embedding) && embedding.length === dimension && embedding.every((v) => Number.isFinite(Number(v)))) {
          const q = embedding.map(Number); const qn = norm(q); const scored = [];
          const vectorRows = db.prepare(`SELECT e.chunk_id,e.vector_blob,c.text,f.path,f.status AS file_status FROM embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN files f ON f.id=c.file_id${joinPrincipals} WHERE e.vector_status='active' AND f.status='active' AND e.model=:model AND e.dimension=:dim${auth.sql}`)
            .all({ ...auth.params, model, dim: dimension });
          for (const row of vectorRows) {
            const blob = row.vector_blob;
            if (!blob || blob.length < dimension * 4) continue;
            const vector = new Float32Array(blob.buffer, blob.byteOffset, dimension); const vn = norm(vector);
            if (!qn || !vn) continue;
            let dot = 0; for (let i = 0; i < dimension; i += 1) dot += q[i] * vector[i];
            scored.push({ row, score: dot / (qn * vn) });
          }
          scored.sort((a, b) => b.score - a.score);
          lists.push(scored.slice(0, Math.max(limit * 8, 32)).map(({ row, score }) => ({ ...rowToCandidate(row, dataRoot, authRoots, "vector"), score })).filter((r) => r?.path));
        }
      }
    } catch { /* embedding lane unavailable; FTS remains usable */ }

    return { results: rrf(lists, limit), laneResults: { fts: lists[0] ?? [], vector: lists[1] ?? [] }, lanes: { fts: lists[0]?.length ?? 0, vector: lists[1]?.length ?? 0 }, prefiltered: Boolean(auth.sql), bestVectorSim: Math.max(0, ...((lists[1] ?? []).map((r) => Number(r.score) || 0))) };
  } finally { db.close(); }
}
