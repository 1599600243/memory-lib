// memory-lib — searchable eight-layer core.
// File truth is authoritative; direct writes are handled by write-memory.mjs.

// Scope model: structured scopes { layer, visibility, project }.
// Searchable roots are limited to the D29 memory layers; learning assets are owned by the
// learning assistant and are never part of memory-lib retrieval.
// scopes = null -> unrestricted access to the D29 searchable roots.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildHealthChecks,
  defaultSearchRoots,
  findCuratedItemById,
  inferSourceType,
  parseFrontmatter,
  readTextFile,
  rootsForSourceType,
  searchMatches,
  walkFiles,
} from "./read-only-core.mjs";
import { unquote, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { hybridSearch, inAuthRoots, ledgerFileState } from "./ledger-search.mjs";
import { memoryIndexSearch } from "./index-search.mjs";
import { semanticSearch } from "./semantic-index.mjs";
import { attachZhSummary, loadSummaryIndex } from "./zh-summary-index.mjs";
import { timestampValue, parseTimestamp, eventClockValue } from "./time-util.mjs";
import { atomicWriteFile as sharedAtomicWriteFile } from "./atomic-write.mjs";
import { invalidCalendarDate, invalidCalendarTimezone } from "./input-error.mjs";
import { probeVectorLane } from "./vector-lane.mjs";
import { createMemoryWriter } from "./write-memory.mjs";
import { buildCapacityReport } from "./capacity-report.mjs";
import { createRefinementObservability } from "./refinement-observability.mjs";
import { principalAllowsContainer, pathContainer } from "./container-policy.mjs";
import { createGraphStore, jointSearch as graphJointSearch, rebuildGraph, reciprocalRankFusion } from "./graph-retrieval.mjs";

const DEFAULT_RANK_WEIGHTS = Object.freeze({ relevance: 0.5, recency: 0.28, importance: 0.22, quality: 0 });

// --- library-level: structured scope resolution (deny by default) --------------
export function structuredScopeKey(scope) {
  return `${scope?.layer}:${scope?.visibility}${scope?.project ? `:${scope.project}` : ""}`;
}

export function scopeAllows(grant, requested) {
  if (grant?.layer !== requested?.layer || grant?.visibility !== requested?.visibility) return false;
  if (requested?.project === undefined) return grant?.project === undefined;
  return grant?.project === "*" || grant?.project === requested.project;
}

// compact frontmatter scope string, mirroring the plugin's scope vocabulary
export function scopeToString(scope) {
  if (scope?.layer === "memory" && scope?.visibility === "shared") return "shared";
  if (scope?.layer === "memory" && scope?.visibility === "project" && scope?.project) return `project:${scope.project}`;
  if (scope?.layer === "memory" && scope?.visibility === "agent" && scope?.project) return `agent:${scope.project}`;
  return structuredScopeKey(scope);
}

export function resolveRootsForScopes(scopes, dataRoot, workspaceRoot) {
  if (!Array.isArray(scopes)) return null; // null = unrestricted
  if (scopes.length === 0) return []; // explicit empty scope = deny all
  const roots = [];
  for (const scope of scopes ?? []) {
    const layer = scope?.layer;
    const visibility = scope?.visibility;
    const project = scope?.project;
    if (layer === "memory" && visibility === "shared") {
      roots.push(path.join(dataRoot, "curated", "shared"));
      // D3-F4：项目记忆并入 memory/shared 检索根（受限身份可见，不改线上身份配置）
      roots.push(path.join(dataRoot, "project-state"));
      // D2-F4：工具记忆与计划记忆并入 memory/shared 作用域（受限身份可见）
      roots.push(path.join(dataRoot, "tools-memory"));
      roots.push(path.join(dataRoot, "plans"));
      // D3.4：画像层（profile/，draft 由检索过滤）
      roots.push(path.join(dataRoot, "profile"));
      roots.push(path.join(dataRoot, "evidence", "documents"));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "memory" && visibility === "project" && typeof project === "string" && project) {
      roots.push(project === "*" ? path.join(dataRoot, "project-state") : path.join(dataRoot, "project-state", project));
      roots.push(path.join(dataRoot, "evidence", "documents"));
    } else if (layer === "memory" && visibility === "agent" && typeof project === "string" && project) {
      roots.push(project === "*" ? path.join(dataRoot, "curated", "agents") : path.join(dataRoot, "curated", "agents", project));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "tool") {
      // D2.1：工具记忆 tools-memory/<tool>.md
      roots.push(path.join(dataRoot, "tools-memory"));
    } else if (layer === "plan") {
      // D2.3：计划记忆 plans/<topic>.md
      roots.push(path.join(dataRoot, "plans"));
    } else if (layer === "memory" && visibility === "user") {
      // 2026-10-30：QQ 身份（qq-*）的 scope 是 {layer:"memory",visibility:"user"}，**不带 project**。
      // 原来没有匹配分支 → memory/list 一条都扫不到（brief 走索引所以还能命中），
      // 表现为"库里 1725 条 user 记忆，列表接口返回 0 条"。
      // user 级记忆实际落在 curated/shared（frontmatter visibility=user），
      // 逐文件再由 principalAuthorizesPath 按 user_id 过滤，不会串。
      roots.push(path.join(dataRoot, "curated", "shared"));
      roots.push(path.join(dataRoot, "profile"));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "memory" && visibility === "user" && typeof project === "string" && project) {
      // User scope is filtered by principal.user_id after this root is searched.
      roots.push(path.join(dataRoot, "curated", "agents"));
      roots.push(path.join(dataRoot, "plans"));
      roots.push(path.join(dataRoot, "profile"));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "memory" && visibility === "platform") {
      roots.push(path.join(dataRoot, "tools-memory"));
      roots.push(path.join(dataRoot, "evidence", "documents"));
    } else if (layer === "memory" && visibility === "daily") {
      // daily notes = dataRoot 顶层 .md（项目活动记录），只扫顶层不递归
      roots.push({ path: dataRoot, type: "daily" });
    }
    // default: deny — unknown layer/visibility combos contribute no root
  }
  return [...new Set(roots)];
}

// --- library-level: API surface -------------------------------------------------
export function createMemoryLib(options = {}) {
  const dataRoot = options.dataRoot;
  if (!dataRoot) throw new Error("memory-lib: dataRoot is required");
  const workspaceRoot = typeof options.workspaceRoot === "string" && options.workspaceRoot
    ? options.workspaceRoot
    : path.dirname(dataRoot);
  const recoveryRoot = typeof options.recoveryRoot === "string" && options.recoveryRoot
    ? options.recoveryRoot
    : path.join(workspaceRoot, "recovery");
  // scopes: null = unrestricted parity mode; [] or [{...}] = restricted (deny default)
  const scopes = options.scopes === undefined ? null : options.scopes;
  const optionsPrincipal = options.principal ?? null;
  // TZ-CONFIG-1-REJECT：**部署默认时区**由宿主（服务端）解析后由此带入，库本身不解析 flag/env。
  // 未带入时保持库自己的历史默认 "UTC"。进程内 MCP（`coreFromLib`）也读这一个值，
  // 所以 REST / `/mcp` / stdio 不会各自造出第二个默认值来源。
  const deploymentTimezone = options.calendarTimezone ?? "UTC";
  const libraryAudit = options.audit && typeof options.audit.record === "function" ? options.audit : null;
  const graphStore = createGraphStore({ dataRoot });
  const memoryWriter = createMemoryWriter({ dataRoot, graphStore });
  const defaultAuditScope = Array.isArray(scopes) && scopes.length === 1 ? scopeToString(scopes[0]) : scopes;
  const refinementObservability = createRefinementObservability({ dataRoot, audit: libraryAudit, threshold: options.refinementThreshold, reportPath: options.refinementReportPath ?? null });

  async function principalAuthorizesPath(filePath, frontmatter = null) {
    if (!optionsPrincipal) return true;
    const text = frontmatter ? null : await readTextFile(filePath);
    const fm = frontmatter ?? (text ? parseFrontmatter(text).frontmatter : {});
    const container = pathContainer(dataRoot, filePath);
    if (!container) return false;
    if (container === "evidence") {
      const group = unquote(fm.group_id ?? fm.groupId);
      const user = unquote(fm.user_id ?? fm.userId);
      const principalGroup = optionsPrincipal.group_id;
      const principalUser = optionsPrincipal.user_id;
      return Boolean(group && user && group !== "unknown" && user !== "unknown" && principalGroup && principalUser && group === principalGroup && user === principalUser);
    }
    const metadata = { ...fm, container, project: unquote(fm.project), group_id: unquote(fm.group_id), user_id: unquote(fm.user_id), agent_id: unquote(fm.agent_id), role_id: unquote(fm.role_id), visibility: unquote(fm.visibility) || (container === "project" ? "project" : container === "tool" || container === "knowledge" ? "platform" : container === "role" ? "role" : "private") };
    if (!metadata.group_id && !metadata.user_id && !metadata.agent_id && !metadata.role_id) {
      if (container === "role") {
        const parts = path.relative(dataRoot, filePath).split(path.sep);
        metadata.agent_id = parts[0] === "curated" && parts[1] === "agents" ? parts[2] : null;
      }
      if (container === "project") return true;
      if (container === "long-term" || container === "tool" || container === "knowledge") return true;
    }
    // Two keys must be mutually invisible because authenticated principal filtering proves it,
    // never because a missing retrieval root happens to hide the record.
    return principalAllowsContainer(optionsPrincipal, metadata);
  }

  async function auditGovernance({ action, resourceId, scope = defaultAuditScope, allow, rule, replacementId = null, denyReason = null }) {
    if (!libraryAudit) return;
    try {
      await libraryAudit.record({
        channel: "library",
        framework: optionsPrincipal?.framework_id ?? null,
        agent: optionsPrincipal?.agent_id ?? null,
        role: optionsPrincipal?.role_id ?? null,
        action,
        resourceId,
        scope,
        allow,
        rule,
        replacementId,
        denyReason,
      });
    } catch (error) {
      console.error(`library audit write failed: ${error.message}`);
    }
  }

  const resolvedRoots = scopes === null
    ? defaultSearchRoots(dataRoot)
    : resolveRootsForScopes(scopes, dataRoot, workspaceRoot);
  // D4F1：任何受限身份下，「自己」的角色记忆根自动可达（读路径）。
  // agent_id 由连接身份注入（不信调用方自报）；不做新 scope 名称、不改 identity.json。
  if (Array.isArray(resolvedRoots)) {
    const selfAgent = typeof options.agentId === "string" && options.agentId.trim() ? slugify(options.agentId.trim()) : null;
    if (selfAgent) {
      const selfRoot = path.join(dataRoot, "curated", "agents", selfAgent);
      if (!resolvedRoots.includes(selfRoot)) resolvedRoots.push(selfRoot);
    }
  }
  const importedDocumentsRoot = path.join(dataRoot, "evidence", "documents");
  async function importedDocumentAuthorized(result) {
    const relative = result?.path ? path.relative(importedDocumentsRoot, result.path) : "..";
    const isImportedDocument = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (scopes === null || !isImportedDocument) return true;
    const text = await readTextFile(result.path).catch(() => null);
    if (!text) return false;
    const rawScope = parseFrontmatter(text).frontmatter.scope;
    let requested = { layer: "memory", visibility: "platform" };
    if (rawScope) {
      try { requested = JSON.parse(rawScope); } catch { return false; }
    } else {
      const frontmatter = parseFrontmatter(text).frontmatter;
      requested = {
        layer: unquote(frontmatter.layer) === "document" ? "memory" : (unquote(frontmatter.layer) || "memory"),
        visibility: unquote(frontmatter.visibility) || "platform",
        ...(frontmatter.project ? { project: unquote(frontmatter.project) } : {}),
      };
    }
    return scopes.some((grant) => scopeAllows(grant, requested) || (requested.layer === "memory" && requested.visibility === "platform" && grant?.layer === "memory" && grant?.visibility === "shared"));
  }

  // F6：控制台中文摘要（离线 sidecar，只读派生数据）。
  // 由宿主注入 `options.summaryIndex`（sidecar 路径 / 已加载索引 / 条目数组；`summaryIndexPath` 为别名）。
  // 未注入 = 完全惰性：不读盘、不给结果加任何字段，响应形状与改动前逐字节一致。
  // 注入后按「规范化路径」为 list/get/search 结果**附加**可选 summaryZh/keyPoints（缺省即英文回退）。
  // 路径来源每次按 mtime+size 复检（sidecar 重新生成后无需重启）；对象来源按引用缓存。
  const summaryIndexBySource = new WeakMap();
  function zhSummaryIndex() {
    const source = options.summaryIndex ?? options.summaryIndexPath ?? null;
    if (!source) return null;
    if (typeof source === "string") return loadSummaryIndex(source, { onError: options.onSummaryIndexError });
    if (typeof source !== "object" && typeof source !== "function") return null;
    if (!summaryIndexBySource.has(source)) summaryIndexBySource.set(source, loadSummaryIndex(source, { onError: options.onSummaryIndexError }));
    return summaryIndexBySource.get(source);
  }
  function withZhSummary(item) { return attachZhSummary(item, zhSummaryIndex()); }

  // health() — mirrors plugin service.status() health checks (service.ts:553-560),
  // plus the F2 read-only vector-lane probe (see src/vector-lane.mjs).
  //
  // The directory checks alone made health lie: with Ollama down the semantic lane
  // had silently degraded to file-first/FTS while /v1/health still said "healthy".
  // The vector lane is therefore probed (read-only) and an unusable lane
  // (down/stale) clamps the overall status to "degraded" with a reason.
  async function health({ group_id = null, user_id = null } = {}) {
    const [checks, vector] = await Promise.all([
      Promise.all(buildHealthChecks(dataRoot, workspaceRoot, recoveryRoot).map(async ([name, checkPath]) => ({
        name,
        path: checkPath,
        status: await fsAccess(checkPath),
      }))),
      probeVectorLane(dataRoot, { ollama: options.ollama, vectorLane: options.vectorLane }),
    ]);
    checks.push({ name: "vector-lane", status: vector.status, reason: vector.reason });
    const missing = checks.filter((item) => item.status === "missing");
    const pathHealth = missing.length === 0 ? "healthy" : missing.length <= 2 ? "reduced" : "degraded";
    const vectorDegraded = vector.status === "down" || vector.status === "stale";
    return {
      health: vectorDegraded ? "degraded" : pathHealth,
      reason: vectorDegraded ? vector.reason : null,
      checks,
      vector,
      dataRoot,
      backend: "file-first",
      scopeMode: scopes === null ? "unrestricted" : "restricted",
      roots: resolvedRoots,
      capacity: await buildCapacityReport(dataRoot),
      refinement: await refinementObservability.snapshot({ group_id, user_id }),
    };
  }

  async function graph({ tenantId, projectId, principal = optionsPrincipal } = {}) { return graphStore.projectGraph({ tenantId, projectId, principal }); }
  async function ingestGraphEvent(event) { return graphStore.ingest(event); }
  async function rebuildGraphIndex(options = {}) { return rebuildGraph({ dataRoot, ...options }); }
  async function jointGraphSearch(options = {}) { return graphJointSearch({ dataRoot, principal: optionsPrincipal, ...options }); }

  async function rankNeighbors(query, { topK = 10, sourceType = null, project = null, workspace = null, tags = [] } = {}) {
    const limit = Math.max(1, Math.min(50, Number(topK) || 10));
    const hits = await search({ query, limit: Math.max(limit * 4, 40), sourceType, project, workspace, tags, graphExpand: false });
    return hits.slice(0, limit).map((item) => ({ id: String(item.id ?? path.basename(item.path, path.extname(item.path))), path: item.path, body: String(item.excerpt ?? "").slice(0, 2000), score: Number(item.score ?? 0) }));
  }

  // search() — default mode "hybrid": uses the plugin's read-only ledger
  // (FTS + vector via Ollama + RRF) when present, else falls back to file-first.
  // When restricted, only authorized roots are searched (filtering BEFORE retrieval).
  // search() — default mode "hybrid": uses the plugin's read-only ledger
  // (FTS + vector + RRF + auth filtering), then ALWAYS tops up with a
  // deterministic lexical pass over the authorized roots when the hybrid hits
  // do not already contain enough word-level matches.
  //
  // Why the lexical top-up is mandatory: the owned ledger can lag behind a
  // newly written file until the next rebuild. Lexical containment is
  // deterministic, so the file-first pass keeps direct writes immediately visible.
  async function search({ query, limit = 10, documentQuota = 3, rawQuota = 3, sourceType = null, mode = "hybrid", searchMode = "hybrid", workspace = null, tags = [], since = null, until = null, project = null, include_superseded = false, include_stale = false, as_of = null, agent_id = options.agentId ?? null, role_id = options.roleId ?? null, lane = null, graphExpand = true, calendarDate = null, calendarTimezone = undefined } = {}) {
    if (typeof query !== "string" || !query.trim()) return [];
    // DAYRECALL-2：`calendarDate` 是**硬条件时间范围**，与 timeline() 同一套解析。
    // 用同一个 resolveCalendarRange ⇒ 非法日期在这里就 4xx，窗口字符串也与枚举路径逐字一致。
    // 注意只解析窗口、**不改写 since/until**：按天判定统一由 filterByCalendarDay 做，
    // 免得同一条记录被"updatedAt 口径"和"capturedAt 口径"各判一次、给出一动一静两个答案。
    const searchZone = calendarTimezone ?? deploymentTimezone;
    const dayWindow = calendarDate ? resolveCalendarRange({ calendarDate, calendarTimezone: searchZone, since, until }) : null;
    const statusOpts = { includeSuperseded: include_superseded, includeStale: include_stale, asOf: as_of };
    const requestedSearchMode = String(searchMode ?? "hybrid").toLowerCase();
    const retrievalMode = requestedSearchMode === "formal" ? "memories" : requestedSearchMode === "raw" ? "evidence" : ["memories", "documents", "evidence", "hybrid"].includes(requestedSearchMode) ? requestedSearchMode : "hybrid";
    const finalLimit = Math.max(1, Number(limit) || 10);
    const finalRawQuota = Math.max(1, Math.floor(Number.isFinite(Number(rawQuota)) ? Number(rawQuota) : 3));
    const hasMetadataFilter = Boolean((typeof workspace === "string" && workspace.trim()) || (Array.isArray(tags) && tags.length));
    const candidateLimit = hasMetadataFilter ? Math.max(finalLimit * 20, 200) : Math.max(finalLimit * 20, 200);
    const authRoots = resolvedRoots === null ? null : resolvedRoots.map((r) => typeof r === "string" ? r : r?.path).filter(Boolean);
    const pathAuthorized = (filePath) => authRoots === null || authRoots.some((root) => {
      const rel = path.relative(root, filePath);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    let results = null;
    let bestVectorSim = 0;
    let secondVectorSim = 0;
    let ftsHits = 0;
    let usedOwnedIndex = false;
    if (mode === "hybrid" && authRoots !== null && authRoots.length === 0) {
      results = [];
    } else if (mode === "hybrid") {
      const owned = await memoryIndexSearch(dataRoot, query, candidateLimit, authRoots, options.ollama, options.embeddingFetch ?? globalThis.fetch);
      if (owned) {
        usedOwnedIndex = true;
        results = owned.results.filter((r) => pathAuthorized(r.path));
        bestVectorSim = owned.bestVectorSim ?? 0;
        ftsHits = owned.lanes?.fts ?? 0;
        if (sourceType) results = results.filter((r) => r.sourceType === sourceType);
      }
      // Legacy ledger is a read-only fallback only. Its candidates are still re-authorized below.
      if (!owned || !results.length) {
        const legacy = await hybridSearch(dataRoot, { query, limit: candidateLimit, authRoots, ollama: options.ollama, vectorThreshold: options.vectorThreshold ?? undefined });
        if (legacy) {
          const safeLegacy = (legacy.results ?? []).filter((r) => pathAuthorized(r.path));
          results = dedupeResultsByPath([...(results ?? []), ...safeLegacy]);
          bestVectorSim = Math.max(bestVectorSim, legacy.bestVectorSim ?? 0);
          secondVectorSim = legacy.secondVectorSim ?? 0;
          ftsHits += legacy.lanes?.fts ?? 0;
          if (sourceType) results = results.filter((r) => r.sourceType === sourceType);
        }
      }
    }
    if (!usedOwnedIndex && (!results || !results.length)) {
      // Legacy semantic index is retained only as a read-only fallback when the owned index has no candidates.
      const legacySemantic = await semanticSearch(dataRoot, query, candidateLimit, authRoots, options.ollama ?? { endpoint: "http://127.0.0.1:11434", model: "bge-m3", dimension: 1024 }, options.semanticIndexFloor ?? 0.35);
      if (legacySemantic.length) {
        results = dedupeResultsByPath([...(results ?? []), ...legacySemantic.filter((r) => pathAuthorized(r.path))]);
        bestVectorSim = Math.max(bestVectorSim, legacySemantic[0]?.score ?? 0);
      }
    }
    results = await filterSearchableResults(results, statusOpts);
    const isRawPath = (filePath) => String(filePath ?? "").replaceAll("\\", "/").includes("/evidence/conversations/");
    if (retrievalMode === "evidence") results = (results ?? []).filter((result) => isRawPath(result.path));
    if (retrievalMode === "memories") results = (results ?? []).filter((result) => !isRawPath(result.path) && searchLayer(result) !== "document");
    if (retrievalMode === "documents") results = (results ?? []).filter((result) => searchLayer(result) === "document");
    results = await rankLexicalEvidence(results, query);
    // 词面兜底：统计 hybrid 结果里真正含查询词的文件数（确定性），不足则用 file-first 补差
    const retrievalRoots = retrievalMode === "evidence"
      ? intersectRoots(rootsForSourceType("raw", dataRoot, workspaceRoot), resolvedRoots)
      : retrievalMode === "memories"
        ? resolvedRoots.filter((root) => { const value = String(typeof root === "string" ? root : root?.path).replaceAll("\\", "/"); return !value.includes("/evidence/conversations") && !value.includes("/evidence/documents"); })
        : retrievalMode === "documents"
          ? intersectRoots(rootsForSourceType("document", dataRoot, workspaceRoot), resolvedRoots)
          : resolvedRoots;
    const roots = sourceType
      ? intersectRoots(rootsForSourceType(sourceType, dataRoot, workspaceRoot), retrievalRoots)
      : retrievalRoots;
    const exactResult = isExactLookupQuery(query) ? await findExactIdResult(query, roots, statusOpts) : null;
    // DAYRECALL-2：算出「这一天」的文件集合，作为 file-first 扫描的**硬宇宙**。
    // 只在带 calendarDate 时做（多一次走盘 + 读 frontmatter，按天问才付这个成本）。
    let dayPaths = null;
    if (dayWindow) {
      const zone = dayWindow.calendarTimezone;
      const dayFiles = [];
      for (const root of roots ?? []) {
        const found = root && root.type === "daily" ? await topLevelFiles(root.path, [".md", ".json"]) : await walkFiles(typeof root === "string" ? root : root.path);
        dayFiles.push(...found);
      }
      dayPaths = new Set();
      for (const filePath of new Set(dayFiles)) {
        if (await fallsOnCalendarDay({ path: filePath }, calendarDate, zone)) dayPaths.add(path.normalize(filePath));
      }
    }
    const fileFirstNeed = Math.max(candidateLimit, (results ?? []).length + candidateLimit);
    if (exactResult) results = [exactResult, ...(results ?? []).filter((item) => item.path !== exactResult.path)].slice(0, candidateLimit);
    const seen = new Set((results ?? []).map((r) => r.path));
    let lexicalHits = 0;
    for (const r of results ?? []) {
      const text = await readTextFile(r.path).catch(() => null);
      if (text && searchMatches(text, query).length) lexicalHits++;
    }
    // 每次都做 bounded file-first 补差：ledger 的常见词结果可能已填满 limit，
    // 但刚写入的文件仍未进入 ledger，不能因此跳过新文件可见性校准。
    const ledgerState = ledgerFileState(dataRoot);
    let extra = await fileFirstTop(query, roots, fileFirstNeed, seen, options.fileFirstScanCap ?? 600, ledgerState, statusOpts, dayPaths);
    traceSearch(options.trace, "file-first", { query, results: extra });
    const settingToken = query.match(/\bconfiguration\s+setting\s+([a-z0-9])\b/iu)?.[1]?.toLowerCase();
    if (settingToken) {
      const settingHit = await findSettingResult(query, settingToken, roots, options.fileFirstScanCap ?? 600, statusOpts);
      if (settingHit) extra = [settingHit, ...extra.filter((item) => item.path !== settingHit.path)];
    }
    const hasExactBodyPhrase = await hasExactBodyPhraseResult(results, query);
    if (isNaturalLanguageQuery(query) && !hasExactBodyPhrase) {
      for (const e of extra ?? []) seen.add(e.path);
      const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 2 && !SEARCH_STOPWORDS.has(token)).sort((a, b) => b.length - a.length);
      for (const token of tokens.slice(0, 6)) {
        const tokenExtra = await fileFirstTop(token, roots, fileFirstNeed, seen, options.fileFirstScanCap ?? 600, ledgerState, statusOpts, dayPaths);
        traceSearch(options.trace, "token-fallback", { query, token, results: tokenExtra });
        extra = [...extra, ...tokenExtra];
      }
    }
    extra = await rankFileFirstOverlay(extra, query, ledgerState);
    traceSearch(options.trace, "overlay-merge", { query, results: extra });
    if (extra.length) {
      // 词面命中（含新写入尚未进 ledger 的文件）优先于语义弱匹配，避免被 hybrid 挤掉
      results = dedupeResultsByPath([...extra, ...(results ?? [])]);
    } else if (lexicalHits === 0 && (results ?? []).length) {
      // 无词面/实体命中的单 token 按精确查找处理，不接受纯向量结果；
      // 分词后的自然语言查询才允许通过低健康下限进入语义召回。
      const allowPureVector = !isExactLookupQuery(query) && hasStrongVectorSignal(bestVectorSim, secondVectorSim, {
        floor: options.semanticVectorFloor ?? 0.52,
      });
      if (isExactLookupQuery(query) || (lexicalHits === 0 && !allowPureVector)) results = [];
    }
    if (results === null) results = [];
    if (exactResult) results = [exactResult, ...results.filter((item) => item.path !== exactResult.path)].slice(0, candidateLimit);
    results = await rankFileFirstOverlay(results, query, ledgerState);
    if (exactResult) results = [exactResult, ...results.filter((item) => item.path !== exactResult.path)];
    if (retrievalMode === "evidence") results = results.filter((result) => isRawPath(result.path));
    if (retrievalMode === "memories") results = results.filter((result) => !isRawPath(result.path) && searchLayer(result) !== "document");
    if (retrievalMode === "documents") results = results.filter((result) => searchLayer(result) === "document");
    results = results.slice(0, candidateLimit);
    traceSearch(options.trace, "all-lanes-merge", { query, results });
    results = await rankTemporalResults(results, query);
    if (exactResult) results = [exactResult, ...results.filter((item) => item.path !== exactResult.path)];
    if (isCurrentIntent(query) && results.length > 1) results = results.slice(0, 1);
    const searchableResults = await filterSearchableResults(results, statusOpts);
    const scopeFilteredResults = [];
    for (const result of searchableResults) if (await importedDocumentAuthorized(result) && await principalAuthorizesPath(result.path)) scopeFilteredResults.push(result);
    // DAYRECALL-2：按天做**硬过滤**，位置在配额切片之前 —— 否则"那一天"的条目会被
    // 别的日期占用 limit，问 10/10 却拿到 10-19（本单红证据）。
    let filteredResults = filterByProject(await filterByOccurredTime(await filterItemsByMetadata(await filterByAgentRole(scopeFilteredResults, { agent_id, role_id }), { workspace, tags }), { since, until }), project);
    if (dayWindow) filteredResults = await filterByCalendarDay(filteredResults, { day: calendarDate, zone: dayWindow.calendarTimezone });
    const completionIntent = /当前|进展|下一步|阻塞|状态|做到哪|进度/iu.test(query);
    const stateFiles = completionIntent ? await canonicalStateCandidates(roots, options.fileFirstScanCap ?? 600, statusOpts) : [];
    let rankedCandidates = stateFiles.length ? dedupeResultsByPath([...filteredResults, ...stateFiles]) : filteredResults;
    // stateFiles 是绕过 filterItemsByMetadata 直接补进来的，必须同样过按天硬条件。
    if (dayWindow) rankedCandidates = await filterByCalendarDay(rankedCandidates, { day: calendarDate, zone: dayWindow.calendarTimezone });
    if (exactResult) {
      const exactIndex = rankedCandidates.findIndex((item) => item.path === exactResult.path);
      if (exactIndex > 0) rankedCandidates.unshift(...rankedCandidates.splice(exactIndex, 1));
    }
    const rankMetadata = new Map((results ?? []).map((item, index) => [item.path, { score: item.score, matchCount: item.matchCount, freshness: item.freshness, rank: index }]));
    const scoredCandidates = rankedCandidates.map((item, index) => ({ ...item, ...(rankMetadata.get(item.path) ?? {}), __query: query, __rank: rankMetadata.get(item.path)?.rank ?? index }));
    const evidenceOnly = lane === "evidence" || retrievalMode === "evidence";
    const laneResults = evidenceOnly ? filteredResults.filter((result) => searchLayer(result) === "raw").map((item) => ({ ...item, __query: query })) : foldSimilarResults(scoredCandidates);
    const prioritizedResults = await prioritizeSearchLayers(laneResults, { query, completionIntent, rankWeights: options.rankWeights, recencyHalfLifeDays: options.recencyHalfLifeDays });
    const requestedDocumentQuota = Number(documentQuota);
    const finalDocumentQuota = Number.isFinite(requestedDocumentQuota) ? Math.max(0, Math.floor(requestedDocumentQuota)) : 3;
    const formalResults = prioritizedResults.filter((result) => searchLayer(result) !== "document" && searchLayer(result) !== "raw");
    const documentResults = prioritizedResults.filter((result) => searchLayer(result) === "document");
    const rawResults = prioritizedResults.filter((result) => searchLayer(result) === "raw");
    let finalResults = evidenceOnly
      ? rawResults.slice(0, finalRawQuota).map((result) => ({ ...result, quotaLayer: "raw", result_type: "evidence" }))
      : retrievalMode === "memories"
        ? formalResults.slice(0, finalLimit).map((result) => ({ ...result, quotaLayer: "long-term", result_type: "memory" }))
        : retrievalMode === "documents"
          ? documentResults.slice(0, finalLimit).map((result) => ({ ...result, quotaLayer: "document", result_type: "evidence" }))
          : retrievalMode === "evidence"
            ? rawResults.slice(0, finalLimit).map((result) => ({ ...result, quotaLayer: "raw", result_type: "evidence" }))
            : [
                ...formalResults.slice(0, finalLimit).map((result) => ({ ...result, quotaLayer: "long-term", result_type: "memory" })),
                ...documentResults.slice(0, finalLimit).map((result) => ({ ...result, quotaLayer: "document", result_type: "evidence" })),
                ...rawResults.slice(0, finalLimit).map((result) => ({ ...result, quotaLayer: "raw", result_type: "evidence" })),
              ];
    if (retrievalMode === "evidence") finalResults = finalResults.filter((result) => searchLayer(result) === "raw").slice(0, finalLimit);
    if (retrievalMode === "memories") finalResults = finalResults.filter((result) => searchLayer(result) !== "raw" && searchLayer(result) !== "document").slice(0, finalLimit);
    if (retrievalMode === "documents") finalResults = finalResults.filter((result) => searchLayer(result) === "document").slice(0, finalLimit);
    if (retrievalMode === "hybrid") {
      const memoryResults = finalResults.filter((result) => result.result_type === "memory");
      const availableEvidence = [...finalResults, ...filteredResults].filter((result) => ["raw", "document"].includes(searchLayer(result)));
      const uniqueEvidence = dedupeResultsByPath(availableEvidence);
      const rawEvidence = uniqueEvidence.filter((result) => searchLayer(result) === "raw").slice(0, Math.min(3, finalLimit));
      const documentEvidence = finalDocumentQuota > 0 ? uniqueEvidence.filter((result) => searchLayer(result) === "document").slice(0, Math.min(finalDocumentQuota, Math.max(0, Math.min(3, finalLimit) - rawEvidence.length))) : [];
      const evidenceResults = [...documentEvidence, ...rawEvidence].map((result) => ({ ...result, result_type: "evidence", quotaLayer: searchLayer(result) === "document" ? "document" : "raw" }));
      const memoryTake = Math.max(0, finalLimit - evidenceResults.length);
      finalResults = [...memoryResults.slice(0, memoryTake), ...evidenceResults].slice(0, finalLimit);
      const seenConversations = new Set();
      finalResults = finalResults.filter((result) => {
        if (result.result_type !== "evidence") return true;
        const text = String(result.path ?? "");
        const conversation = text.includes("/evidence/conversations/") ? path.basename(text).replace(/\.md$/u, "") : text;
        if (seenConversations.has(conversation)) return false;
        seenConversations.add(conversation);
        return true;
      });
    }
    if (graphExpand !== false && lane !== "evidence" && optionsPrincipal && retrievalMode !== "raw") {
      const graphLists = [];
      const projectFiles = await walkFiles(path.join(dataRoot, "project-state"), [".md"]);
      for (const filePath of projectFiles) {
        const text = await readTextFile(filePath).catch(() => null);
        if (!text || !searchMatches(text, query).length) continue;
        const frontmatter = parseFrontmatter(text).frontmatter;
        const relativeParts = path.relative(dataRoot, filePath).split(path.sep);
        const projectName = unquote(frontmatter.project) || (relativeParts[0] === "project-state" ? relativeParts[1] : null);
        if (!projectName) continue;
        const memoryId = unquote(frontmatter.id) || path.basename(filePath, path.extname(filePath));
        const projectGraph = graphStore.projectGraph({ tenantId: optionsPrincipal.tenant_id ?? "default", projectId: projectName, principal: optionsPrincipal });
        const edge = projectGraph.edges.find((candidate) => candidate.dst_id === memoryId || candidate.dst_id === filePath);
        if (edge) graphLists.push([{ path: filePath, id: filePath, excerpt: bodyExcerpt(text, 400), matched_by: "graph", graph_path: edge.graph_path, evidence_ids: edge.evidence_ids }]);
      }
      for (const item of finalResults) {
        const text = await readTextFile(item.path).catch(() => null);
        const frontmatter = text ? parseFrontmatter(text).frontmatter : {};
        const relativeParts = path.relative(dataRoot, item.path).split(path.sep);
        const projectName = unquote(frontmatter.project) || (relativeParts[0] === "project-state" ? relativeParts[1] : null);
        if (!projectName) continue;
        const memoryId = unquote(frontmatter.id) || path.basename(item.path, path.extname(item.path));
        const projectGraph = graphStore.projectGraph({ tenantId: optionsPrincipal.tenant_id ?? "default", projectId: projectName, principal: optionsPrincipal });
        const edge = projectGraph.edges.find((candidate) => candidate.dst_id === memoryId || candidate.dst_id === item.path);
        if (edge) graphLists.push([{ ...item, id: item.path, matched_by: "graph", graph_path: edge.graph_path, evidence_ids: edge.evidence_ids }]);
      }
      if (graphLists.length) finalResults = reciprocalRankFusion([finalResults, ...graphLists], finalLimit);
    }
    // DAYRECALL-2：图谱融合会**事后**再塞条目（project-state 命中），它们没走过任何时间过滤，
    // 所以按天硬条件必须在最后再收一次口，否则"问 10/10"仍可能带出别的日子。
    if (dayWindow) finalResults = await filterByCalendarDay(finalResults, { day: calendarDate, zone: dayWindow.calendarTimezone });
    traceSearch(options.trace, "final", { query, results: finalResults });
    // F6：命中 sidecar 的追加中文摘要（可选字段，未注入索引时原样返回）
    return (await Promise.all(finalResults.map(async (item) => {
      const fullText = item.path ? await readTextFile(item.path).catch(() => null) : null;
      const parsed = fullText ? parseFrontmatter(fullText).frontmatter : {};
      const isEvidence = item.result_type === "evidence" || searchLayer(item) === "raw" || searchLayer(item) === "document";
      return withZhSummary({ ...item, result_type: isEvidence ? "evidence" : "memory", provenance: { source_evidence_ids: Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [], evidence_id: isEvidence ? (unquote(parsed.id) || null) : null, conversation_id: unquote(parsed.conversationId ?? parsed.conversation_id) || null }, excerpt: fullText ? bodyExcerpt(fullText, 400) : bodyExcerpt(item.excerpt, 400), tier: Number(item.tier ?? 4), score: Number(item.score ?? 0), rankSource: item.rankSource ?? "score" });
    })));
  }

  async function timeline({ limit = 10, offset = 0, cursor = null, calendarDate = null, calendarTimezone = undefined, workspace = null, tags = [], since = null, until = null, project = null, include_superseded = false, include_stale = false, agent_id = options.agentId ?? null, role_id = options.roleId ?? null } = {}) {
    // 未显式给时区 ⇒ 用本实例的部署默认（宿主带入；库自身兜底 "UTC"）。
    const zone = calendarTimezone ?? deploymentTimezone;
    const resolvedRange = resolveCalendarRange({ calendarDate, calendarTimezone: zone, since, until });
    // DAY-INTERVAL-1：**两条入口共用同一个区间表示**，这样"一天"就不可能有两套语义。
    //   since / until        —— 闭口径（`until` = 区间最后一毫秒），贴合仓库既有的 since/until 习惯，
    //                            也正好兼容 `filterByOccurredTime` 的 `end > until` 判定。
    //   untilExclusive       —— 半开区间 `[since, untilExclusive)` 的真值，独立回显。
    // 之前的 bug：`untilExclusive` 是拿 `until` 硬加 1ms 算的；当日历日那条路给出的
    // `until` 已经是"次日零点"时，就变成了次日零点+1ms ⇒ 把次日第一条也放了进来。
    const { since: boundSince, until: boundUntil, untilExclusive, calendarDate: boundCalendarDate, calendarTimezone: boundTimezone } = resolvedRange;
    since = boundSince;
    until = boundUntil;
    const echoRange = {
      since: boundSince ?? null,
      until: boundUntil ?? null,
      untilExclusive: untilExclusive ?? null,
      // 字段名沿用既有的 `calendarTimezone`（DAYRECALL-1 就在用），不为了"更好听"而改名 ——
      // 改名是白送的破坏性变更。
      calendarTimezone: boundTimezone,
      ...(boundCalendarDate ? { calendarDate: boundCalendarDate } : {}),
    };
    if (!since && !until) return { total_count: 0, count: 0, offset: 0, next_offset: null, nextCursor: null, has_more: false, hasMore: false, resolvedRange: echoRange, results: [] };
    const statusOpts = { includeSuperseded: include_superseded, includeStale: include_stale };
    const files = [];
    for (const root of resolvedRoots ?? []) {
      const found = root && root.type === "daily" ? await topLevelFiles(root.path, [".md", ".json"]) : await walkFiles(typeof root === "string" ? root : root.path);
      files.push(...found);
    }
    const candidates = [];
    for (const filePath of [...new Set(files)]) {
      const text = await readTextFile(filePath);
      if (!text || !isSearchableText(text, statusOpts) || !await importedDocumentAuthorized({ path: filePath }) || !await principalAuthorizesPath(filePath)) continue;
      const parsed = parseFrontmatter(text);
      const stamp = timestampValue(parsed.frontmatter);
      // REFINE-LOOP-2：**按天分档必须走事件时钟**（capturedAt → occurred_at → …），不能用
      // timestampValue（那里 updated_at 优先）——否则提炼记忆会被分到"提炼那天"，
      // 问某一天就会把别的日子的事一起端上来。updatedAt 保留记录轴，两者分开。
      const clock = eventClockValue(parsed.frontmatter);
      const eventMs = Number.isFinite(clock.value) ? clock.value : stamp.value;
      if (!Number.isFinite(eventMs)) continue;
      candidates.push({
        id: unquote(parsed.frontmatter.id) || path.basename(filePath, path.extname(filePath)),
        path: filePath,
        frontmatter: parsed.frontmatter,
        updatedAt: new Date(stamp.value).toISOString(),
        capturedAt: unquote(parsed.frontmatter.capturedAt ?? parsed.frontmatter.captured_at) || new Date(eventMs).toISOString(),
        calendarDate: unquote(parsed.frontmatter.calendarDate) || null,
        calendarTimezone: unquote(parsed.frontmatter.calendarTimezone) || null,
        excerpt: bodyExcerpt(text, 400),
        result_type: ["raw", "document"].includes(inferSourceType(filePath)) ? "evidence" : "memory",
      });
    }
    let visible = filterByProject(await filterByOccurredTime(await filterByAgentRole(await filterItemsByMetadata(candidates, { workspace, tags }), { agent_id, role_id }), { since, until }), project);
    // calendarDate 是**查询时区下的派生值**，由不可变的 capturedAt 重算得出。
    // 不使用写入时物化的 calendarDate/calendarTimezone 做判定：写入时区与查询时区不同时，
    // 用写入值过滤会把同一瞬时错分到别的本地日（同一瞬时在不同时区属于不同本地日，
    // 这正是要支持的多租户语义）。物化字段仅用于索引/人工查看，真值仍由 capturedAt 决定。
    if (calendarDate) {
      const zone = resolvedRange.calendarTimezone;
      visible = visible.filter((item) => calendarDateInZone(parseTimestamp(item.capturedAt), zone) === calendarDate);
    }
    visible.sort((a, b) => parseTimestamp(a.capturedAt) - parseTimestamp(b.capturedAt) || String(a.id).localeCompare(String(b.id)));
    const finalLimit = Math.max(1, Math.min(100, Number(limit) || 10));
    const finalOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const cursorValue = decodeTimelineCursor(cursor);
    const afterCursor = cursorValue ? visible.filter((item) => parseTimestamp(item.capturedAt) > cursorValue.capturedAt || (parseTimestamp(item.capturedAt) === cursorValue.capturedAt && String(item.id) > cursorValue.id)) : visible;
    const results = afterCursor.slice(finalOffset, finalOffset + finalLimit).map(withZhSummary);
    const last = results.at(-1);
    const nextCursor = last && afterCursor.indexOf(last) + 1 < afterCursor.length ? encodeTimelineCursor({ capturedAt: parseTimestamp(last.capturedAt), id: String(last.id) }) : null;
    const nextOffset = finalOffset + results.length < visible.length ? finalOffset + results.length : null;
    return { total_count: visible.length, count: results.length, offset: finalOffset, next_offset: nextOffset, has_more: nextCursor !== null || nextOffset !== null, hasMore: nextCursor !== null, nextCursor, resolvedRange: echoRange, results };
  }

  async function listMemories({ limit = 50, workspace = null, tags = [], since = null, until = null, project = null, include_superseded = false, include_stale = false, agent_id = options.agentId ?? null, role_id = options.roleId ?? null } = {}) {
    const statusOpts = { includeSuperseded: include_superseded, includeStale: include_stale };
    const files = [];
    for (const root of resolvedRoots ?? []) {
      const found = root && root.type === "daily" ? await topLevelFiles(root.path, [".md", ".json"]) : await walkFiles(typeof root === "string" ? root : root.path);
      files.push(...found);
    }
    const items = [];
    for (const filePath of [...new Set(files)]) {
      const text = await readTextFile(filePath);
      if (!text || !isSearchableText(text, statusOpts) || !await importedDocumentAuthorized({ path: filePath }) || !await principalAuthorizesPath(filePath)) continue;
      const parsed = parseFrontmatter(text);
      const stat = await fs.stat(filePath).catch(() => ({ mtimeMs: 0 }));
      const fmTime = timestampValue(parsed.frontmatter, stat).value;
      items.push({ id: unquote(parsed.frontmatter.id) || path.basename(filePath, path.extname(filePath)), path: filePath, frontmatter: parsed.frontmatter, body: parsed.body, updatedAt: Number.isFinite(fmTime) ? new Date(fmTime).toISOString() : new Date(stat.mtimeMs || 0).toISOString() });
    }
    const listed = filterByProject(await filterByOccurredTime(await filterByAgentRole(await filterItemsByMetadata(items, { workspace, tags }), { agent_id, role_id }), { since, until }), project).sort((a, b) => parseTimestamp(b.updatedAt) - parseTimestamp(a.updatedAt)).slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
    // F6：命中 sidecar 的追加中文摘要（可选字段，未注入索引时原样返回）
    return listed.map(withZhSummary);
  }

  // get() — reads one curated item by id, restricted to authorized roots.
  // Returns null when not found or outside authorized scope (no existence leak).
  async function get(id, { include_cold = false } = {}) {
    if (typeof id !== "string" || !id.trim()) return null;
    const roots = [...new Set([
      ...resolvedRoots.filter((root) => typeof root === "string"),
      path.join(dataRoot, "evidence", "conversations"),
    ])];
    for (const root of roots) {
      const item = await findCuratedItemById(root, id);
      if (item && await importedDocumentAuthorized({ path: item.filePath }) && await principalAuthorizesPath(item.filePath, item.frontmatter)) return withZhSummary({ id: unquote(item.frontmatter.id) || unquote(id), path: item.filePath, frontmatter: item.frontmatter, body: item.body });
    }
    if (include_cold) {
      for (const root of roots) {
        const stack = [root];
        while (stack.length) {
          const dir = stack.pop();
          for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const filePath = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name.startsWith("_cold-")) stack.push(filePath); else stack.push(filePath); continue; }
            if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
            const text = await readTextFile(filePath);
            if (!text) continue;
            const parsed = parseFrontmatter(text);
            if (unquote(parsed.frontmatter.id) === unquote(id) && (parsed.frontmatter.status === "cold" || filePath.split(path.sep).some((part) => part.startsWith("_cold-")))) return withZhSummary({ id: unquote(parsed.frontmatter.id), path: filePath, frontmatter: parsed.frontmatter, body: parsed.body });
          }
        }
      }
    }
    return null;
  }
  async function deprecate(id, replacementId, reason) {
    let scope = defaultAuditScope;
    try {
      const item = await findItemAcrossRoots(resolvedRoots, id);
      if (!item) throw new Error("Curated item not found");
      const { frontmatter } = parseFrontmatter(item.text);
      scope = frontmatter.scope ?? scope;
      // MAINT10：这里原来调用 `buildFrontmatter(frontmatter) + body`，而全仓**从未定义**也没导出过
      // buildFrontmatter（线上实测 400 "buildFrontmatter is not defined"）——
      // 即 deprecate 这条写回分支在生产里从来没成功过。
      // 修复口径：复用既有的 updateFrontmatterFields（frontmatter-util.mjs:51 —— tools/plans/
      // write-memory 四个写入器用的同一个原语），在原文本上就地改这几个字段，其余字节一字不动。
      // **不新写序列化**：renderFrontmatter 需要先把解析出的对象重建成 entries 数组（那份
      // "对象→条目"映射本身就是第三套规则）；就地更新不重新渲染任何既有字段，漂移面最小。
      const now = new Date().toISOString();
      const updated = updateFrontmatterFields(item.text, {
        status: JSON.stringify("deprecated"),
        updatedAt: JSON.stringify(now),
        ...(replacementId ? { replacementId: JSON.stringify(replacementId) } : {}),
        ...(reason ? { deprecationReason: JSON.stringify(reason) } : {}),
      });
      await atomicWriteFile(item.filePath, updated);
      try { removeSemanticFile(dataRoot, item.filePath); } catch { /* derived index cleanup is best effort */ }
      await refreshDerivedIndex().catch(() => {});
      const result = { id, path: item.filePath, status: "deprecated" };
      await auditGovernance({ action: "deprecate", resourceId: id, scope, allow: true, rule: "deprecate", replacementId });
      return result;
    } catch (error) {
      await auditGovernance({ action: "deprecate", resourceId: id, scope, allow: false, rule: "deprecate", replacementId, denyReason: error.message });
      throw error;
    }
  }

  // 按授权 roots 查找 curated 条目（覆盖 curated/、project-state/、curated/agents/ 等）
  async function findItemAcrossRoots(roots, id) {
    for (const root of roots) {
      if (typeof root !== "string") continue;
      const item = await findCuratedItemById(root, id);
      if (item) return item;
    }
    return null;
  }

  async function refreshDerivedIndex() {
    return { skipped: true, reason: "derived graph index retired" };
  }

  // User-authoritative Persona instruction is written through the same direct
  // D29 writer as every other authorized memory write.
  async function putPersonaMemory({ content, roleId = "companion", principal = null, evidenceRefs = [] } = {}) {
    if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
    const safeRole = slugify(roleId);
    const frameworkId = principal?.framework_id ?? "user";
    const agentId = principal?.agent_id ?? "user";
    const role = principal?.role_id ?? safeRole;
    return memoryWriter.write({
      layer: "curated-shared",
      id: `persona-${safeRole}`,
      body: `用户 Persona 指令：${content.trim()}`,
      tags: ["persona", `persona:${safeRole}`, "user-authoritative"],
      evidence_refs: evidenceRefs,
      principal: { framework_id: frameworkId, agent_id: agentId, role_id: role },
    });
  }

  return {
    dataRoot,
    workspaceRoot,
    scopes,
    recoveryRoot,
    scopeMode: scopes === null ? "unrestricted" : "restricted",
    roots: resolvedRoots,
    // TZ-CONFIG-1-REJECT：本实例的**部署默认时区**（宿主带入，或库的 "UTC" 兜底）。
    // 进程内 MCP 的 resolveDate 直接读它，避免在 mcp-server.mjs 里再写一个 "UTC"。
    calendarTimezone: deploymentTimezone,
    health,
    search,
    timeline,
    rankNeighbors,
    listMemories,
    get,
    putPersonaMemory,
    deprecate,
    graph,
    ingestGraphEvent,
    rebuildGraph: rebuildGraphIndex,
    jointSearch: jointGraphSearch,
    refinement: refinementObservability,
    pendingRefinement: (options = {}) => refinementObservability.pending(options),
  };
}

// --- library-level helpers ------------------------------------------------------
// file-first 补差检索：扫授权 roots，按命中次数 + 最早行号粗排序（轻量确定性评分，
// 替代遍历顺序截断），跳过已由 ledger 命中的 path；scanCap 限制扫描文件数（大规模防抖）。
// 用途：无 ledger 时全量 file-first；有 ledger 但命中不足时补齐「新写入尚未进 ledger」的文件。
// D2-F1：标识字段（id/tool_name/topic/project/slug/title）纳入检索与打分；
// 标识字段与查询精确相等（或 basename 相等）给最高优先级。
const IDENTIFIER_FIELDS = ["id", "tool_name", "topic", "project", "slug", "title"];
function identifierExact(filePath, text, query) {
  const q = String(query ?? "").trim();
  if (!q) return false;
  const fm = parseFrontmatter(text).frontmatter;
  for (const field of IDENTIFIER_FIELDS) {
    if (unquoteFrontmatter(fm[field]) === q) return true;
  }
  if (path.basename(filePath, path.extname(filePath)) === q) return true;
  return false;
}

async function findExactIdResult(id, roots, statusOpts = {}) {
  for (const root of roots ?? []) {
    if (typeof root !== "string") continue;
    for (const filePath of await walkFiles(root)) {
      const text = await readTextFile(filePath);
      if (!text || !isSearchableText(text, statusOpts)) continue;
      if (!identifierExact(filePath, text, id)) continue;
      return { path: filePath, line: 1, excerpt: text.slice(0, 400), sourceType: inferSourceType(filePath), lanes: ["exact-id"] };
    }
  }
  return null;
}

async function fileFirstTop(query, roots, need, seen, scanCap, ledgerState = null, statusOpts = {}, allowPaths = null) {
  if (need <= 0 || !Array.isArray(roots) || roots.length === 0) return [];
  const q = String(query ?? "").trim();
  if (!q) return [];
  const hits = [];
  let scanned = 0;
  const allFiles = [];
  for (const root of roots) {
    const files = root && root.type === "daily"
      ? await topLevelFiles(root.path, [".md", ".json"])
      : await walkFiles(typeof root === "string" ? root : root.path);
    allFiles.push(...files);
  }
  // DAYRECALL-2：给了"这一天"的文件集合时，**先收宇宙再扫描**。
  // 否则 1407 个证据文件按 mtime 倒序排，scanCap=600 根本扫不到 10/10 那批老文件 ——
  // 于是"10/10 聊了什么（带查询词）"明明有内容却返回 0 条（本单实测的假阴性）。
  // scanCap 在收窄后的宇宙里重新计数，所以"那一天"的文件是全量可扫的。
  const allowKey = allowPaths ? new Set([...allowPaths].map((p) => path.normalize(p))) : null;
  const candidates = allowKey ? allFiles.filter((filePath) => allowKey.has(path.normalize(filePath))) : allFiles;
  const prioritizedFiles = await Promise.all(candidates.map(async (filePath, index) => ({
      filePath,
      index,
      mtimeMs: (await fs.stat(filePath).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
  })));
  prioritizedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.index - b.index);
  for (const { filePath } of prioritizedFiles) {
    if (seen.has(filePath)) {
      const indexed = ledgerState?.get(normalizeFileKey(filePath));
      if (!indexed?.sha256) continue;
      const existingText = await readTextFile(filePath);
      const existingSha = existingText ? crypto.createHash("sha256").update(existingText).digest("hex") : null;
      if (existingSha && existingSha === indexed.sha256) continue;
    }
    if (scanned++ >= scanCap) break;
    const text = await readTextFile(filePath);
    if (!text || !isSearchableText(text, statusOpts)) continue;
    const matches = searchMatches(text, q);
    if (!matches.length) continue;
    const frontmatterEnd = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    const frontmatterLines = frontmatterEnd ? frontmatterEnd[0].split(/\r?\n/).length - 1 : 0;
    const bodyMatch = matches.find((match) => match.line > frontmatterLines);
    const selected = bodyMatch ?? matches[0];
    const exactId = identifierExact(filePath, text, q);
    let freshness = 0;
    const fileKey = normalizeFileKey(filePath);
    const currentSha = crypto.createHash("sha256").update(text).digest("hex");
    if (ledgerState) {
      const indexed = ledgerState.get(fileKey);
      if (!indexed && freshness < 2) freshness = 2;
      else if (indexed?.sha256 && currentSha !== indexed.sha256 && freshness < 1) freshness = 1;
    }
    hits.push({ path: filePath, line: selected.line, excerpt: selected.excerpt, sourceType: inferSourceType(filePath), matchCount: matches.length, exactId, freshness });
  }
  hits.sort((a, b) => Number(b.exactId) - Number(a.exactId) || b.freshness - a.freshness || b.matchCount - a.matchCount || a.line - b.line);
  return hits.slice(0, need).map(({ exactId: _exactId, ...hit }) => hit);
}

function normalizeFileKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function traceSearch(trace, stage, detail) {
  if (typeof trace === "function") trace({ stage, ...detail });
}

function dedupeResultsByPath(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = result?.path ?? result?.itemId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function rankFileFirstOverlay(results, query, ledgerState = null) {
  if (!Array.isArray(results) || !results.length) return [];
  const byPath = new Map();
  results.forEach((result, index) => {
    const current = byPath.get(result.path);
    if (!current) byPath.set(result.path, { result, index });
  });
  const tokens = String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length > 2 && !SEARCH_STOPWORDS.has(token));
  const cjkTerms = [...String(query ?? "").toLowerCase().matchAll(/[\u3400-\u9fff]{2,}/gu)]
    .flatMap((match) => Array.from({ length: Math.max(0, match[0].length - 1) }, (_, index) => match[0].slice(index, index + 2)));
  const lexicalTerms = [...new Set([...tokens, ...cjkTerms])];
  const phrase = String(query ?? "").trim().toLowerCase();
  const scored = await Promise.all([...byPath.values()].map(async ({ result, index }) => {
    const text = result?.path ? await readTextFile(result.path).catch(() => null) : null;
    const full = text ? text.toLowerCase() : "";
    const identifier = Boolean(text && result?.path && identifierExact(result.path, text, String(query ?? "")));
    const currentSha = text ? crypto.createHash("sha256").update(text).digest("hex") : null;
    const fileKey = normalizeFileKey(result.path);
    const indexed = ledgerState?.get(fileKey);
    const pending = Boolean(currentSha && result?.lanes?.includes("semantic") && indexed?.sha256 !== currentSha);
    const tokenCoverage = new Set(lexicalTerms.filter((token) => full.includes(token))).size;
    const exactPhrase = Boolean(phrase && full.includes(phrase));
    // D4.2a：词面命中（标识精确/整句/任意 token）优先于纯语义；同为词面命中按命中次数、再按新鲜度
    const lexical = identifier || exactPhrase || tokenCoverage > 0;
    const matchCount = Number(result?.matchCount ?? 0);
    const fm = text ? parseFrontmatter(text).frontmatter : {};
    const mtimeMs = (await fs.stat(result.path).catch(() => ({ mtimeMs: 0 }))).mtimeMs ?? 0;
    const freshness = timestampValue(fm, mtimeMs).value;
    return { result, index, identifierExact: identifier, pending, exactPhrase, tokenCoverage, lexical, matchCount, freshness };
  }));
  scored.sort((a, b) => Number(b.identifierExact) - Number(a.identifierExact)
    || Number(b.exactPhrase) - Number(a.exactPhrase)
    || Number(b.lexical) - Number(a.lexical)
    || Number(b.pending) - Number(a.pending)
    || b.matchCount - a.matchCount
    || b.tokenCoverage - a.tokenCoverage
    || b.freshness - a.freshness
    || a.index - b.index);
  return scored.map(({ result }) => result);
}

function resultScopeKey(result) {
  if (result?.scope) return String(result.scope);
  if (result?.workspace) return `workspace:${String(result.workspace)}`;
  const normalized = String(result?.path ?? "").replaceAll("\\", "/");
  const project = normalized.match(/(?:^|\/)project-state\/([^/]+)/u);
  if (project) return `project:${project[1]}`;
  const agent = normalized.match(/(?:^|\/)curated\/agents\/([^/]+)/u);
  if (agent) return `agent:${agent[1]}`;
  if (/(?:^|\/)profile\//u.test(normalized)) return "profile";
  if (/(?:^|\/)curated\/shared\//u.test(normalized)) return "shared";
  return `path:${path.dirname(normalized)}`;
}

function foldSimilarResults(results) {
  const groups = [];
  for (const result of results ?? []) {
    const scope = resultScopeKey(result);
    const body = String(result.body ?? result.excerpt ?? "");
    const group = body.trim() ? groups.find((candidate) => candidate.body.trim() && candidate.scope === scope && candidate.body.trim() === body.trim()) : null;
    if (group) {
      group.count += 1;
      if (Number(result.score ?? 0) > Number(group.result.score ?? 0)) group.result = result;
    } else groups.push({ scope, body, result, count: 1 });
  }
  return groups.map(({ result, count }) => count > 1 ? { ...result, family_count: count, merge_source: "same-scope-similarity" } : result);
}

function bodyExcerpt(text, limit = 400) {
  const source = String(text ?? "");
  const body = source.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").replace(/^\s+/u, "");
  return (body || source).slice(0, limit);
}

function searchLayer(result) {
  const source = String(result?.sourceType ?? "").toLowerCase();
  const filePath = String(result?.path ?? "").replaceAll("\\", "/");
  if (source === "document" || /(?:^|\/)evidence\/documents\//u.test(filePath)) return "document";
  if (source === "evidence" || /(?:^|\/)evidence\/conversations\//u.test(filePath)) return "raw";
  if (source === "episodic" || source === "conversation-evidence" || /(?:^|\/)evidence\/conversations\//u.test(filePath)) return "raw";
  return "long-term";
}

async function prioritizeSearchLayers(results, { query = "", completionIntent = false, rankWeights = null, recencyHalfLifeDays = 30 } = {}) {
  const weights = normalizeRankWeights(rankWeights);
  const halfLifeMs = Math.max(1, Number(recencyHalfLifeDays) || 30) * 86400_000;
  if (!Array.isArray(results) || results.length === 0) return results ?? [];
  const scored = await Promise.all(results.map(async (result, index) => {
      const text = result?.path ? await readTextFile(result.path).catch(() => null) : null;
      const full = String(text ?? result?.excerpt ?? "").toLowerCase();
      const relevance = Math.max(0, Math.min(1, Number(result?.score ?? 0)));
      const metadata = text ? parseFrontmatter(text).frontmatter : {};
      const updatedAt = timestampValue(metadata).value;
      const recency = updatedAt ? Math.exp(-Math.max(0, Date.now() - updatedAt) / halfLifeMs) : 0;
      const importance = importanceScore(metadata.importance);
      const quality = Math.max(0, Math.min(1, Number(metadata.quality_score ?? metadata.quality?.score ?? 0.5)));
      const lexicalCount = Number(result?.matchCount ?? 0);
      const lexical = Math.min(1, lexicalCount / 4);
      const exactIdentifierPrior = identifierExact(result?.path, text ?? "", query) ? 1 : 0;
      const canonical = /[\\/](?:current-state|README)\.md$/iu.test(String(result?.path ?? ""));
      const queryTokens = normalizeQueryTokens(query);
      const matchedTokens = queryTokens.filter((token) => full.includes(token));
      const tokenCoverage = queryTokens.length ? matchedTokens.length / queryTokens.length : 0;
      const canonicalMatch = canonical && (completionIntent || tokenCoverage > 0);
      const backlogPenalty = /conversation-extract|conversation-auto/iu.test(full) ? 0.15 : 0;
      const freshFile = Math.min(1, Math.max(0, Number(result?.freshness ?? 0)) / 3);
      // Lexical coverage is the dominant relevance signal. Recency and importance
      // break ties among similarly matching records; freshness is a same-tier bonus.
      const relevanceScore = Math.max(relevance, tokenCoverage);
      const weighted = (weights.relevance * relevanceScore) + (weights.recency * recency) + (weights.importance * importance) + (weights.quality * quality);
      const composite = Math.max(0, Math.min(1, (tokenCoverage * 0.55) + (weighted * 0.35) + (lexical * 0.1) + (freshFile * lexical * 0.3) - backlogPenalty));
      const layer = searchLayer(result);
      const tier = exactIdentifierPrior ? 0 : canonicalMatch ? 1 : layer === "long-term" ? 2 : layer === "episodic" ? 3 : layer === "document" ? 4 : 5;
      const rankSource = exactIdentifierPrior ? "exact-id" : canonicalMatch ? "canonical" : tokenCoverage > 0 ? "lexical" : "score";
      const score = Number(composite.toFixed(6));
      // rankKey is the complete public sort key. Tier bands do not overlap,
      // while score remains the 0..1 within-tier relevance value.
      const rankKey = Number((((5 - tier) * 2) + score).toFixed(6));
      const scoreParts = { relevance: Number(Math.max(relevance, tokenCoverage).toFixed(6)), recency: Number(recency.toFixed(6)), importance: Number(importance.toFixed(6)), quality: Number(quality.toFixed(6)), lexicalCount, matchedTokens: matchedTokens.length, tokenCoverage: Number(tokenCoverage.toFixed(6)), freshFile: Number(freshFile.toFixed(6)) };
      return { result: { ...result, tier, score, rankKey, rankSource, scoreParts }, index };
    }));
  scored.sort((a, b) => b.result.rankKey - a.result.rankKey || a.index - b.index);
  const folded = [];
  const families = new Set();
  for (const entry of scored) {
    const result = entry.result;
    const family = String(result.family_id ?? result.familyId ?? "").trim();
    if (!family || families.has(family)) continue;
    families.add(family);
    const members = scored.filter((candidate) => String(candidate.result.family_id ?? candidate.result.familyId ?? "").trim() === family);
    folded.push(members.length > 1 ? { ...result, family_count: members.length, merge_source: "same-family-fold" } : result);
  }
  const visible = scored.filter(({ result }) => !String(result.family_id ?? result.familyId ?? "").trim()).map(({ result }) => result).concat(folded).sort((a, b) => b.rankKey - a.rankKey);
  return visible;
}

function normalizeRankWeights(input) {
  const source = input && typeof input === "object" ? input : DEFAULT_RANK_WEIGHTS;
  // D15.1: quality scores overlap real technical knowledge and operational noise;
  // retain the field for diagnostics, but never let it reorder retrieval results.
  const values = { relevance: Number(source.relevance), recency: Number(source.recency), importance: Number(source.importance), quality: 0 };
  const rankValues = [values.relevance, values.recency, values.importance];
  const sum = rankValues.every(Number.isFinite) ? rankValues.reduce((a, b) => a + Math.max(0, b), 0) : 0;
  if (!sum) return DEFAULT_RANK_WEIGHTS;
  return { relevance: Math.max(0, values.relevance) / sum, recency: Math.max(0, values.recency) / sum, importance: Math.max(0, values.importance) / sum, quality: 0 };
}

function importanceScore(value) {
  return { ordinary: 0.33, important: 0.66, critical: 1 }[String(value ?? "ordinary").replace(/["']/gu, "").toLowerCase()] ?? 0.33;
}

function normalizeQueryTokens(query) {
  const source = String(query ?? "").toLowerCase();
  const western = source.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));
  const cjk = [...source.matchAll(/[\u3400-\u9fff]{2,}/gu)].flatMap((match) => Array.from({ length: match[0].length - 1 }, (_, index) => match[0].slice(index, index + 2)));
  return [...new Set([...western, ...cjk])];
}

async function canonicalStateCandidates(roots, scanCap, statusOpts = {}) {
  const candidates = [];
  let scanned = 0;
  for (const root of roots ?? []) {
    const files = await walkFiles(typeof root === "string" ? root : root?.path);
    for (const filePath of files) {
      if (scanned++ >= scanCap) return candidates;
      const basename = path.basename(filePath).toLowerCase();
      if (basename !== "current-state.md" && basename !== "readme.md") continue;
      const text = await readTextFile(filePath);
      if (!text || !isSearchableText(text, statusOpts)) continue;
      const fm = parseFrontmatter(text).frontmatter;
      if (basename === "current-state.md" && !/current[-_ ]?state/iu.test(`${fm.kind ?? ""} ${fm.type ?? ""} ${fm.layer ?? ""} ${filePath}`)) continue;
      candidates.push({ path: filePath, line: 1, excerpt: text.slice(0, 400), sourceType: inferSourceType(filePath), lanes: ["canonical-state"] });
    }
  }
  return candidates;
}

async function rankLexicalEvidence(results, query) {
  if (!Array.isArray(results) || results.length < 2) return results;
  const rawTokens = String(query ?? "").trim().split(/\s+/u).filter(Boolean);
  const tokens = rawTokens.map((token) => token.replace(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, ""))
    .filter((token, index) => (token.length > 2 && !SEARCH_STOPWORDS.has(token.toLowerCase())) || /^[A-Z0-9]$/u.test(rawTokens[index]));
  const cjkTerms = [...String(query ?? "").matchAll(/[\u3400-\u9fff]{2,}/gu)]
    .flatMap((match) => Array.from({ length: Math.max(0, match[0].length - 1) }, (_, index) => match[0].slice(index, index + 2)));
  const lexicalTerms = [...new Set([...tokens, ...cjkTerms])];
  if (!lexicalTerms.length) return results;
  const scored = await Promise.all(results.map(async (result, index) => {
    const text = result?.path ? await readTextFile(result.path).catch(() => null) : null;
    const full = text ? text.toLowerCase() : "";
    const identifierMatch = Boolean(text && result?.path && identifierExact(result.path, text, String(query ?? "")));
    const exactPhrase = full.includes(String(query ?? "").trim().toLowerCase());
    const lexicalScore = lexicalTerms.reduce((total, token) => {
      const escaped = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = /[\u3400-\u9fff]/u.test(token) ? escaped : `\\b${escaped}\\b`;
      return total + (full.match(new RegExp(pattern, "gu")) ?? []).length;
    }, 0);
    return { result, index, identifierMatch, exactPhrase, lexicalScore };
  }));
  if (!scored.some((item) => item.lexicalScore > 0)) return results;
  scored.sort((a, b) => Number(b.identifierMatch) - Number(a.identifierMatch) || Number(b.exactPhrase) - Number(a.exactPhrase) || b.lexicalScore - a.lexicalScore || (b.result.score ?? 0) - (a.result.score ?? 0) || a.index - b.index);
  return scored.map(({ result }) => result);
}

async function hasExactBodyPhraseResult(results, query) {
  const phrase = String(query ?? "").trim().toLowerCase();
  if (!phrase || !Array.isArray(results)) return false;
  for (const result of results) {
    const text = result?.path ? await readTextFile(result.path).catch(() => null) : null;
    if (text && text.toLowerCase().includes(phrase)) return true;
  }
  return false;
}

async function findSettingResult(query, settingToken, roots, scanCap, statusOpts = {}) {
  const phrase = new RegExp(`configuration\\s+setting\\s+${settingToken.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "iu");
  let scanned = 0;
  for (const root of roots ?? []) {
    const files = root && root.type === "daily" ? await topLevelFiles(root.path, [".md", ".json"]) : await walkFiles(typeof root === "string" ? root : root.path);
    for (const filePath of files) {
      if (scanned++ >= scanCap) return null;
      const text = await readTextFile(filePath);
      if (!text || !isSearchableText(text, statusOpts)) continue;
      const body = parseFrontmatter(text).body;
      if (!phrase.test(body)) continue;
      const match = searchMatches(body, query)[0] ?? searchMatches(body, `setting ${settingToken}`)[0];
      return { path: filePath, line: match?.line ?? 1, excerpt: match?.excerpt ?? body.slice(0, 400), sourceType: inferSourceType(filePath), lanes: ["file-first", "exact-phrase"] };
    }
  }
  return null;
}

// Default retrieval only exposes active file truth. Derived indexes can lag a
// deprecate operation, so validate current frontmatter after every retrieval
// lane (ledger, file-first, and graph expansion).
function isSearchableText(text, { includeSuperseded = false, includeStale = false, includeCold = false, asOf = null } = {}) {
  const fm = parseFrontmatter(text).frontmatter;
  const status = unquoteFrontmatter(fm.status ?? "active").trim().toLowerCase();
  if (status === "deprecated") return false;
  if (status === "superseded" && !includeSuperseded && !asOf) return false;
  if (status === "stale" && !includeStale) return false;
  if (fm.type !== "conversation") {
    const at = asOf ? Date.parse(String(asOf)) : Date.now();
    if (!Number.isFinite(at)) return false;
    const from = Date.parse(unquoteFrontmatter(fm.valid_from ?? fm.validFrom));
    const to = Date.parse(unquoteFrontmatter(fm.valid_to ?? fm.validTo));
    if (Number.isFinite(from) && from > at) return false;
    if (!(includeSuperseded && !asOf) && Number.isFinite(to) && at >= to) return false;
  }
  if (status === "cold" && !includeCold) return false;
  // D3.4：语义层（画像）draft 未人工确认不返回
  if (status === "draft" && unquoteFrontmatter(fm.layer ?? "").trim().toLowerCase() === "semantic") return false;
  return true;
}

const SEARCH_STOPWORDS = new Set(["the", "what", "is", "are", "do", "does", "did", "we", "our", "use", "used", "have", "has", "been", "this", "that", "how", "where", "which", "who", "when", "why", "a", "an", "of", "to", "in", "for", "on", "at", "and", "or", "was", "were", "be", "with", "from", "by"]);

function isCurrentIntent(query) {
  const q = String(query ?? "").toLowerCase();
  return /\b(current|latest|now|currently|today)\b/u.test(q) || /当前|现在|最新|目前/u.test(q);
}

function isNaturalLanguageQuery(query) {
  const q = String(query ?? "").trim();
  return /\s/u.test(q) && !/^[-_a-z0-9.]+$/iu.test(q);
}

async function rankTemporalResults(results, query) {
  if (!Array.isArray(results) || results.length < 2) return results;
  const q = String(query ?? "").toLowerCase();
  const currentIntent = isCurrentIntent(q);
  if (!currentIntent) return results;
  const enriched = await Promise.all(results.map(async (result, index) => {
    const text = result?.path ? await readTextFile(result.path).catch(() => null) : null;
    const frontmatter = text ? parseFrontmatter(text).frontmatter : {};
    const eventAt = timestampValue({ eventAt: frontmatter.eventAt, validFrom: frontmatter.validFrom }).value;
    const updatedAt = timestampValue({ updatedAt: frontmatter.updatedAt, createdAt: frontmatter.createdAt }).value;
    const fileStamp = String(result?.path ?? "").match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[.-]\d{3}Z)/u)?.[1] ?? "";
    const fileAt = parseTimestamp(fileStamp ? fileStamp.replace(/T(\d{2})-(\d{2})-(\d{2})[.-]/u, "T$1:$2:$3.") : "");
    const version = Number(frontmatter.memoryVersion ?? frontmatter.version ?? 0);
    return { result, index, eventAt: Number.isFinite(eventAt) ? eventAt : 0, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0, fileAt: Number.isFinite(fileAt) ? fileAt : 0, version: Number.isFinite(version) ? version : 0 };
  }));
  if (!enriched.some((item) => item.eventAt || item.version || item.updatedAt || item.fileAt)) return results;
  enriched.sort((a, b) => Number(Boolean(b.eventAt || b.version)) - Number(Boolean(a.eventAt || a.version)) || b.version - a.version || b.eventAt - a.eventAt || b.updatedAt - a.updatedAt || b.fileAt - a.fileAt || a.index - b.index);
  return enriched.map((item) => item.result);
}

async function filterSearchableResults(results, statusOpts = {}) {
  if (!Array.isArray(results)) return results;
  const out = [];
  for (const result of results) {
    if (!result?.path) continue;
    const text = await readTextFile(result.path);
    if (text && isSearchableText(text, statusOpts)) out.push(result);
  }
  return out;
}

// ASCII single-token queries are treated as exact/lexical lookups when no file
// or FTS match exists. CJK text and whitespace-delimited language may use vectors.
export function isExactLookupQuery(query) {
  const q = String(query ?? "").trim();
  return Boolean(q) && !/\s/u.test(q) && /^[\x00-\x7f]+$/u.test(q);
}

export function hasStrongVectorSignal(best, _second, { floor = 0.5 } = {}) {
  return Number(best) >= floor;
}

async function fsAccess(checkPath) {
  try {
    await fs.access(checkPath);
    return "ok";
  } catch {
    return "missing";
  }
}

function intersectRoots(requested, authorized) {
  if (authorized === null) return requested; // unrestricted
  if (requested.length === 0 || authorized.length === 0) return [];
  const authSet = new Set(authorized);
  return requested.filter((root) => authSet.has(root));
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "memory";
}

// D2.2：按 project 过滤（project-state/<slug>/ 路径匹配）。
function filterByProject(items, project) {
  const name = typeof project === "string" && project.trim() ? slugify(project.trim()) : null;
  if (!name) return items ?? [];
  return (items ?? []).filter((item) => String(item.path ?? "").includes(`${path.sep}project-state${path.sep}${name}${path.sep}`));
}

// D4.1：角色记忆按 agent_id / role_id 过滤
async function filterByAgentRole(items, { agent_id = null, role_id = null } = {}) {
  const agent = typeof agent_id === "string" && agent_id.trim() ? agent_id.trim() : null;
  const role = typeof role_id === "string" && role_id.trim() ? role_id.trim() : null;
  if (!agent && !role) return items ?? [];
  const out = [];
  for (const item of items ?? []) {
    const text = await readTextFile(item.path).catch(() => null);
    if (!text) continue;
    const fm = parseFrontmatter(text).frontmatter;
    // Conversation evidence is owned by group/user, not by the role-memory agent/role axes.
    if (unquoteFrontmatter(fm.type) === "conversation") { out.push(item); continue; }
    const visibility = unquoteFrontmatter(fm.visibility);
    if (visibility !== "shared" && visibility !== "user" && visibility !== "platform") {
      if (agent && unquoteFrontmatter(fm.agent_id) !== agent) continue;
      if (role && unquoteFrontmatter(fm.role_id) !== role) continue;
    }
    out.push(item);
  }
  return out;
}

async function filterItemsByMetadata(items, { workspace = null, tags = [] } = {}) {
  const workspaceFilter = typeof workspace === "string" && workspace.trim() ? workspace.trim() : null;
  const tagFilters = Array.isArray(tags) ? [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))] : [];
  if (!workspaceFilter && !tagFilters.length) return items ?? [];
  const out = [];
  for (const item of items ?? []) {
    let frontmatter = item.frontmatter;
    if (!frontmatter) {
      const text = await readTextFile(item.path).catch(() => null);
      if (!text) continue;
      frontmatter = parseFrontmatter(text).frontmatter;
    }
    const itemWorkspace = unquoteFrontmatter(frontmatter.workspace);
    const itemTags = parseFrontmatterList(frontmatter.tags).map((tag) => tag.toLowerCase());
    if (workspaceFilter && itemWorkspace !== workspaceFilter) continue;
    if (tagFilters.some((tag) => !itemTags.includes(tag))) continue;
    out.push(item);
  }
  return out;
}

function unquoteFrontmatter(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try { const parsed = JSON.parse(text); return typeof parsed === "string" ? parsed : text; } catch { return text; }
}

// D1F3：按发生时间**区间重叠**过滤（「昨天做了什么」这类按时间问句）。
// 判定：条目时间区间 [start, end] 与查询区间 [since, until] 有交集即命中；until 补到当天 23:59:59.999。
function dayRangeMs(day) {
  const start = parseTimestamp(`${day}T00:00:00.000`);
  const end = parseTimestamp(`${day}T23:59:59.999`);
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function itemTimeRange(frontmatter, filePath) {
  // REFINE-LOOP-2：时间范围问的是"事发生在什么时候"，同样走事件时钟（不是 updated_at）。
  const startValue = eventClockValue(frontmatter).value;
  const start = Number.isFinite(startValue) ? startValue : null;
  const endValue = timestampValue({ updatedAt: frontmatter?.occurred_until ?? frontmatter?.occurredUntil }).value;
  const end = Number.isFinite(endValue) ? endValue : null;
  if (start) return { start, end: end ?? start };
  const day = String(frontmatter?.date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const range = dayRangeMs(day);
    if (range) return range;
  }
  const pathDate = String(filePath ?? "").match(/(\d{4}-\d{2}-\d{2})/);
  if (pathDate) {
    const range = dayRangeMs(pathDate[1]);
    if (range) return range;
  }
  return null;
}

// DAYRECALL-1 A：把「某地日历日」解析成 UTC 半开区间。
//
// 口径（写死，来源见 research/time-tagging-and-relative-date-parsing.md「工程上一天的正确含义」）：
//   - 用户说的"10/10"是**本地日**，不是 UTC 日；不可变真值始终是 capturedAt。
//   - 区间 = [startOfDay(day, tz), startOfDay(day+1, tz))，
//     **不许**用 start + 86400000（DST 日不是 24 小时，如 Australia/Lord_Howe 为 23.5 小时）。
//   - 结束边界对外表现为该日最后一个毫秒（含），与既有 until 的闭区间口径保持一致，
//     但它是**从次日零点的起点反推**出来的，不是"23:59:59.999 硬编码"。
//   - 同一个请求重放必须得到同一个范围：计算只依赖 (calendarDate, calendarTimezone)，不读"现在"。
function normalizedTimezone(value) {
  const timezone = typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    // ATOMICWRITE-1：这是**调用方参数问题**，必须回 4xx，不许冒成 500 INTERNAL。
    throw invalidCalendarTimezone(timezone);
  }
  return timezone;
}

const DAY_FORMATTER_CACHE = new Map();
// 某时区在某一瞬时相对于 UTC 的偏移（毫秒）。
function zonedOffsetMs(instantMs, timezone) {
  let formatter = DAY_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    DAY_FORMATTER_CACHE.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  // hour12:false 在部分时区/i&t 组合下会把午夜格式化成 24 点。
  const localAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour % 24, values.minute, values.second);
  return localAsUtc - Math.floor(instantMs / 1000) * 1000;
}

// day（YYYY-MM-DD）在该时区的 start-of-day 对应的 UTC 瞬时。
function zonedStartOfDay(day, timezone) {
  const [year, month, date] = day.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, date, 0, 0, 0, 0);
  let instant = wallClockAsUtc;
  // 偏移本身是 instant 的函数（DST），故迭代收敛；本地日边界总是整秒，2 轮足够。
  for (let attempt = 0; attempt < 3; attempt += 1) instant = wallClockAsUtc - zonedOffsetMs(instant, timezone);
  return instant;
}

function addCalendarDays(day, days) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

function isValidCalendarDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return false;
  // ATOMICWRITE-1：先判是否合法日期再调 toISOString()。`2026-13-45` 之类形状对但
  // 月/日越界的输入，`new Date(...)` 是 Invalid Date，直接 `.toISOString()` 会抛
  // `RangeError: Invalid time value` —— 异常在**校验函数内部**跑掉，于是它没能变成
  // "校验失败"（`return false`），而是一路冒到全局 catch，把参数错误显示成 500。
  const probe = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(probe.getTime())) return false;
  return addCalendarDays(day, 1) !== day && probe.toISOString().slice(0, 10) === day;
}

function localDayUtcWindow(day, timezone) {
  const start = zonedStartOfDay(day, timezone);
  const nextStart = zonedStartOfDay(addCalendarDays(day, 1), timezone);
  return { startInclusive: new Date(start).toISOString(), endInclusive: new Date(nextStart - 1).toISOString() };
}

// DAYRECALL-2：把「某一天」做成**硬条件**的判定谓词。
//
// 起因（本单实测）：`search()` 根本没有 `calendarDate` 参数，`/v1/search` 与
// `/mcp memory_search` 一旦带上查询词，日期就被整条丢掉 —— 问「10/10 聊了什么（带词）」
// 拿回来的是 10-19 的三条。那比"0 条"更坏：它自信地答错。
//
// 这里**刻意与 timeline() 共用同一个谓词**：
//   - 优先用不可变的 `capturedAt` 换算到**查询时区**的日历日 —— 同一瞬时在不同时区属于
//     不同本地日，写入时物化的 `calendarDate` 不能跨时区复用（timeline 已有同一取舍）；
//   - `capturedAt` 缺失时才退回物化的 `calendarDate` 字段（当前数据 0 条属于这种情况）。
// 两条入口因此不可能分叉：枚举与检索问「这一天」问的是同一个问题。
async function fallsOnCalendarDay(item, day, zone) {
  const frontmatter = item?.frontmatter ?? (item?.path ? parseFrontmatter((await readTextFile(item.path).catch(() => null)) ?? "").frontmatter : {});
  const raw = unquote(frontmatter?.capturedAt ?? frontmatter?.captured_at);
  const capturedMs = raw ? parseTimestamp(raw) : NaN;
  const clock = eventClockValue(frontmatter ?? {});
  const instant = Number.isFinite(capturedMs) ? capturedMs : clock.value;
  if (Number.isFinite(instant)) return calendarDateInZone(instant, zone) === day;
  const materialized = unquote(frontmatter?.calendarDate);
  return Boolean(materialized) && materialized === day;
}

async function filterByCalendarDay(items, { day, zone }) {
  const out = [];
  for (const item of items ?? []) if (await fallsOnCalendarDay(item, day, zone)) out.push(item);
  return out;
}

// 某一瞬时落在某时区的哪个本地日（YYYY-MM-DD）。派生自 capturedAt，随时可重算。
function calendarDateInZone(instantMs, timezone) {
  if (!Number.isFinite(instantMs)) return null;
  const formatter = DAY_FORMATTER_CACHE.get(`${timezone}|date`) ?? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  DAY_FORMATTER_CACHE.set(`${timezone}|date`, formatter);
  const values = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// DAY-INTERVAL-1：把「一天」的语义收敛到一处 —— 两条入口都由本函数决定边界。
//
// 统一后的口径（写死）：
//   - **纯日期**（`YYYY-MM-DD`，即 `parseExplicitDay` 认得的形态）走**本地日历日**，
//     时区取 `calendarTimezone`；`until` 是**排他**上界（= 次日本地零点），
//     也就是半开 `[startOfDay, nextDayStartOfDay)`。
//     ⇒ 与 `calendarDate` **逐字节同一套算法**，所以两条入口给出同一个答案。
//   - **带时刻**的输入是**瞬时**边界，按原样使用、**不做**按天扩张
//     （调用方说"截止到这个瞬间"就截止到这个瞬间）。
//   - 回显 `resolvedRange` 时，`until` 用**闭**口径（最后一毫秒）以贴合仓库既有的
//     `since/until` 习惯；**排他**上界另以 `untilExclusive` 给出（真值是它）。
//
// 研究依据：`research/time-tagging-and-relative-date-parsing.md` 明确要求统一 `[start, end)`，
// 且**不许**用 `23:59:59.999` 当边界（精度迁移 / DST / 月长都会踩）。
function resolveCalendarRange({ calendarDate, calendarTimezone = "UTC", since, until }) {
  const timezone = normalizedTimezone(calendarTimezone);
  if (calendarDate) {
    // ATOMICWRITE-1：非法 calendarDate 是**调用方参数问题**，必须回 4xx（此前冒成 500 INTERNAL）。
    if (!isValidCalendarDay(calendarDate)) throw invalidCalendarDate(calendarDate);
    const startDay = zonedStartOfDay(calendarDate, timezone);
    const nextDay = zonedStartOfDay(addCalendarDays(calendarDate, 1), timezone);
    // 对外统一成闭口径 until + 独立排他上界（与裸日期那条路**完全同形**）。
    return { since: new Date(startDay).toISOString(), until: new Date(nextDay - 1).toISOString(), untilExclusive: new Date(nextDay).toISOString(), calendarTimezone: timezone, calendarDate };
  }
  // 纯日期形式的 since/until → 本地日边界。
  const sinceDay = parseExplicitDay(since);
  const untilDay = parseExplicitDay(until);
  let untilExclusive = null;
  if (sinceDay) {
    if (!isValidCalendarDay(sinceDay)) throw invalidCalendarDate(sinceDay);
    since = new Date(zonedStartOfDay(sinceDay, timezone)).toISOString();
  }
  if (untilDay) {
    if (!isValidCalendarDay(untilDay)) throw invalidCalendarDate(untilDay);
    // 排他上界 = **次日**本地零点；闭口径 until 由它减 1ms 派生（不是 23:59:59.999 硬编码）。
    const nextDayStart = zonedStartOfDay(addCalendarDays(untilDay, 1), timezone);
    untilExclusive = new Date(nextDayStart).toISOString();
    until = new Date(nextDayStart - 1).toISOString();
  } else if (typeof until === "string" && until.trim()) {
    // 带时刻的输入：**瞬时**上界，不做按天扩张；排他上界就是它 + 1ms。
    const parsed = parseTimestamp(until.trim());
    if (Number.isFinite(parsed)) untilExclusive = new Date(parsed + 1).toISOString();
  }
  return { since, until, untilExclusive, calendarTimezone: timezone, calendarDate: null };
}

// 只有**恰好是** YYYY-MM-DD 才算"纯日期"；带时刻的串原样返回 null（瞬时语义）。
function parseExplicitDay(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : null;
}

function encodeTimelineCursor(value) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeTimelineCursor(cursor) { try { const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")); return Number.isFinite(value.capturedAt) && typeof value.id === "string" ? value : null; } catch { return null; } }

function parseBoundary(value, isUntil) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return isUntil ? parseTimestamp(`${text}T23:59:59.999`) : parseTimestamp(`${text}T00:00:00.000`);
  }
  const ms = parseTimestamp(text);
  return Number.isFinite(ms) ? ms : null;
}

async function filterByOccurredTime(items, { since = null, until = null } = {}) {
  const sinceMs = parseBoundary(since, false);
  const untilMs = parseBoundary(until, true);
  if (sinceMs === null && untilMs === null) return items ?? [];
  const out = [];
  for (const item of items ?? []) {
    let frontmatter = item.frontmatter;
    if (!frontmatter) {
      const text = await readTextFile(item.path).catch(() => null);
      if (!text) continue;
      frontmatter = parseFrontmatter(text).frontmatter;
    }
    const range = itemTimeRange(frontmatter, item.path);
    if (!range) continue; // 无时间 → 按时间问句不召回
    const start = range.start;
    const end = range.end ?? start;
    if (sinceMs !== null && end < sinceMs) continue;   // 条目区间整体早于 since
    if (untilMs !== null && start > untilMs) continue; // 条目区间整体晚于 until
    out.push(item);
  }
  return out;
}

function parseFrontmatterList(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return text.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean); }
}

// atomic write: temp file in the same directory, then rename (same volume = atomic)
// ATOMICWRITE-1：收敛到统一助手（rename 遇 EPERM/EACCES/EBUSY 会短退避重试）。
async function atomicWriteFile(targetPath, content) {
  return sharedAtomicWriteFile(targetPath, content);
}

// daily notes: only top-level files of the data root (project activity log)
async function topLevelFiles(root, exts) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => !e.isDirectory() && exts.includes(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}
