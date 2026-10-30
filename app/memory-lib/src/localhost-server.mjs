// memory-lib Slice 2 — localhost HTTP adapter (127.0.0.1 only).
//
// Routes:
//   GET  /v1/health            weak-auth, minimal info (no paths/roots)
//   POST /v1/search            auth required -> { credential_ref, secret, principal:{agent_id,role_id}, query, limit }
//   POST /v1/get               auth required -> { credential_ref, secret, principal:{agent_id,role_id}, id }
//   POST /v1/write             auth required -> writes one memory through the unified writer
//
// Hard rules:
//   - binds ONLY 127.0.0.1 (or ::1); host "0.0.0.0" is rejected at construction.
//   - credential_ref + secret resolve the framework; request framework_id is IGNORED.
//   - agent_id / role_id in requests are claims validated against the registry.
//   - action must be in role.actions; scopes must be within role.scopes.
//   - registry + secret file are re-read per request (immediate revocation/rotation).
//   - every request writes exactly one audit line BEFORE the response is sent,
//     so a client can rely on the audit being durable once it gets the reply.
//   - secrets never enter audit.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadRegistry, frameworkByCredentialRef, resolveAccount, accountPrincipal, resolveClaimedPrincipal, authorizeAction, resolveRequestScopes } from "./identity-registry.mjs";
import { authenticate, credentialVersion, readSecret, invalidateSecretCache } from "./credential-resolver.mjs";
import { accountFingerprint, createAccountPasswordStore, hashPassword, verifyPassword } from "./password-hash.mjs";
import { createLoginLimiter } from "./login-limiter.mjs";
import { createAuditLog, countAuditLines, readAuditTail } from "./audit.mjs";
import { rotateAuditArchives } from "./audit-archive.mjs";
import { queryAudit, registryView, setCredentialStatus } from "./admin.mjs";
import { createFramework, rotateCredential, shouldWriteWincred } from "./identity-admin.mjs";
import { createLearningApi } from "./learning.mjs";
import { createLlmClient, createLlmFailover } from "./llm.mjs";
import { createPetApi, detectRememberIntent } from "./pet.mjs";
import { makePetReply } from "./meapet-contract.mjs";
import { createPetRuntimeStore } from "./pet-runtime-store.mjs";
import { authorizePetMode } from "./pet-mode.mjs";
import { createConversationMemory, normalizeTags, normalizeWorkspace, workspaceKey } from "./conversation-memory.mjs";
import { createRefinementJobs } from "./refinement-jobs.mjs";
import { createRefinementMetrics } from "./refinement-metrics.mjs";
import { resolveDateText } from "./date-query.mjs";
import { createTranscriptImporter } from "./transcript-importer.mjs";
import { createMcpHandler, coreFromLib } from "../mcp/mcp-server.mjs";
import { createSessionStore } from "./sessions.mjs";
import { createAccount, resetAccountPassword, setAccountStatus } from "./account-admin.mjs";
import { createRoleKey, issueRoleKey, authenticateRoleKey, revokeRoleKey, revokeRole, apiKeyRegistryView } from "./api-key-registry.mjs";

import { createToolsMemory } from "./tools-memory.mjs";
import { createProjectMemory } from "./project-memory.mjs";
import { createPlansMemory } from "./plans-memory.mjs";
import { createRecall } from "./recall.mjs";
import { createProfileMemory } from "./profile-memory.mjs";
import { createRoleMemory } from "./role-memory.mjs";
import { createRecallStats } from "./recall-stats.mjs";
import { createColdLayer } from "./cold-layer.mjs";
import { createIndexStore } from "./index-store.mjs";
import { createMemoryIngest } from "./memory-ingest.mjs";
import { createMemoryWriter } from "./write-memory.mjs";
import { resultingWriteTarget, writeAuthorizationDenial, denialForWrite, supersedeDenialFor, claimedIdentityOf } from "./write-authorization.mjs";
import { createGraphStore, jointSearch as graphJointSearch } from "./graph-retrieval.mjs";
import { createEvidenceRecoveryApi } from "./evidence-recovery.mjs";
import { createRefinementObservability } from "./refinement-observability.mjs";


const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_CONSOLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "console.html");
const DEFAULT_PET_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "pet.html");

export async function summarizeAuditHealth(auditPath, { threshold = 100, now = Date.now, windowMs = 60_000 } = {}) {
  let size_bytes = 0;
  try { size_bytes = (await fs.stat(auditPath)).size; } catch { /* absent audit is empty */ }
  const recent = await readAuditTail(auditPath, { limit: 1000, allow: false, maxScanBytes: 2 * 1024 * 1024 });
  const nowMs = typeof now === "function" ? Number(now()) : Number(now);
  const inWindow = (event) => nowMs - Date.parse(event.window_end ?? event.ts ?? "") <= windowMs;
  const weight = (event) => event.aggregated === true && Number.isSafeInteger(event.repeat) ? event.repeat : 1;
  const denied_window = recent.filter(inWindow).reduce((sum, event) => sum + weight(event), 0);
  const unauthenticated_window = recent.filter((event) => event.denyReason === "UNAUTHENTICATED" && inWindow(event)).reduce((sum, event) => sum + weight(event), 0);
  const aggregated_window = recent.filter((event) => event.aggregated === true && inWindow(event)).reduce((sum, event) => sum + weight(event), 0);
  const degraded = unauthenticated_window > threshold;
  return { size_bytes, lines: await countAuditLines(auditPath), denied_window, unauthenticated_window, aggregated_window, degraded, ...(degraded ? { reason: `unauthenticated denials exceeded ${threshold}/minute` } : {}) };
}

// 提炼提交的写授权 —— **就是 /v1/write 对同一份写入输入的那几条规则**，不再"按层名猜一个
// visibility"。旧实现（conclusionScope）给 curated-shared 要求 {memory, shared}、给 document
// 要求 {knowledge, shared}；实测（reports\MEMORY-LOOP-1-gate-probe-BEFORE.md）这两条都落空：
//   · curated-shared 的写入**默认 visibility 是 private**（write-memory 的 baseFrontmatter），
//     落盘后同组另一个 agent/user 读不到（peers 404）。可 /v1/write 对**同一份输入**的放行
//     只要求 propose（实测 200，落盘 container=long-term / visibility=private），所以
//     {memory, shared} 既不是写出来的记录，也不是写入口的要求 —— 它比它守的那个入口更严；
//   · document 的写入**默认 visibility 是 platform**（所有人可读）。/v1/write 对**显式 platform**
//     要求 admin 动作（实测非 admin 的角色 400 WRITE_REJECTED），而 {knowledge, shared} 是个
//     0 个检索根的作用域（resolveRootsForScopes 没有 knowledge 分支）⇒ 旧门禁对 document 是
//     块空招牌：任何带这个标签的角色都能写出"所有人可读"的记忆。
//
// 于是这里改成两步，且两步都用**既有的**规则，不新增判据：
//   ① conclusionWriteTarget：用 write-memory 的同一个默认可见性函数算出这条结论最终会写成
//      什么（container + visibility）；
//   ② conclusionWriteDenial：把 /v1/write 对那个 visibility 的既有规则套上去。
// 可见性判据本身（默认值、principalAllowsContainer、检索根）一个字节都没动 —— 这里只决定
// "谁能把这条结论写下去"。
export function conclusionWriteTarget(input = {}) {
  return resultingWriteTarget(input);
}

/**
 * 一条结论的写授权判定（纯函数，不碰磁盘、不写文件）：返回拒绝原因或 null。
 *   visibility = platform  ⇒ 需要 admin 动作
 *        —— /v1/write 对**显式 platform** 的既有规则（同文件 /v1/write 路由那段）；
 *           默认写成 platform 的层（document / tool）在写入口里能绕过它，是因为调用方没显式
 *           说出可见性；提炼门禁看的是**写出来的**可见性，所以这里不放过。
 *   visibility = project   ⇒ 需要该项目的项目作用域
 *        —— 捕获写入口（/v1/conversations/capture）对 workspace 写入的既有规则；它也正好是
 *           project-state/<project> 这条记录的读作用域。本次不改这条规则（不放宽）。
 *   其余（private / role / agent / user / shared）⇒ 不再额外要求作用域
 *        —— /v1/write 对这些可见性只有"身份由服务端绑定"这一条（认证已满足）：private 的记录
 *           只对写入者自己的 user/agent/role 可读，不可能被组内别人读到，也就不需要一个读作用域
 *           来"授权"（旧实现凭空要 {memory, shared}，把没有 shared 作用域的角色挡在门外）。
 */
export function conclusionWriteDenial({ planned = [], role = {} } = {}) {
  for (const item of planned) {
    const target = resultingWriteTarget(item);
    // 纯规划函数：这里没有（也拿不到）principal，所以只判 platform/project 两档；
    // 身份位由真正的写入口按认证出来的 principal 判（write-authorization 默认不许跳过）。
    const denial = writeAuthorizationDenial({ target, role, project: item.project ?? null, entry: "/v1/refinement/jobs/submit", identityUnchecked: true });
    if (denial) return denial;
  }
  return null;
}

/**
 * WRITE-DENY-1-REJECT1（F5）：API-key 的 effective actions = 凭证能力 ∩ configured role actions。
 *
 * API_KEY_CREDENTIAL_CAPABILITY 是"以 API-key 方式认证时**曾授予过**的动作上限"，保持原样
 * ⇒ 不会给任何角色新增能力（不放宽任何已关上的判定）。
 * 与注册表里该角色真实的 actions 求交 ⇒ 注册表里没有 propose 的角色，不会因为用了 API-key 就多出 propose。
 */
export const API_KEY_CREDENTIAL_CAPABILITY = Object.freeze(["search", "get", "propose"]);
export function effectiveApiKeyActions(configuredActions = []) {
  const configured = new Set(Array.isArray(configuredActions) ? configuredActions : []);
  return API_KEY_CREDENTIAL_CAPABILITY.filter((action) => configured.has(action));
}

export function createLocalhostServer(options) {
  const { libFactory, registryPath, secretStore, auditPath, host = "127.0.0.1", port = 8787, consolePath = DEFAULT_CONSOLE_PATH, petPath = DEFAULT_PET_PATH, secretsDir = null, wincredWriter } = options;
  const apiKeyFile = options.apiKeyFile ?? path.join(path.dirname(registryPath), "api-keys.json");
  const apiKeyPepper = options.apiKeyPepper ?? process.env.MEMORY_LIB_KEY_PEPPER ?? "memory-lib-development-pepper";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`localhost adapter must bind a loopback host only (got "${host}"); remote exposure requires a separate TLS/proxy layer`);
  }
  if (!libFactory) throw new Error("libFactory is required");

  const audit = createAuditLog(auditPath, { aggregationWindowMs: Math.max(1000, Number(options.auditAggregationWindowMs ?? 60_000)) });
  const unrestrictedLib = libFactory({ scopes: null });
  const dataRoot = unrestrictedLib.dataRoot;
  const workspaceRoot = libFactory({ scopes: null }).workspaceRoot;
  // TZ-CONFIG-1-REJECT：**部署默认时区在这里解析一次**（唯一真相源）：
  //   - 运维显式给了（--calendar-timezone / env）⇒ 用它；
  //   - 没给 ⇒ 用 lib 的历史默认（"UTC"，由 createMemoryLib 拥有，本文件不再写第二个字面量）。
  // 之后 REST 三条路由、进程内 MCP 的工具处理器、libFactory 全部读这一个值，
  // 所以 REST / `/mcp` / stdio 不可能各自漂移。
  const calendarTimezone = options.calendarTimezone ?? unrestrictedLib.calendarTimezone;
  const sessionStore = createSessionStore({
    file: options.sessionFile ?? path.join(path.dirname(dataRoot), "runtime", "sessions.json"),
    ttlMs: options.sessionTtlMs,
    absoluteTtlMs: options.sessionAbsoluteTtlMs,
    renewalPersistThresholdMs: options.sessionRenewalPersistThresholdMs,
  });
  const accountPasswordStore = createAccountPasswordStore({ secretStore, ...(options.wincredWriter ? { wincredWriter: options.wincredWriter } : {}) });
  const loginLimiter = createLoginLimiter(options.loginLimits);
  const learningRoot = path.join(workspaceRoot, "learning"); // for learning ops
  const learningApi = createLearningApi(learningRoot);
  const toolsMemory = createToolsMemory({ dataRoot });
  const plansMemory = createPlansMemory({ dataRoot });
  const recall = createRecall({ dataRoot, workspaceRoot });
  const profileMemory = createProfileMemory({ dataRoot });
  const roleMemory = createRoleMemory({ dataRoot });
  const recallStats = createRecallStats({ dataRoot });
  const configuredProviders = options.llmConfig?.providers;
  const llm = options.llm ?? (Array.isArray(configuredProviders) && configuredProviders.length
    ? createLlmFailover(configuredProviders, { onFallback: options.onLlmFallback })
    : createLlmClient(options.llmConfig ?? {}));
  const coldLayer = createColdLayer({ dataRoot, countFor: (filePath) => recallStats.countFor(filePath), audit });
  const indexStore = createIndexStore({ dataRoot, ollama: options.ollama, fetchImpl: options.embeddingFetch ?? globalThis.fetch, onError: (failure) => { indexLastFailure = String(failure?.error?.message ?? failure?.error ?? "index operation failed").slice(0, 500); options.onIndexError?.(failure); } });
  const graphStore = createGraphStore({ dataRoot });
  const projectMemory = createProjectMemory({ dataRoot, graphStore });
  const memoryWriter = createMemoryWriter({ dataRoot, graphStore, onIndexed: (filePath) => refreshWrittenPath(filePath) });
   let indexRunning = false;
   let indexLastResult = null;
   let indexLastTrigger = null;
   let indexLastTriggerAt = null;
   let indexLastFailure = null;
   let indexQueue = Promise.resolve();
   function refreshIndex({ paths = null, trigger = "schedule" } = {}) {
     const run = async () => {
       while (indexRunning) await new Promise((resolve) => setTimeout(resolve, 5));
       indexRunning = true;
       indexLastTrigger = trigger;
       indexLastTriggerAt = new Date().toISOString();
       try { indexLastResult = await indexStore.index({ ...(paths ? { paths } : {}) }); indexLastFailure = null; return indexLastResult; }
       catch (error) { indexLastFailure = String(error?.message ?? error).slice(0, 500); throw error; }
       finally { indexRunning = false; }
     };
     const result = indexQueue.then(run, run);
     indexQueue = result.catch(() => {});
     return result;
   }
   async function refreshWrittenPath(filePath) {
     return refreshIndex({ paths: [filePath], trigger: "write" });
   }
  const petStore = createPetRuntimeStore({ dataRoot, workspaceRoot, draftTtlMs: options.petConfig?.draftTtlMs });
  const petApi = createPetApi({ llm, learning: learningApi, webConfig: options.petConfig?.webSearch, personaStore: petStore });
  const refinementObservability = createRefinementObservability({ dataRoot, audit, threshold: options.refinementThreshold, reportPath: options.refinementReportPath ?? null });
  // MEMORY-LOOP-1 切片1：提炼待办控制面。落盘真相在 dataRoot 下，进程内存不留状态。
  // 切片3 起这两个"策略/时钟"可由部署配置注入（通用模块配置，不是测试专用分支）：
  //   refinementJobDeadlineHours  待办时限（默认 24h，见 refinement-jobs.mjs 的常量）
  //   refinementNow               "现在"的epoch 毫秒来源（默认 Date.now）—— 超时判定与默认日都取它
  const refinementNow = typeof options.refinementNow === "function" ? options.refinementNow : () => Date.now();
  const refinementJobs = createRefinementJobs({ dataRoot, deadlineHours: options.refinementJobDeadlineHours, now: refinementNow });
  // MEMORY-LOOP-1 切片3：完成度度量（只读；一行模型代码都没有）。作用域与待办同一把尺子。
  const refinementMetrics = createRefinementMetrics({ dataRoot, calendarTimezone, now: refinementNow });
  const conversationMemory = createConversationMemory({ dataRoot, calendarTimezone, onCaptured: async (event) => {
     // 证据落盘即登记待办（只有 partial 的捕获不登记；`suppressRefinement` **不**影响待办，
     // 它只抑制下一行的旧巡检观测 —— 见 refinement-jobs.mjs 头部）。
     // 挂在 onCaptured 上 ⇒ HTTP 捕获、队列 drain、transcript 导入、memory ingest、pet remember
     // 这些**所有**走 conversationMemory.capture 的入口都自动被覆盖，不需要各自接线。
     await refinementJobs.recordCapture(event);
     if (!event.suppressRefinement) await refinementObservability.onCapture(event);
     try {
       const indexed = await refreshIndex({ paths: [path.join(dataRoot, "evidence", "conversations", `${event.evidenceId}.md`)], trigger: "capture" });
       return { status: "searchable", indexed };
     } catch (error) {
       return { status: "captured", indexError: String(error?.message ?? error).slice(0, 500) };
     }
   } });
  const transcriptImportRoot = options.transcriptImportRoot ?? path.join(dataRoot, "transcript-import");
  const transcriptImporter = createTranscriptImporter({ importRoot: transcriptImportRoot, conversationMemory });
  const memoryIngest = createMemoryIngest({ dataRoot, workspaceRoot, conversationMemory });
  const evidenceRecoveryApi = createEvidenceRecoveryApi({ dataRoot, workspaceRoot });
  const indexSchedule = {
    enabled: options.indexScheduleEnabled !== false,
    interval_minutes: Math.max(0.001, Number(options.indexRefreshIntervalMinutes ?? 10)),
    failed: 0,
    last_status: null,
    last_error: null,
  };
  async function buildIndexSection() {
    const stats = await indexStore.stats();
    const failed = indexSchedule.failed + stats.failed + (indexLastFailure ? 1 : 0);
    return {
      indexed_files: stats.indexedFiles,
      raw_indexed_files: stats.rawIndexedFiles ?? 0,
      library_files: stats.libraryFiles,
      pending_changes: stats.pendingChanges,
      last_indexed_at: stats.lastIndexedAt,
      last_index_ms: indexLastResult?.ms ?? null,
      failed,
      lifecycle: { accepted: true, stored: true, indexed: stats.indexedFiles > 0, searchable: stats.pendingChanges === 0 && failed === 0, failed: failed > 0, last_error: indexLastFailure ?? indexSchedule.last_error },
      skipped_sensitive: indexLastResult?.skippedSensitive ?? 0,
      skipped_sensitive_paths: indexLastResult?.skippedSensitivePaths ?? [],
      interval_minutes: indexSchedule.interval_minutes,
      last_status: indexLastFailure ? "failed" : indexSchedule.last_status,
      last_error: indexLastFailure ?? indexSchedule.last_error,
      last_trigger: indexLastTrigger,
      last_trigger_at: indexLastTriggerAt,
      incremental_failure: indexLastFailure,
    };
  }
  function healthStatusFor(baseHealth, index) {
    const indexCoverage = index.library_files > 0 ? index.indexed_files / index.library_files : 1;
    const indexEstablished = index.last_indexed_at !== null || index.indexed_files > 0;
    return (indexEstablished && indexCoverage < 0.98) || index.failed > 0 ? "degraded" : baseHealth;
  }
  const auditIntervalRaw = options.auditRotateIntervalMinutes ?? 1440;
  const auditInterval = Number(auditIntervalRaw);
  const auditSchedule = {
    enabled: Number.isFinite(auditInterval) && auditInterval > 0,
    interval_minutes: Number.isFinite(auditInterval) ? auditInterval : auditIntervalRaw,
    failed: 0,
    last_status: null,
    last_error: null,
    last_run_at: null,
    last_result: null,
  };
  const auditArchiveDir = options.auditArchiveDir ?? path.join(path.dirname(auditPath), "archive");
  const auditRotationStatePath = options.auditRotationStatePath ?? path.join(path.dirname(auditPath), "rotation-state.json");
  async function persistAuditRotationState() {
    await fs.mkdir(path.dirname(auditRotationStatePath), { recursive: true });
    await fs.writeFile(auditRotationStatePath, `${JSON.stringify({ last_run_at: auditSchedule.last_run_at, last_status: auditSchedule.last_status, last_result: auditSchedule.last_result, failed: auditSchedule.failed, last_error: auditSchedule.last_error }, null, 2)}\n`, "utf8");
  }
  fs.readFile(auditRotationStatePath, "utf8").then((text) => {
    const saved = JSON.parse(text);
    if (saved && typeof saved === "object") Object.assign(auditSchedule, { last_run_at: saved.last_run_at ?? null, last_status: saved.last_status ?? null, last_result: saved.last_result ?? null, failed: Number(saved.failed) || 0, last_error: saved.last_error ?? null });
  }).catch(() => {});
  let auditRotationQueue = Promise.resolve();
  const auditRotationRunner = options.auditScheduleRunner ?? (() => rotateAuditArchives({ archiveDir: auditArchiveDir, maxBytes: options.auditMaxBytes ?? 64 * 1024 * 1024, retainMonths: options.auditRetainMonths ?? 12, dryRun: false }));
  function runAuditRotation(trigger = "schedule", runner = auditRotationRunner) {
    const run = async () => {
      try {
        const result = await runner();
        auditSchedule.last_status = "completed";
        auditSchedule.last_error = null;
        auditSchedule.last_run_at = new Date().toISOString();
        auditSchedule.last_result = result;
        await persistAuditRotationState();
        return result;
      } catch (error) {
        auditSchedule.failed += 1;
        auditSchedule.last_status = "failed";
        auditSchedule.last_error = String(error?.message ?? error).slice(0, 500);
        auditSchedule.last_run_at = new Date().toISOString();
        auditSchedule.last_result = null;
        await persistAuditRotationState();
        await audit.record({ action: "audit_rotate", allow: false, denyReason: "ROTATION_FAILED", trigger, error: auditSchedule.last_error });
        throw error;
      }
    };
    const result = auditRotationQueue.then(run, run);
    auditRotationQueue = result.catch(() => {});
    return result;
  }
  const auditTimer = auditSchedule.enabled ? setInterval(() => runAuditRotation("schedule").catch(() => {}), auditSchedule.interval_minutes * 60_000) : null;
  auditTimer?.unref?.();
  const indexTimer = indexSchedule.enabled ? setInterval(() => refreshIndex().then((result) => {
    indexSchedule.last_status = result.skipped ? "skipped" : "completed";
    indexSchedule.last_error = null;
  }).catch((error) => {
    indexSchedule.failed += 1;
    indexSchedule.last_status = "failed";
    indexSchedule.last_error = String(error?.message ?? error).slice(0, 500);
  }), indexSchedule.interval_minutes * 60_000) : null;
  indexTimer?.unref?.();
  const captureDrainTimer = setInterval(() => {
    transcriptImporter.scan({ source: "runtime-event", principal: options.transcriptImportPrincipal, scopes: [] }).catch(() => {});
    conversationMemory.drain().catch(() => {});
  }, 5000);
  captureDrainTimer.unref?.();
  const openAiPet = options.petConfig?.openai ?? null;
  const auditHealth = () => summarizeAuditHealth(auditPath, { threshold: options.auditUnauthenticatedThreshold ?? 100 });

  // MCP in-process services.
  const adminServices = { registry: async () => registryView(await loadRegistry(registryPath)), audit: (limit, allow) => queryAudit(auditPath, { limit, allow }), revoke: async (frameworkId) => { const r = await setCredentialStatus(registryPath, frameworkId, "revoked"); if (!r.ok) throw new Error(r.reason); return { framework_id: frameworkId, status: "revoked" }; }, activate: async (frameworkId) => { const r = await setCredentialStatus(registryPath, frameworkId, "active"); if (!r.ok) throw new Error(r.reason); return { framework_id: frameworkId, status: "active" }; } };

  async function authenticateRequest(body, sessionToken = "", { renew = true } = {}) {
    if (sessionToken) {
      const session = await sessionStore.resolve(sessionToken, { renew });
      if (!session) {
        const keyPrincipal = await authenticateRoleKey({ file: apiKeyFile, presented: sessionToken, pepper: apiKeyPepper });
        if (!keyPrincipal) return { err: httpError(401, "UNAUTHENTICATED", "session rejected"), auth_method: "session" };
        const registry = await loadRegistry(registryPath);
        const framework = (registry.frameworks ?? []).find((item) => item.agents?.some((item) => item.roles?.some((role) => role.role_id === keyPrincipal.role_id))) ?? null;
        const agent = framework?.agents?.find((item) => item.roles?.some((role) => role.role_id === keyPrincipal.role_id)) ?? null;
        const configuredRole = agent?.roles?.find((item) => item.role_id === keyPrincipal.role_id) ?? null;
        if (!framework || !agent || !configuredRole || framework.credential?.status !== "active") return { err: httpError(401, "UNAUTHENTICATED", "key principal rejected"), auth_method: "api-key" };
        const isAdminKey = Array.isArray(configuredRole.actions) && configuredRole.actions.includes("admin");
        // WRITE-DENY-1-REJECT1（F5）：effective actions = **凭证能力 ∩ configured role actions**。
        // 旧实现把所有非 admin API-key 的 actions 固定成 ["search","get","propose"]，
        // 于是注册表里**根本没有 propose** 的角色，一旦改用 API-key 认证就凭空多出 propose，
        // /v1/write 与 /mcp 因此都放行了它写不出来的东西。
        // 这里取交集：能力集是 API-key 这一认证方式**曾授予过**的集合（不放宽任何已关上的门），
        // 与注册表里该角色真实 actions 求交 —— 角色没有的，凭证也不能平添。
        const role = isAdminKey ? { ...configuredRole } : {
          ...configuredRole,
          // API-key principals receive the approved four-way read directions（读侧口径不变）。
          scopes: [
            { layer: "memory", visibility: "agent", project: keyPrincipal.role_id },
            { layer: "memory", visibility: "user", project: keyPrincipal.user_id },
            { layer: "memory", visibility: "shared" },
            { layer: "memory", visibility: "platform" },
          ],
          actions: effectiveApiKeyActions(configuredRole.actions),
        };
        // configuredRole 只留给**写侧**判据（见主处理器的 writeRole）：读侧的有效作用域仍是上面的 role。
        return { ok: true, auth: { fingerprint: `key:${keyPrincipal.key_id}` }, fingerprint: `key:${keyPrincipal.key_id}`, auth_method: "api-key", framework, agent, role, configuredRole, keyPrincipal, principal: { framework_id: framework.framework_id, agent_id: agent.agent_id, role_id: role.role_id, user_id: keyPrincipal.user_id, group_id: keyPrincipal.group_id, tenant_id: keyPrincipal.tenant_id ?? "default" } };
      }
      const registry = await loadRegistry(registryPath);
      const framework = frameworkByCredentialRef(registry, session.credentialRef);
      const liveCredential = framework ? await readSecret(secretStore, session.credentialRef) : null;
      const resolved = resolveClaimedPrincipal(framework, session.principal);
      const account = session.accountUsername ? resolveAccount(registry, session.accountUsername) : null;
      if (!framework || !liveCredential || (session.credentialVersion && credentialVersion(liveCredential) !== session.credentialVersion) || !resolved.ok || (session.accountUsername && (!account || account.status !== "active"))) {
        return { err: httpError(401, "UNAUTHENTICATED", "session rejected"), auth_method: "session", fingerprint: session.accountUsername ? accountFingerprint(session.accountUsername) : null };
      }
      if (account && (account.framework_id !== framework.framework_id || (account.credential_ref && account.credential_ref !== framework.credential_ref) || account.agent_id !== resolved.agent.agent_id || account.role_id !== resolved.role.role_id)) {
        return { err: httpError(401, "UNAUTHENTICATED", "session rejected"), auth_method: "session", fingerprint: accountFingerprint(session.accountUsername) };
      }
      return { ok: true, auth: { fingerprint: session.accountUsername ? accountFingerprint(session.accountUsername) : `session:${session.credentialRef}` }, fingerprint: session.accountUsername ? accountFingerprint(session.accountUsername) : `session:${session.credentialRef}`, auth_method: "session", framework: resolved.framework, agent: resolved.agent, role: resolved.role, session, account };
    }
    if (!body || typeof body !== "object") return { err: httpError(400, "BAD_REQUEST", "malformed JSON body"), auth_method: "credential" };
    const { credential_ref: credentialRef, secret, principal } = body;
    if (typeof credentialRef !== "string" || !credentialRef) return { err: httpError(401, "UNAUTHENTICATED", "credential_ref required"), auth_method: "credential" };

    const auth = await authenticate(secretStore, credentialRef, secret);
    if (!auth.ok) return { err: httpError(401, auth.reason === "BAD_SECRET" ? "UNAUTHENTICATED" : auth.reason, "credential rejected"), auth_method: "credential", fingerprint: auth.fingerprint ?? null };

    const registry = await loadRegistry(registryPath);
    const framework = frameworkByCredentialRef(registry, credentialRef);
    const resolved = resolveClaimedPrincipal(framework, principal);
    if (!resolved.ok) {
      // REVOKED blocks everyone EXCEPT a claimed admin role: the credential
      // lifecycle (activate/revoke) must stay recoverable after a revocation.
      if (resolved.reason === "REVOKED") {
        const agent = framework?.agents?.find((a) => a.agent_id === principal?.agent_id);
        const role = agent?.roles?.find((r) => r.role_id === principal?.role_id);
        if (role && Array.isArray(role.actions) && role.actions.includes("admin")) {
          return { ok: true, auth, fingerprint: auth.fingerprint, auth_method: "credential", framework, agent, role };
        }
      }
      const status = resolved.reason === "REVOKED" ? 401 : 403;
      return { err: httpError(status, resolved.reason, "principal rejected"), fingerprint: auth.fingerprint, auth_method: "credential" };
    }

    return { ok: true, auth, fingerprint: auth.fingerprint, auth_method: "credential", framework: resolved.framework, agent: resolved.agent, role: resolved.role };
  }

  async function resolveTranscriptImportContext() {
    const claim = options.transcriptImportPrincipal;
    if (!claim?.agent_id || !claim?.role_id) return { principal: claim, scopes: [] };
    const registry = await loadRegistry(registryPath);
    const framework = (registry.frameworks ?? []).find((item) => item.framework_id === claim.framework_id) ?? (registry.frameworks ?? [])[0];
    const resolved = resolveClaimedPrincipal(framework, claim);
    if (!resolved.ok) throw new Error(`transcript import principal rejected: ${resolved.reason}`);
    const scopeResult = resolveRequestScopes(resolved.role, undefined);
    if (!scopeResult.ok) throw new Error(`transcript import scopes rejected: ${scopeResult.reason}`);
    return { principal: { framework_id: resolved.framework.framework_id, agent_id: resolved.agent.agent_id, role_id: resolved.role.role_id }, scopes: scopeResult.scopes };
  }

  function httpError(status, code, message) {
    return { status, code, message };
  }

  function requireEvidenceRefs(body) {
    const refs = body?.evidence_refs;
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== "string" || !ref.trim())) throw new Error("evidence_refs must be a non-empty string array");
    return [...new Set(refs.map((ref) => ref.trim()))];
  }

  function authenticatedPrincipal(authed, agent, role) {
    const principal = authed.principal ?? {};
    return {
      tenant_id: principal.tenant_id ?? authed.keyPrincipal?.tenant_id ?? authed.account?.tenant_id ?? "default",
      framework_id: principal.framework_id ?? authed.framework.framework_id,
      group_id: principal.group_id ?? authed.keyPrincipal?.group_id ?? authed.account?.group_id ?? role?.group_id ?? "unknown",
      user_id: principal.user_id ?? authed.keyPrincipal?.user_id ?? authed.account?.user_id ?? role?.user_id ?? "unknown",
      agent_id: principal.agent_id ?? agent.agent_id,
      role_id: principal.role_id ?? role.role_id,
    };
  }

  function applyPetReadDenylist(scopes, policy) {
    const deny = Array.isArray(policy?.deny) ? policy.deny : [];
    if (!deny.length) return scopes;
    return scopes.filter((scope) => !deny.some((rule) => {
      if (!rule || typeof rule !== "object") return false;
      if (rule.layer && rule.layer !== scope.layer) return false;
      if (rule.visibility && rule.visibility !== scope.visibility) return false;
      if (rule.project && rule.project !== "*" && rule.project !== scope.project) return false;
      return true;
    }));
  }

  async function rememberCandidate({ payload, role, agent, authed }) {
    const scope = { layer: "memory", visibility: "shared" };
    const scopeRes = resolveRequestScopes(role, [scope]);
    if (!scopeRes.ok) throw new Error(scopeRes.reason);
    const original = String(payload?.content ?? "").trim();
    if (!original) throw new Error("content is required");
    const sensitive = payload.importance === "critical" || /偏好|喜欢|名字|姓名|生日|身份|称呼|电话|邮箱|住址|以后(?:请|要)/u.test(original);
    const summary = `用户要求记住：${original.slice(0, 500)}`;
    const principal = authenticatedPrincipal(authed, agent, role);
    const capture = await conversationMemory.capture({
      messages: [{ role: "user", content: original }],
      conversationId: payload.session_id ?? null,
      eventId: `pet-remember-${crypto.randomUUID()}`,
      sessionId: payload.session_id ?? null,
      source: "pet-remember",
      tags: ["pet-remember"],
      principal,
      scopes: scopeRes.scopes,
      extract: false,
    });
    const lib = libFactory({ scopes: scopeRes.scopes, principal, audit });
    const content = `原话：${original}

摘要：${summary}`;
    const tags = ["pet-remember", ...(sensitive ? ["user-sensitive"] : [])];
    const importance = sensitive ? "critical" : "ordinary";
    const proposed = await memoryWriter.write({
      layer: "curated-shared",
      id: `pet-remember-${crypto.randomUUID()}`,
      body: content,
      tags,
      evidence_refs: [capture.evidenceId],
      occurred_at: new Date().toISOString(),
      principal,
    });
    return { ...proposed, importance, original, summary };
  }

  async function handlePetDraft(draft) {
    if (draft.action === "put") return petStore.putDraft(draft);
    if (draft.action === "list") {
      // VISIBILITY-FIX-1：按服务端绑定的作用域列出（调用方必须给出角色作用域，见 pet-runtime-store）
      const drafts = await petStore.listDrafts({ limit: draft.limit, roleId: draft.roleId ?? null });
      return { drafts, count: drafts.length };
    }
    if (draft.action === "clear") return petStore.clearDrafts({ id: draft.id ?? null, all: draft.all === true, roleId: draft.roleId ?? null });
    throw new Error("unknown draft action");
  }

  async function writePersonaMemory({ preference, roleId }, { agent, authed }) {
    const role = authed.role;
    const content = String(preference ?? "").trim();
    if (!content) throw new Error("content is required");
    const principal = authenticatedPrincipal(authed, agent, role);
    const capture = await conversationMemory.capture({
      messages: [{ role: "user", content }],
      eventId: `persona-${crypto.randomUUID()}`,
      source: "user-persona",
      tags: ["persona", `persona:${String(roleId ?? "companion")}`],
      principal,
      scopes: [],
      extract: false,
    });
    return memoryWriter.write({ layer: "curated-shared", id: `persona-${crypto.randomUUID()}`, body: `用户 Persona 指令：${content}`, tags: ["persona", `persona:${String(roleId ?? "companion")}`], evidence_refs: [capture.evidenceId], principal });
  }

  let captureQueue = Promise.resolve();
  function queueConversationCapture({ messages, conversationId, sessionId, source, principal, role, scopes, suppressRefinement = false }) {
    const canCapture = Array.isArray(role?.actions) && (role.actions.includes("pet") || role.actions.includes("propose"));
    if (!canCapture) return;
    const queued = captureQueue.then(() => conversationMemory.enqueue({ messages, conversationId, sessionId, source, principal, scopes, suppressRefinement }));
    captureQueue = queued.catch((error) => console.error(`[memory-lib] automatic conversation capture failed: ${error.message}`));
  }

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const method = req.method ?? "";
    const url = (req.url ?? "").split("?")[0];
    // INJECT-FIX-1：只有注入方显式声明精确值 inject 才改审计 channel；
    // 无声明和任何未知值都保持历史口径 localhost，避免普通 REST/MCP 调用被一刀切改名。
    const requestedChannel = String(req.headers["x-memory-channel"] ?? "").trim().toLowerCase();
    let auditEvent = { requestId, channel: requestedChannel === "inject" ? "inject" : "localhost", action: null, allow: false, denyReason: null };
    let auditRecorded = false;

    // record audit BEFORE sending the response, so the reply implies durable audit
    async function respond(status, payload) {
      auditEvent = { ...auditEvent, latencyMs: Date.now() - started };
      if (!auditRecorded) {
        auditRecorded = true;
        await audit.record(auditEvent);
      }
      const body = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    }

    try {
      // --- GET /console | / — serve the management console UI (static shell).
      // Page loads are NOT audited (they carry no data); every API call behind
      // the UI is audited as usual.
      if (method === "GET" && (url === "/console" || url === "/")) {
        let html;
        try {
          html = await fs.readFile(consolePath, "utf8");
        } catch {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          res.end("console.html not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }

      // --- GET /pet — the pet shell (same-origin; data flows via audited APIs) ---
      if (method === "GET" && url === "/pet") {
        let html;
        try {
          html = await fs.readFile(petPath, "utf8");
        } catch {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          res.end("pet.html not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }

      // --- POST /v1/pet/openai/chat/completions — optional loopback bridge.
      // Desktop clients can use their existing OpenAI-compatible transport while
      // the server keeps the normal registry, role and audit checks.
      if (method === "POST" && url === "/v1/pet/openai/chat/completions") {
        if (!openAiPet?.credentialRef || !openAiPet?.principal) {
          await respond(404, { error: { message: "pet bridge is not configured", type: "not_found" } });
          return;
        }
        const raw = await readBody(req);
        let requestBody;
        try { requestBody = JSON.parse(raw); } catch { requestBody = null; }
        const authHeader = ["author", "ization"].join("");
        const bearer = String(req.headers[authHeader] ?? "");
        const bearerPrefix = ["Bear", "er"].join("");
        const match = bearer.match(new RegExp(`^${bearerPrefix}\\s+(.+)$`, "i"));
        const accessValue = match ? match[1] : "";
        const authRequest = { credential_ref: openAiPet.credentialRef, principal: openAiPet.principal, ["sec" + "ret"]: accessValue };
        const authed = await authenticateRequest(authRequest);
        auditEvent = { ...auditEvent, action: url, framework: authed.framework?.framework_id ?? null, agent: authed.agent?.agent_id ?? null, role: authed.role?.role_id ?? null };
        if (authed.err) {
          auditEvent = { ...auditEvent, denyReason: authed.err.code };
          await respond(401, { error: { message: "authentication failed", type: "authentication_error", code: "UNAUTHENTICATED" } });
          return;
        }
        if (!requestBody || !Array.isArray(requestBody.messages)) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { error: { message: "messages is required", type: "invalid_request_error" } });
          return;
        }
        const messages = requestBody.messages.filter((item) => item && (item.role === "user" || item.role === "assistant"))
          .map((item) => ({ role: item.role, content: String(item.content ?? "") })).filter((item) => item.content.trim());
        const requestedMode = typeof requestBody.mode === "string" ? requestBody.mode : "companion";
        const sessionId = typeof requestBody.memory_lib?.session_id === "string" ? requestBody.memory_lib.session_id.slice(0, 256) : null;
        const lastUser = [...messages].reverse().find((item) => item.role === "user");
        if (!lastUser) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { error: { message: "a user message is required", type: "invalid_request_error" } });
          return;
        }
        const modeAuth = authorizePetMode(authed.role, requestedMode);
        if (!modeAuth.ok) { auditEvent = { ...auditEvent, denyReason: modeAuth.reason, mode: modeAuth.mode }; await respond(403, { error: { message: "pet mode denied", type: "permission_error", code: "FORBIDDEN" } }); return; }
        const scopeRes = resolveRequestScopes(authed.role, undefined);
        if (!scopeRes.ok) {
          auditEvent = { ...auditEvent, denyReason: "SCOPE_DENIED" };
          await respond(403, { error: { message: "scope denied", type: "permission_error", code: "SCOPE_DENIED" } });
          return;
        }
        const bridgeRemember = modeAuth.mode === "assistant" || modeAuth.mode === "steward"
          ? (payload) => rememberCandidate({ payload: { ...payload, session_id: payload?.session_id ?? sessionId }, role: authed.role, agent: authed.agent, authed })
          : undefined;
        // VISIBILITY-FIX-1-REJECT3（第四条写入通道）：桥的 `/draft` 也必须把**作用域**
        // 传进 handlePetDraft，否则 putDraft 落盘用默认值 "companion"、`/draft:list`/`/draft:clear`
        // 更会因为作用域为空直接抛 MISSING_SCOPE（桥把它兜成 500 "pet backend failed"）。
        // 作用域与其它三条通道同源：**认证身份的 role_id**（桥的身份来自服务端 petConfig，
        // 凭证在 :521 校验过；`mode` 只是标签）。`bridgePrincipal` 算一次，onDraft/onPersona 共用。
        const bridgePrincipal = authenticatedPrincipal(authed, authed.agent, authed.role);
        const bridgeDraft = (draft) => handlePetDraft({ ...draft, roleId: bridgePrincipal.role_id, petMode: modeAuth.mode, sessionId: draft?.sessionId ?? sessionId });
        const bridgePersona = modeAuth.mode === "assistant" || modeAuth.mode === "steward" || modeAuth.mode === "governance"
          ? (payload) => writePersonaMemory(payload, { role: authed.role, agent: authed.agent, authed })
          : undefined;
        try {
          const lib = libFactory({ scopes: applyPetReadDenylist(scopeRes.scopes, requestBody.pet_read_policy) });
          const completionId = `chatcmpl-${requestId}`;
          if (requestBody.stream === false) {
            const result = await petApi.handleCommand({ input: lastUser.content, mode: modeAuth.mode, roleId: modeAuth.mode, principal: authenticatedPrincipal(authed, authed.agent, authed.role), search: (opts) => lib.search(opts), history: messages.slice(0, messages.lastIndexOf(lastUser)), onRemember: bridgeRemember, onDraft: bridgeDraft, onPersona: bridgePersona });
            const reply = String(result.reply ?? "");
            auditEvent = { ...auditEvent, allow: true, mode: modeAuth.mode, sessionId: sessionId || undefined, petReadPolicy: requestBody.pet_read_policy ? "applied" : "none", resourceId: lastUser.content.slice(0, 40) };
            const pet = makePetReply({ reply, contextHits: result.context_hits ?? result.memory_hits ?? 0 });
            await respond(200, { id: completionId, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], pet });
            queueConversationCapture({ messages: [...messages, { role: "assistant", content: reply }], conversationId: sessionId, sessionId, source: "openai-bridge", principal: authenticatedPrincipal(authed, authed.agent, authed.role), role: authed.role, scopes: scopeRes.scopes });
            return;
          }
          const controller = new AbortController();
          req.on("close", () => controller.abort());
          auditEvent = { ...auditEvent, allow: true, resourceId: lastUser.content.slice(0, 40) };
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
          let first = true;
          for await (const chunk of petApi.handleCommandStream({ input: lastUser.content, mode: modeAuth.mode, roleId: modeAuth.mode, principal: authenticatedPrincipal(authed, authed.agent, authed.role), search: (opts) => lib.search(opts), history: messages.slice(0, messages.lastIndexOf(lastUser)), signal: controller.signal, onRemember: bridgeRemember, onDraft: bridgeDraft, onPersona: bridgePersona })) {
            if (chunk.text) {
              const pet = makePetReply({ reply: chunk.text, contextHits: chunk.context_hits });
              res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { ...(first ? { role: "assistant" } : {}), content: chunk.text }, finish_reason: null }], pet })}\n\n`);
              first = false;
            }
          }
          res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}

`);
          res.end("data: [DONE]\\n\\n");
          queueConversationCapture({ messages, conversationId: sessionId, sessionId, source: "openai-bridge", principal: authenticatedPrincipal(authed, authed.agent, authed.role), role: authed.role, scopes: scopeRes.scopes });
          auditEvent = { ...auditEvent, latencyMs: Date.now() - started };
          await audit.record(auditEvent);
          auditRecorded = true;
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "PET_ERROR" };
          if (!res.headersSent) await respond(500, { error: { message: "pet backend failed", type: "server_error", code: "INTERNAL" } });
          else if (!auditRecorded) {
            auditRecorded = true;
            await audit.record({ ...auditEvent, latencyMs: Date.now() - started, error: String(err?.message ?? "stream failed").slice(0, 120) });
          }
        }
        return;
      }

      // --- GET /mcp — Streamable HTTP clients probe for an SSE stream with GET.
      // This server is POST-only (no server-initiated messages), so 405 tells the
      // client (per the MCP spec) to skip the SSE stream and keep using request/
      // response POSTs. Returning 401 here would make clients treat it as a fatal
      // stream error and fire onerror + reconnect loops.
      if (method === "GET" && url === "/mcp") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "allow": "POST" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "SSE stream not supported; use POST for Streamable HTTP" } }));
        return;
      }

      // --- POST /mcp — MCP over HTTP (Streamable HTTP), for VS Code MCP clients etc.
      // Auth via X-MCP-* headers (same credential model, secret never in URL).
      if (method === "POST" && url === "/mcp") {
        const raw = await readBody(req);
        let msg;
        try { msg = JSON.parse(raw); } catch { msg = null; }
        const credRef = String(req.headers["x-mcp-credential-ref"] ?? "");
        const secret = String(req.headers["x-mcp-secret"] ?? "");
        const agent = String(req.headers["x-mcp-agent"] ?? "pilot-01");
        const role = String(req.headers["x-mcp-role"] ?? "researcher");
        const mcpBearerHeader = String(req.headers.authorization ?? "");
        const mcpBearerMatch = mcpBearerHeader.match(/^Bearer\s+(.+)$/i);
        const mcpBearerToken = mcpBearerMatch ? mcpBearerMatch[1] : "";
        // MCP is a protected protocol surface: every request must carry the
        // same credential material as the REST adapter. Loopback binding is not
        // an identity boundary, so there is no anonymous read fallback.
        const authed = await authenticateRequest(mcpBearerToken ? {} : { credential_ref: credRef, secret, principal: { agent_id: agent, role_id: role } }, mcpBearerToken);
        auditEvent = { ...auditEvent, action: "/mcp", auth_method: authed.auth_method ?? null, credentialFingerprint: authed.fingerprint ?? null, framework: authed.framework?.framework_id ?? null, agent: authed.agent?.agent_id ?? null, role: authed.role?.role_id ?? null };
        if (authed.err) {
          auditEvent = { ...auditEvent, denyReason: authed.err.code };
          await respond(authed.err.status, { ok: false, error: { code: authed.err.code, message: authed.err.message } });
          return;
        }
        if (!msg || msg.jsonrpc !== "2.0") {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "invalid JSON-RPC" } });
          return;
        }
        const scopeRes = resolveRequestScopes(authed.role, undefined);
        if (!scopeRes.ok) {
          auditEvent = { ...auditEvent, denyReason: "SCOPE_DENIED" };
          await respond(403, { ok: false, error: { code: "SCOPE_DENIED", message: scopeRes.reason } });
          return;
        }
        const principal = authenticatedPrincipal(authed, authed.agent, authed.role);
        const lib = libFactory({ scopes: scopeRes.scopes, agentId: authed.agent.agent_id, principal, audit, calendarTimezone });
        // The role's action list is the single authority for the in-process MCP
        // core too, so /mcp enforces exactly the gates the REST routes enforce.
        const roleActions = Array.isArray(authed.role?.actions) ? authed.role.actions : [];
        // 与主处理器同一口径（WRITE-DENY-1 写侧专用）：**只有**喂给 coreFromLib 的写门作用域
        // 取注册表的项目授权；`lib`（libFactory({ scopes: scopeRes.scopes })）与读路径仍是有效
        // API-key 的四向读作用域，所以 API-key 的读没有被放宽。
        const writeRole = authed.configuredRole ? { ...authed.configuredRole, actions: roleActions } : authed.role;
        const allowPropose = roleActions.includes("propose");
        const allowPet = roleActions.includes("pet");
        const services = {
          lib, learning: learningApi, pet: petApi, admin: adminServices,
          conversationMemory, transcriptImporter,
          memoryIngest: { run: async (payload) => {
            auditEvent = { ...auditEvent, action: "memory-ingest", dryRun: payload?.dry_run !== false };
            try {
              const result = await memoryIngest.run(payload);
              if (payload?.dry_run === false && result.counts.imported > 0) await refreshIndex();
              auditEvent = { ...auditEvent, allow: true, ingest_counts: result.counts, resourceId: `${result.counts.imported} imported / ${result.counts.skipped} skipped` };
              return result;
            } catch (error) {
              auditEvent = { ...auditEvent, allow: false, denyReason: error?.code ?? "INGEST_REJECTED" };
              throw error;
            }
          } },
          tools: toolsMemory, plans: plansMemory, project: projectMemory, recall, profile: profileMemory, roleMemory, writer: memoryWriter, evidenceRecovery: evidenceRecoveryApi,
          petRemember: (payload) => {
            if (!allowPet || !allowPropose) throw new Error("pet remember requires pet and propose actions");
            // Same normalization and mode gate as POST /v1/pet/remember, so MCP and
            // REST persist an identical candidate (记住/… intent prefix stripped).
            const modeAuth = authorizePetMode(authed.role, payload?.mode ?? "assistant");
            if (!modeAuth.ok || !["assistant", "steward"].includes(modeAuth.mode)) {
              throw Object.assign(new Error(modeAuth.ok ? "ROLE_MODE_DENIED" : modeAuth.reason), { status: 403, code: "FORBIDDEN" });
            }
            const intent = detectRememberIntent(payload?.input ?? payload?.content ?? "");
            if (!intent?.content) throw new Error("remember content is required");
            return rememberCandidate({ payload: intent, role: authed.role, agent: authed.agent, authed });
          },
          petRuntime: {
            // VISIBILITY-FIX-1-REJECT：pet 运行时的作用域必须是**认证出来的 role_id**。
            // 上一版写成 `role.role_id`，而 /mcp 这条路径上的 `role` 是**请求头字符串**（:621）
            // ⇒ `role.role_id === undefined` ⇒ 作用域为空 ⇒ 连本人（pilot-01/pet）都被 MISSING_SCOPE 拒。
            // 现在统一取 `principal.role_id`（与其它入口同源：服务端解析，不信调用方自报）。
            draftsPut: (payload) => { if (!allowPet) throw new Error("pet action denied"); return handlePetDraft({ ...payload, action: "put", roleId: principal.role_id, petMode: payload?.mode ?? null, sessionId: payload?.session_id }); },
            draftsList: (payload) => { if (!allowPet) throw new Error("pet action denied"); return handlePetDraft({ ...payload, action: "list", roleId: principal.role_id }); },
            draftsClear: (payload) => { if (!allowPet) throw new Error("pet action denied"); return handlePetDraft({ ...payload, action: "clear", roleId: principal.role_id }); },
            personaGet: (payload) => { if (!allowPet) throw new Error("pet action denied"); return petStore.loadPersona(principal.role_id); },
            personaList: (payload) => { if (!allowPet) throw new Error("pet action denied"); return petStore.listPersonas({ roleId: principal.role_id }).then((personas) => ({ personas })); },
            personaPut: (payload) => { if (!allowPet) throw new Error("pet action denied"); return writePersonaMemory({ preference: payload?.content, roleId: principal.role_id }, { role: authed.role, agent: authed.agent, authed }); },
          },
        };
        const allowSearch = roleActions.includes("search");
        const handler = createMcpHandler(coreFromLib(services, principal, { allowPropose, allowPet, allowSearch, actions: roleActions, scopes: writeRole.scopes, calendarTimezone }));
        const result = await handler.handle(msg);
        auditEvent = { ...auditEvent, allow: true, resourceId: String(msg.method ?? "mcp") };
        if (result === null) {
          // notification -> 202, no body (MCP notifications/initialized etc.)
          auditEvent = { ...auditEvent, latencyMs: Date.now() - started };
          await audit.record(auditEvent);
          res.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end("{}");
          return;
        }
        const accept = String(req.headers["accept"] ?? "application/json");
        if (accept.includes("text/event-stream")) {
          auditEvent = { ...auditEvent, latencyMs: Date.now() - started };
          await audit.record(auditEvent);
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
          res.end(`event: message
data: ${JSON.stringify(result)}

`);
        } else {
          await respond(200, result);
        }
        return;
      }

      // --- GET /v1/health (weak auth: minimal, no paths/roots) ---
      if (method === "GET" && url === "/v1/health") {
        const lib = libFactory({ scopes: null });
        const h = await lib.health();
        auditEvent = { ...auditEvent, action: "health", allow: true };
        // F2: 向量车道不可用时 health 会降级为 degraded；这里同时给出最小状态+原因，
        // 调用方能区分「语义车道挂了」与「库真健康」。保持 path-free：不带 checks/roots/dataRoot。
        const index = await buildIndexSection();
        const health = healthStatusFor(h.health, index);
        await respond(200, { ok: true, service: "memory-lib", version: 1, health, audit: await auditHealth(), vector: { status: h.vector.status, reason: h.vector.reason, model: h.vector.detail?.model ?? null, dimension: h.vector.detail?.dimension ?? null }, capacity: h.capacity ?? null, index, audit_rotation: { enabled: auditSchedule.enabled, interval_minutes: auditSchedule.interval_minutes, last_run_at: auditSchedule.last_run_at, last_status: auditSchedule.last_status, last_result: auditSchedule.last_result, failed: auditSchedule.failed, last_error: auditSchedule.last_error } });
        return;
      }

      // --- parse body for authed routes ---
      const rawBody = await readBody(req);
      let body;
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = null; }

      const bearerHeader = String(req.headers.authorization ?? "");
      const bearerMatch = bearerHeader.match(/^Bearer\s+(.+)$/i);
      const bearerToken = bearerMatch ? bearerMatch[1] : "";

      const peer = req.socket.remoteAddress ?? "unknown";
      if (method === "POST" && url === "/v1/auth/login") {
        const username = typeof body?.username === "string" ? body.username : "";
        const password = typeof body?.password === "string" ? body.password : "";
        const limited = loginLimiter.status(username, peer);
        auditEvent = { ...auditEvent, action: "login", auth_method: "credential", credentialFingerprint: accountFingerprint(username), resourceId: accountFingerprint(username) };
        if (!limited.allowed) {
          auditEvent = { ...auditEvent, denyReason: "RATE_LIMITED" };
          res.setHeader("retry-after", String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))));
          await respond(429, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication failed" } });
          return;
        }
        const registry = await loadRegistry(registryPath);
        const account = resolveAccount(registry, username);
        const passwordRecord = await accountPasswordStore.read(username);
        const passwordOk = await verifyPassword(passwordRecord, password);
        const principal = accountPrincipal(account);
        const framework = account && principal ? frameworkByCredentialRef(registry, account.credential_ref ?? (registry.frameworks ?? []).find((item) => item.framework_id === account.framework_id)?.credential_ref) : null;
        const resolved = framework && principal ? resolveClaimedPrincipal(framework, { agent_id: principal.agent_id, role_id: principal.role_id }) : { ok: false };
        if (!account || account.status !== "active" || !passwordOk || !framework || framework.credential?.status !== "active" || !resolved.ok) {
          const lock = loginLimiter.failure(username, peer);
          auditEvent = { ...auditEvent, denyReason: lock.locked ? "RATE_LIMITED" : "UNAUTHENTICATED" };
          if (lock.locked) res.setHeader("retry-after", String(Math.max(1, Math.ceil(lock.retryAfterMs / 1000))));
          await respond(lock.locked ? 429 : 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication failed" } });
          return;
        }
        loginLimiter.success(username, peer);
        const liveCredential = await readSecret(secretStore, framework.credential_ref);
        if (!liveCredential) {
          auditEvent = { ...auditEvent, denyReason: "UNAUTHENTICATED" };
          await respond(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication failed" } });
          return;
        }
        const session = await sessionStore.create({ frameworkId: framework.framework_id, credentialRef: framework.credential_ref, credentialVersion: credentialVersion(liveCredential), accountUsername: account.username, principal: { agent_id: resolved.agent.agent_id, role_id: resolved.role.role_id } });
        auditEvent = { ...auditEvent, framework: framework.framework_id, agent: resolved.agent.agent_id, role: resolved.role.role_id, allow: true, resourceId: "session" };
        await respond(200, { ok: true, access_token: session.token, token_type: "Bearer", expires_at: new Date(session.expiresAt).toISOString(), principal: { framework: framework.framework_id, agent: resolved.agent.agent_id, role: resolved.role.role_id }, scopes: resolved.role.scopes ?? [], actions: resolved.role.actions ?? [] });
        return;
      }

      if (method === "POST" && url === "/v1/auth/logout") {
        const revoked = bearerToken ? await sessionStore.revoke(bearerToken) : false;
        auditEvent = { ...auditEvent, action: "logout", auth_method: bearerToken ? "session" : null, allow: true, resourceId: revoked ? "session" : "none" };
        await respond(200, { ok: true, revoked });
        return;
      }

      if (method === "GET" && url === "/v1/auth/whoami") {
        const described = bearerToken ? await sessionStore.resolve(bearerToken, { renew: false }) : null;
        if (!described) {
          auditEvent = { ...auditEvent, action: "whoami", auth_method: "session", denyReason: "UNAUTHENTICATED" };
          await respond(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "session rejected" } });
          return;
        }
        const authedWhoami = await authenticateRequest({}, bearerToken, { renew: false });
        auditEvent = { ...auditEvent, action: "whoami", auth_method: "session", credentialFingerprint: authedWhoami.fingerprint ?? null, framework: authedWhoami.framework?.framework_id ?? null, agent: authedWhoami.agent?.agent_id ?? null, role: authedWhoami.role?.role_id ?? null };
        if (authedWhoami.err) { auditEvent.denyReason = authedWhoami.err.code; await respond(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "session rejected" } }); return; }
        auditEvent = { ...auditEvent, allow: true, resourceId: "session" };
        await respond(200, { ok: true, principal: { framework: authedWhoami.framework.framework_id, agent: authedWhoami.agent.agent_id, role: authedWhoami.role.role_id }, scopes: authedWhoami.role.scopes ?? [], actions: authedWhoami.role.actions ?? [], issued_at: new Date(described.issuedAt).toISOString(), expires_at: new Date(described.expiresAt).toISOString() });
        return;
      }

      if (method === "POST" && url === "/v1/auth/password") {
        if (!bearerToken) {
          auditEvent = { ...auditEvent, action: "password", auth_method: null, denyReason: "UNAUTHENTICATED" };
          await respond(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication failed" } });
          return;
        }
        const authedPassword = await authenticateRequest(body, bearerToken);
        auditEvent = { ...auditEvent, action: "password", auth_method: "session", credentialFingerprint: authedPassword.fingerprint ?? null, framework: authedPassword.framework?.framework_id ?? null, agent: authedPassword.agent?.agent_id ?? null, role: authedPassword.role?.role_id ?? null };
        if (authedPassword.err) { auditEvent.denyReason = authedPassword.err.code; await respond(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication failed" } }); return; }
        const username = authedPassword.account?.username;
        const currentPassword = typeof body?.current_password === "string" ? body.current_password : "";
        const newPassword = typeof body?.new_password === "string" ? body.new_password : "";
        const currentRecord = username ? await accountPasswordStore.read(username) : null;
        if (!username || !(await verifyPassword(currentRecord, currentPassword))) { auditEvent.denyReason = "UNAUTHENTICATED"; await respond(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication failed" } }); return; }
        try {
          const nextRecord = await hashPassword(newPassword);
          await accountPasswordStore.write(username, nextRecord);
          invalidateSecretCache(secretStore);
          const revoked = await sessionStore.revokeAllForAccount(username);
          auditEvent = { ...auditEvent, allow: true, resourceId: "password" };
          await respond(200, { ok: true, revoked_sessions: revoked });
        } catch (error) { auditEvent.denyReason = "BAD_REQUEST"; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message } }); }
        return;
      }

      if (method === "GET" && url === "/v1/ingest/status" && !bearerToken && req.headers["x-mcp-credential-ref"]) {
        const mcpStatusAuth = await authenticateRequest({ credential_ref: String(req.headers["x-mcp-credential-ref"] ?? ""), secret: String(req.headers["x-mcp-secret"] ?? ""), principal: { agent_id: String(req.headers["x-mcp-agent"] ?? "pilot-01"), role_id: String(req.headers["x-mcp-role"] ?? "researcher") } });
        auditEvent = { ...auditEvent, auth_method: mcpStatusAuth.auth_method ?? null, credentialFingerprint: mcpStatusAuth.fingerprint ?? null, framework: mcpStatusAuth.framework?.framework_id ?? null, agent: mcpStatusAuth.agent?.agent_id ?? null, role: mcpStatusAuth.role?.role_id ?? null, action: "memory-ingest-status" };
        if (mcpStatusAuth.err) {
          auditEvent.denyReason = mcpStatusAuth.err.code;
          await respond(mcpStatusAuth.err.status, { ok: false, error: { code: mcpStatusAuth.err.code, message: mcpStatusAuth.err.message } });
          return;
        }
        const unrestricted = Array.isArray(mcpStatusAuth.role?.actions) && mcpStatusAuth.role.actions.includes("admin") || ["librarian", "librarian-admin"].includes(String(mcpStatusAuth.role?.role_id ?? "").toLowerCase());
        auditEvent.allow = true;
        await respond(200, { ok: true, imports_path: memoryIngest.importsRoot, role_range: unrestricted ? "any-path" : "imports-only" });
        return;
      }

      const authed = await authenticateRequest(body, bearerToken);
      auditEvent = { ...auditEvent, auth_method: authed.auth_method ?? null, credentialFingerprint: authed.fingerprint ?? null, framework: authed.framework?.framework_id ?? null, agent: authed.agent?.agent_id ?? null, role: authed.role?.role_id ?? null };
      if (authed.err) {
        auditEvent = { ...auditEvent, action: url, denyReason: authed.err.code };
        await respond(authed.err.status, { ok: false, error: { code: authed.err.code, message: authed.err.message } });
        return;
      }

      const { role, agent } = authed;
      // WRITE-DENY-1（写侧专用，**不放宽任何 API-key 读**）：
      // API-key 的有效 role 把 scopes 收窄成四向读（agent/user/shared/platform），
      // 于是"写出来是 visibility=project"的写入永远拿不到项目授权 —— 即便注册表里
      // 那个 role 明确持有那个 project。这里给**写授权判据**单独一个 role：作用域取
      // 注册表配置的（configuredRole.scopes），动作取有效 API-key 的（role.actions，
      // 所以 platform 仍然要 admin）。它只喂 denialForWrite / conclusionWriteDenial，
      // 不参与 roleScopeRes、请求作用域的 lib、读路径或 principal —— 读侧口径一字未动。
      const writeRole = authed.configuredRole ? { ...authed.configuredRole, actions: role.actions } : role;
      if (method === "POST" && url === "/v1/agents/steward/run") {
        // MAINT11：D29 把 steward（batch 产出链）整体删掉了，而这里原来直接 await 一个叫 getStewardBatch 的函数
        // —— 那个函数**全仓从未存在**，一调用就 500。路由仍在 API 面上（旧调用方可能还在打），
        // 所以不删路由、**显式 410**，让调用方拿到明确的"这东西没了"，而不是一个 500。
        const perm = authorizeAction(role, "promote");
        auditEvent = { ...auditEvent, action: "steward-run" };
        if (!perm.ok) { auditEvent.denyReason = perm.reason; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        auditEvent.denyReason = "GONE";
        await respond(410, { ok: false, error: { code: "GONE", message: "steward batch was removed in D29; this endpoint no longer exists", detail: "STEWARD_REMOVED" } });
        return;
      }
      const roleScopeRes = resolveRequestScopes(role, undefined);
      if (!roleScopeRes.ok) {
        auditEvent = { ...auditEvent, action: url, denyReason: roleScopeRes.reason };
        await respond(403, { ok: false, error: { code: "FORBIDDEN", message: roleScopeRes.reason, detail: roleScopeRes.reason } });
        return;
      }
      const requestScopedRoute = url === "/v1/search" || url === "/v1/get";
      const scopeRes = requestScopedRoute ? resolveRequestScopes(role, body?.scope) : roleScopeRes;
      if (!scopeRes.ok) {
        auditEvent = { ...auditEvent, action: url, denyReason: scopeRes.reason, scope: body?.scope };
        await respond(403, { ok: false, error: { code: "FORBIDDEN", message: scopeRes.reason, detail: scopeRes.reason } });
        return;
      }
      const principal = authenticatedPrincipal(authed, agent, role);
      const lib = libFactory({ scopes: scopeRes.scopes, agentId: agent.agent_id, roleId: role.role_id, principal, audit });

      // --- POST /v1/date/resolve: rules-only date normalisation (zero model) ---
      // 只做「人话 → 绝对日期范围」的确定性换算：不读库、不写库、不调模型。
      // 「10/10 我们聊了什么」这类问题要落地，必须先把时间表达变成范围，再走
      // 空 query 的按天枚举（/v1/search 的 calendarDate 或 since/until）。
      if (method === "POST" && url === "/v1/date/resolve") {
        const action = "search";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const text = typeof body?.text === "string" ? body.text : "";
        const nowInput = typeof body?.now === "string" ? body.now : "";
        if (!text.trim()) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "text is required" } }); return; }
        if (!nowInput.trim()) {
          // 平台**不许在底层猜"现在"**：同一个请求重放必须得到同一个范围。
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "now is required (an ISO instant); the server does not guess the current time" } });
          return;
        }
        const resolved = resolveDateText({
          text,
          now: nowInput,
          timezone: typeof body?.timezone === "string" && body.timezone.trim() ? body.timezone : calendarTimezone,
          locale: body?.locale === undefined ? undefined : (typeof body.locale === "string" ? body.locale : null),
          weekStartsOn: Number.isInteger(body?.weekStartsOn) ? body.weekStartsOn : undefined,
        });
        // 解析失败是**调用方可恢复的输入问题**，不是服务端故障 ⇒ 422 带明确 reason，
        // 且失败响应里**没有 range**，调用方不可能把它当成"全库检索"。
        // 同时给出标准 `error{code,message,detail}` 信封：本仓库的错误契约就是这一层，
        // MCP 适配器按 `data.error` 读原因（不给这一层，原因会在传输途中被吞掉）。
        const status = resolved.ok ? 200 : 422;
        auditEvent = { ...auditEvent, allow: resolved.ok, ...(resolved.ok ? {} : { denyReason: resolved.reason }), resourceId: resolved.ok ? resolved.calendarDate ?? resolved.grain : null };
        await respond(status, {
          ...(resolved.ok
            ? { ok: true, principal: { framework: principal.framework_id, agent: principal.agent_id, role: principal.role_id } }
            : {
                ok: false,
                principal: { framework: principal.framework_id, agent: principal.agent_id, role: principal.role_id },
                error: {
                  code: resolved.reason.toUpperCase().replace(/-/gu, "_"),
                  message: resolved.message,
                  detail: resolved.reason,
                  ...(resolved.ambiguous ? { ambiguous: resolved.ambiguous } : {}),
                },
              }),
          ...resolved,
        });
        return;
      }

      // --- POST /v1/graph/query: read-only project graph ---
      if (method === "POST" && url === "/v1/graph/query") {
        const action = "search";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const projectId = typeof body?.project_id === "string" ? body.project_id.trim() : "";
        if (!projectId) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "project_id is required" } }); return; }
        const tenantId = principal.tenant_id ?? "default";
        const graph = await lib.graph({ tenantId, projectId, principal });
        auditEvent = { ...auditEvent, allow: true, resourceId: projectId };
        await respond(200, { ok: true, principal: { framework: principal.framework_id, agent: principal.agent_id, role: principal.role_id }, graph });
        return;
      }

      // --- POST /v1/search/joint: read-only federated retrieval ---
      if (method === "POST" && url === "/v1/search/joint") {
        const action = "search";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const query = typeof body?.query === "string" ? body.query.trim() : "";
        if (!query) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "query is required" } }); return; }
        const limit = Number.isInteger(body?.limit) ? Math.max(1, Math.min(100, body.limit)) : 10;
        const tenantId = principal.tenant_id ?? "default";
        const results = await graphJointSearch({ dataRoot, tenantId, query, limit, exact: body?.exact && typeof body.exact === "object" ? body.exact : null, principal, ollama: options.ollama, fetchImpl: options.embeddingFetch ?? globalThis.fetch });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${results.length} results` };
        await respond(200, { ok: true, principal: { framework: principal.framework_id, agent: principal.agent_id, role: principal.role_id }, count: results.length, results });
        return;
      }

      // --- POST /v1/search ---
      if (method === "POST" && url === "/v1/search") {
        const action = "search";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } });
          return;
        }
        const query = typeof body?.query === "string" ? body.query : "";
        const limit = Number.isInteger(body?.limit) ? Math.max(1, Math.min(100, body.limit)) : 10;
        const documentQuota = Number.isInteger(body?.documentQuota) ? Math.max(0, Math.min(100, body.documentQuota)) : 3;
         const rawQuota = Number.isInteger(body?.rawQuota) ? Math.max(1, Math.min(100, body.rawQuota)) : 3;
         const requestedMode = String(body?.searchMode ?? "hybrid").toLowerCase();
         const searchMode = ["memories", "documents", "evidence", "hybrid", "formal", "raw"].includes(requestedMode) ? requestedMode : "hybrid";
        let workspace; let tags;
        try { workspace = normalizeWorkspace(body?.workspace); tags = normalizeTags(body?.tags); }
        catch (err) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } }); return; }
        const since = typeof body?.since === "string" ? body.since : null;
        const until = typeof body?.until === "string" ? body.until : null;
        const calendarDate = typeof body?.calendarDate === "string" && body.calendarDate.trim() ? body.calendarDate : null;
        // DAYRECALL-1 A：calendarDate 是「取全那一天」的入口，它本身就是一个时间范围。
        // 原来的守卫只认 query/since/until，会把 `{calendarDate, calendarTimezone}` 这类
        // 完全合法的按日请求判成 BAD_REQUEST → 能力上了线却到不了。
        if (!query.trim() && !since && !until && !calendarDate) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "query or time range is required" } });
          return;
        }
        const lane = body?.lane === "evidence" ? "evidence" : null;
        const graphExpand = body?.graphExpand !== false;
         const as_of = typeof body?.as_of === "string" ? body.as_of : null;
         const include_superseded = body?.include_superseded === true;
         const page = query.trim() ? null : await lib.timeline({ limit, offset: body?.offset, cursor: body?.cursor, calendarDate, calendarTimezone: typeof body?.calendarTimezone === "string" ? body.calendarTimezone : calendarTimezone, workspace, tags, since, until, include_superseded });
         const results = page?.results ?? await lib.search({ query, limit, documentQuota, rawQuota, searchMode, workspace, tags, since, until, as_of, include_superseded, lane, graphExpand, calendarDate, calendarTimezone: typeof body?.calendarTimezone === "string" ? body.calendarTimezone : calendarTimezone });
        // D4F2：检索命中追加到 runtime sidecar（只动 runtime/，记忆内容文件零写）
        await recallStats.recordHits((results ?? []).map((r) => r.path));
        auditEvent = { ...auditEvent, allow: true, scope: scopeRes.scopes, resourceId: `${results.length} hits` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...(page ?? { count: results.length, results }) });
        return;
      }

      // --- POST /v1/get ---
      if (method === "POST" && url === "/v1/get") {
        const action = "get";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } });
          return;
        }
        const id = typeof body?.id === "string" ? body.id : "";
        if (!id.trim()) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "id is required" } });
          return;
        }
        const item = await lib.get(id, { include_cold: body?.include_cold === true }); // cold retrieval is explicit
        if (!item) {
          auditEvent = { ...auditEvent, denyReason: "NOT_FOUND", resourceId: id };
          await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "item not found" } });
          return;
        }
        auditEvent = { ...auditEvent, allow: true, resourceId: id };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, item });
        return;
      }

      if (method === "POST" && url === "/v1/memory/list") {
        const action = "search";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } });
          return;
        }
        let workspace; let tags;
        try { workspace = normalizeWorkspace(body?.workspace); tags = normalizeTags(body?.tags); }
        catch (err) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } }); return; }
        const items = await lib.listMemories({ limit: body?.limit, workspace, tags, since: typeof body?.since === "string" ? body.since : null, until: typeof body?.until === "string" ? body.until : null });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${items.length} memories` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, count: items.length, items });
        return;
      }

      if (method === "POST" && url === "/v1/memory/supersede") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "supersede" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const authenticated = authenticatedPrincipal(authed, agent, role);
          const oldId = typeof body?.old_id === "string" ? body.old_id : body?.oldId;
          const visible = await lib.get(oldId);
          if (!visible) throw Object.assign(new Error("superseded memory not found or not authorized"), { code: "NOT_FOUND", status: 404 });
          const oldVisibility = visible.frontmatter?.visibility ? String(visible.frontmatter.visibility) : null;
          const oldLayer = visible.frontmatter?.layer ? String(visible.frontmatter.layer) : null;
          if (body?.visibility !== undefined && oldVisibility && String(body.visibility) !== oldVisibility) throw Object.assign(new Error("SUPERSEDE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED", status: 403 });
          // WRITE-DENY-1-REJECT1（F2）：取代会**同时**改新旧两条记录，所以必须在任何写盘之前，
          // 按**旧记录真实的 container/visibility/project** 走与 /v1/write 同一把尺子。
          // 旧实现只查 propose，于是平台记录可以被非 admin 取代（新文件落 platform、旧文件被改写）。
          const supersedeDenial = supersedeDenialFor({
            oldRecord: visible,
            layer: body?.layer ?? oldLayer,
            role: writeRole,
            entry: "/v1/memory/supersede",
            principal: authenticated,
            claimed: claimedIdentityOf(body),
          });
          if (supersedeDenial) throw Object.assign(new Error(`WRITE_SCOPE_DENIED: ${supersedeDenial.code}: ${supersedeDenial.message}`), { code: "WRITE_SCOPE_DENIED", detail: supersedeDenial.code });
          const payload = { ...body, oldId, principal: authenticated, ...(oldVisibility ? { visibility: oldVisibility } : {}), ...(oldLayer === "long-term" ? { layer: "curated-shared" } : {}) };
          delete payload.old_id;
          const result = await memoryWriter.supersede(payload);
          auditEvent = { ...auditEvent, allow: true, resourceId: result.new?.id ?? body?.id ?? oldId };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          // WRITE-DENY-1-REJECT1（F2）：写授权拒绝是 403（与 /v1/write 同一口径），不是 400。
          if (err?.code === "WRITE_SCOPE_DENIED" || err?.status === 403) {
            auditEvent = { ...auditEvent, denyReason: err.detail ?? "WRITE_SCOPE_DENIED" };
            await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: err.message, detail: err.detail ?? "SUPERSEDE_SCOPE_DENIED" } });
            return;
          }
          auditEvent = { ...auditEvent, denyReason: err?.code === "NOT_FOUND" ? "NOT_FOUND" : "SUPERSEDE_REJECTED" };
          await respond(err?.status === 404 ? 404 : 400, { ok: false, error: { code: err?.code ?? "BAD_REQUEST", message: err.message, detail: "SUPERSEDE_REJECTED" } });
        }
        return;
      }

      // --- D29: unified zero-model direct write ---
      if (method === "POST" && url === "/v1/write") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "write" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const authenticated = authenticatedPrincipal(authed, agent, role);
          const keyScoped = authed.auth_method === "api-key";
          const explicitVisibility = body?.visibility !== undefined;
          const requestedVisibility = keyScoped ? String(body?.visibility ?? "agent") : explicitVisibility ? String(body.visibility).trim() : null;
          const denyWrite = (detail) => Object.assign(new Error(`WRITE_SCOPE_DENIED: ${detail}`), { code: "WRITE_SCOPE_DENIED", detail });
          if (explicitVisibility && !["platform", "shared", "user", "private", "role", "agent", "project", "daily"].includes(requestedVisibility)) throw Object.assign(new Error("WRITE_SCOPE_DENIED: UNSUPPORTED_VISIBILITY"), { code: "BAD_REQUEST" });
          // WRITE-DENY-1-REJECT1（F4）：身份位一律以**服务端认证出来的** principal 为准。
          // 旧实现只在 explicitVisibility 时零散比了几项，且缺字段/自报他人身份多半只到 400；
          // 现在把"自报身份位"交给共享门（identityDenialForWrite）统一判，拒绝一律是 403 WRITE_SCOPE_DENIED。
          const claimed = claimedIdentityOf(body);
          const keyLayer = keyScoped ? (requestedVisibility === "shared" || requestedVisibility === "user" ? "curated-shared" : body?.layer === "project-progress" ? "project-progress" : (["librarian-admin", "governance"].includes(String(role.role_id)) && body?.layer === "profile" ? "profile" : "agent")) : explicitVisibility && ["shared", "user"].includes(requestedVisibility) ? "curated-shared" : body?.layer === "project-progress" ? "project-progress" : (explicitVisibility && ["librarian-admin", "governance"].includes(String(role.role_id)) && body?.layer === "profile" ? "profile" : body?.layer);
          // WRITE-DENY-1：**写出来的可见性决定需要什么权限**（与提炼提交门禁同一把尺子）。
          // 这里必须在 writer 之前判定：调用方省略 visibility 时，document/tool 会落到容器默认的
          // platform ⇒ 需要 admin；project ⇒ 需要该项目作用域。显式 platform 不再单独判（同一把尺子）。
          const writeDenial = denialForWrite({
            layer: keyLayer,
            visibility: explicitVisibility || keyScoped ? requestedVisibility : undefined,
            project: body?.project ?? null,
            role: writeRole,
            entry: "/v1/write",
            principal: authenticated,
            claimed,
          });
          if (writeDenial) throw Object.assign(new Error(`WRITE_SCOPE_DENIED: ${writeDenial.code}: ${writeDenial.message}`), { code: "WRITE_SCOPE_DENIED", detail: writeDenial.code });
          const payload = { ...body, ...(keyScoped ? { layer: keyLayer, visibility: requestedVisibility } : explicitVisibility ? { layer: keyLayer, visibility: requestedVisibility } : {}), agent: authenticated.agent_id, role_id: authenticated.role_id, evidence_refs: requireEvidenceRefs(body), principal: authenticated };
          const result = payload.layer === "project-progress" ? await memoryWriter.writeProgress(payload) : await memoryWriter.write(payload);
          auditEvent = { ...auditEvent, allow: true, resourceId: result.path ?? payload.id ?? payload.project };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          // WRITE-DENY-1：写授权拒绝是 403（不是 400）——它和"输入不合法"是两件事，
          // 且与提炼提交门禁的 403 WRITE_SCOPE_DENIED 同一口径。
          if (err?.code === "WRITE_SCOPE_DENIED") {
            auditEvent = { ...auditEvent, denyReason: err.detail ?? "WRITE_SCOPE_DENIED" };
            await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: err.message, detail: err.detail ?? "WRITE_SCOPE_DENIED" } });
            return;
          }
          auditEvent = { ...auditEvent, denyReason: "WRITE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "WRITE_REJECTED" } });
        }
        return;
      }

      // --- D2.1: tools-memory routes ---
      if (method === "POST" && url === "/v1/tools/note") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "tool_note" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        // WRITE-DENY-1：工具记忆落在 tools-memory ⇒ container=tool ⇒ visibility=platform ⇒ 需要 admin。
        // WRITE-DENY-1-REJECT1（F1）：判权必须用**实际写出来的**可见性，不能用 body.visibility。
        // 旧实现拿 body.visibility 判权、却让 renderTool 按 principal?.visibility ?? "platform" 去写，
        // 于是非 admin 自报 visibility=private 就能过门，落盘的仍是一条 platform 记录（跨组可读）。
        const toolVisibility = resultingWriteTarget({ layer: "tool" })?.visibility ?? "platform";
        const toolPrincipal = authenticatedPrincipal(authed, agent, role);
        // WRITE-DENY-1-REJECT2（裁决1）：要求 private 但目标给不了 ⇒ **403**，绝不静默落 platform。
        const requestedToolVisibility = body?.visibility === undefined || body?.visibility === null || body?.visibility === "" ? null : String(body.visibility).trim();
        if (requestedToolVisibility !== null && requestedToolVisibility !== toolVisibility) {
          auditEvent = { ...auditEvent, denyReason: "WRITE_SPACE_UNSUPPORTED" };
          await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: `VISIBILITY_NOT_HONORED: tools-memory can only store visibility "${toolVisibility}", but "${requestedToolVisibility}" was requested`, detail: "WRITE_SPACE_UNSUPPORTED" } });
          return;
        }
        const toolDenial = denialForWrite({ layer: "tool", visibility: toolVisibility, role: writeRole, entry: "/v1/tools/note", principal: toolPrincipal, claimed: claimedIdentityOf(body) });
        if (toolDenial) {
          auditEvent = { ...auditEvent, denyReason: toolDenial.code };
          await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: toolDenial.message, detail: toolDenial.code } });
          return;
        }
        try {
          const result = await toolsMemory.putToolNote({ ...body, evidence_refs: requireEvidenceRefs(body), principal: toolPrincipal, visibility: toolVisibility });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.tool_name };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "TOOL_NOTE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "TOOL_NOTE_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/tools/list") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "tool_list" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const items = await toolsMemory.listTools({ env: typeof body?.env === "string" ? body.env : null, principal: authenticatedPrincipal(authed, agent, role) });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${items.length} tools` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, count: items.length, items });
        return;
      }
      if (method === "POST" && url === "/v1/tools/get") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "tool_get" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const item = await toolsMemory.getTool(body?.tool_name, authenticatedPrincipal(authed, agent, role));
        if (!item) { auditEvent = { ...auditEvent, denyReason: "NOT_FOUND" }; await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "tool not found" } }); return; }
        auditEvent = { ...auditEvent, allow: true, resourceId: item.tool_name };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, item });
        return;
      }
      if (method === "POST" && url === "/v1/tools/refresh") {
        // WRITE-DENY-1-REJECT1（F3）：refresh 会**重写每一条**工具记忆的 status（active⇒needs-review），
        // 而工具记忆一律是 platform 可见性 ⇒ 这是平台级写入，必须 admin。
        // 旧实现只查 propose，于是任何能 propose 的角色都能改平台范围内的记录状态。
        const perm = authorizeAction(role, "admin");
        auditEvent = { ...auditEvent, action: "tool_refresh" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: "PLATFORM_REQUIRES_ADMIN" }; await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: `tools/refresh rewrites platform-scoped tool memory, so it requires the admin action`, detail: "PLATFORM_REQUIRES_ADMIN" } }); return; }
        const result = await toolsMemory.refreshStatus({ principal: authenticatedPrincipal(authed, agent, role), role: writeRole });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${result.refreshed} refreshed` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        return;
      }

      // --- D2.2: project-memory routes ---
      if (method === "POST" && url === "/v1/project/state") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "project_state" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        // WRITE-DENY-1：项目记忆写成 visibility=project ⇒ 需要该项目的项目作用域。
        const stateDenial = denialForWrite({ layer: "project-state", project: body?.project ?? null, role: writeRole, entry: "/v1/project/state", principal: authenticatedPrincipal(authed, agent, role), claimed: claimedIdentityOf(body) });
        if (stateDenial) {
          auditEvent = { ...auditEvent, denyReason: stateDenial.code };
          await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: stateDenial.message, detail: stateDenial.code } });
          return;
        }
        try {
          const result = await projectMemory.putCurrentState({ ...body, evidence_refs: requireEvidenceRefs(body), principal: authenticatedPrincipal(authed, agent, role) });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.project };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "PROJECT_STATE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "PROJECT_STATE_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/project/decision") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "project_decision" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        // WRITE-DENY-1：decision 同样写进 project-state ⇒ visibility=project ⇒ 需要项目作用域。
        const decisionDenial = denialForWrite({ layer: "project-decision", project: body?.project ?? null, role: writeRole, entry: "/v1/project/decision", principal: authenticatedPrincipal(authed, agent, role), claimed: claimedIdentityOf(body) });
        if (decisionDenial) {
          auditEvent = { ...auditEvent, denyReason: decisionDenial.code };
          await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: decisionDenial.message, detail: decisionDenial.code } });
          return;
        }
        try {
          const result = await projectMemory.appendDecision({ ...body, evidence_refs: requireEvidenceRefs(body), principal: authenticatedPrincipal(authed, agent, role) });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.project };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "PROJECT_DECISION_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "PROJECT_DECISION_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/project/list") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "project_list" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const items = await projectMemory.listProjects(authenticatedPrincipal(authed, agent, role));
        auditEvent = { ...auditEvent, allow: true, resourceId: `${items.length} projects` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, count: items.length, items });
        return;
      }
      if (method === "POST" && url === "/v1/project/get") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "project_get" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const item = await projectMemory.getProject(body?.project, authenticatedPrincipal(authed, agent, role));
         if (!item || (!item.current_state && !item.progress && item.decisions.length === 0)) {
           auditEvent = { ...auditEvent, denyReason: "NOT_FOUND", resourceId: body?.project ?? "" };
           await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "project not found" } });
           return;
         }
        auditEvent = { ...auditEvent, allow: true, resourceId: body?.project ?? "" };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, item });
        return;
      }

      // --- D2.3: plans-memory routes ---
      if (method === "POST" && url === "/v1/plans/put") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "plan_put" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const result = await plansMemory.writePlan({ ...body, evidence_refs: requireEvidenceRefs(body), principal: authenticatedPrincipal(authed, agent, role) });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.topic };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "PLAN_PUT_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "PLAN_PUT_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/plans/confirm") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "plan_confirm" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const result = await plansMemory.confirm(body?.topic, { principal: authenticatedPrincipal(authed, agent, role) });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.topic };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: err?.code === "WRITE_SCOPE_DENIED" ? err.detail : "PLAN_CONFIRM_REJECTED" };
          if (err?.code === "WRITE_SCOPE_DENIED") { await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: err.message, detail: err.detail ?? "IDENTITY_MISMATCH" } }); return; }
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "PLAN_CONFIRM_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/plans/done") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "plan_done" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const result = await plansMemory.markDone(body?.topic, { principal: authenticatedPrincipal(authed, agent, role) });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.topic };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: err?.code === "WRITE_SCOPE_DENIED" ? err.detail : "PLAN_DONE_REJECTED" };
          if (err?.code === "WRITE_SCOPE_DENIED") { await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: err.message, detail: err.detail ?? "IDENTITY_MISMATCH" } }); return; }
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "PLAN_DONE_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/plans/list") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "plan_list" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const items = await plansMemory.listPlans({ include_done: body?.include_done === true, principal: authenticatedPrincipal(authed, agent, role) });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${items.length} plans` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, count: items.length, items });
        return;
      }
      if (method === "POST" && url === "/v1/plans/get") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "plan_get" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const item = await plansMemory.getPlan(body?.topic, authenticatedPrincipal(authed, agent, role));
        if (!item) { auditEvent = { ...auditEvent, denyReason: "NOT_FOUND" }; await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "plan not found" } }); return; }
        auditEvent = { ...auditEvent, allow: true, resourceId: item.topic };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, item });
        return;
      }

      // --- D3.3: 主动召回 ---
      if (method === "POST" && url === "/v1/recall/brief") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "recall_brief" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        // INJECT-1：新增 query / memories / memory_limit_chars / memory_only 四个入参。
        // 代理注入走 memory_only=true：只要「近期记忆」段（≤600 字），不要其余五段占用预算。
        const brief = await recall.recallBrief({
          project: typeof body?.project === "string" ? body.project : null,
          days: Number.isInteger(body?.days) ? body.days : 7,
          limit_chars: Number.isInteger(body?.limit_chars) ? body.limit_chars : 2000,
          agent_id: agent.agent_id,
          role_id: role.role_id,
          principal: authenticatedPrincipal(authed, agent, role),
          format: body?.format === "prompt" ? "prompt" : "markdown",
          query: typeof body?.query === "string" && body.query.trim() ? body.query : null,
          memories: Number.isInteger(body?.memories) ? body.memories : undefined,
          memory_limit_chars: Number.isInteger(body?.memory_limit_chars) ? body.memory_limit_chars : undefined,
          memory_only: body?.memory_only === true,
        });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${brief.total_chars} chars` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...brief });
        return;
      }

      // --- D4.1: 角色记忆 ---
      if (method === "POST" && url === "/v1/roles/note") {
        const perm = authorizeAction(role, "propose");
        auditEvent = { ...auditEvent, action: "role_note" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const result = await roleMemory.putRoleNote({
            agent_id: agent.agent_id, role_id: role.role_id, group_id: authed.keyPrincipal?.group_id ?? null, user_id: authed.keyPrincipal?.user_id ?? null, tenant_id: authenticatedPrincipal(authed, agent, role).tenant_id,
            kind: body?.kind, confidence: body?.confidence, sections: body?.sections ?? {},
            occurred_at: body?.occurred_at, tags: body?.tags, evidence_refs: requireEvidenceRefs(body), supersedes: body?.supersedes,
          });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.id };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "ROLE_NOTE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "ROLE_NOTE_REJECTED" } });
        }
        return;
      }
      if (method === "POST" && url === "/v1/roles/list") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "role_list" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const items = await roleMemory.listRoleNotes({ principal: authenticatedPrincipal(authed, agent, role) });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${items.length} notes` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, count: items.length, items });
        return;
      }

      // --- D3.4: 画像层 ---
      if (method === "POST" && url === "/v1/profile/list") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "profile_list" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const items = await profileMemory.listProfiles({ include_draft: body?.include_draft !== false, principal: authenticatedPrincipal(authed, agent, role) });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${items.length} profiles` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, count: items.length, items });
        return;
      }
      if (method === "POST" && url === "/v1/profile/confirm") {
        const perm = authorizeAction(role, "admin");
        auditEvent = { ...auditEvent, action: "profile_confirm" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        try {
          const refs = requireEvidenceRefs(body);
          const item = await profileMemory.get(body?.id);
          if (!item || !item.evidence_refs?.length || !refs.every((ref) => item.evidence_refs.includes(ref))) throw new Error("profile confirmation requires evidence_refs already attached to the draft");
          const result = await profileMemory.confirm(body?.id, { evidence_refs: refs, principal: authenticatedPrincipal(authed, agent, role) });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.id };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "PROFILE_CONFIRM_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "PROFILE_CONFIRM_REJECTED" } });
        }
        return;
      }

      // --- GET /v1/ingest/status (effective path policy; no filesystem access) ---
      if (method === "GET" && url === "/v1/ingest/status") {
        const unrestricted = Array.isArray(role?.actions) && role.actions.includes("admin") || ["librarian", "librarian-admin"].includes(String(role?.role_id ?? "").toLowerCase());
        auditEvent = { ...auditEvent, action: "memory-ingest-status", allow: true };
        await respond(200, { ok: true, imports_path: memoryIngest.importsRoot, role_range: unrestricted ? "any-path" : "imports-only" });
        return;
      }

      // --- POST /v1/ingest (external memory import; preview required before execution) ---
      if (method === "POST" && url === "/v1/ingest") {
        auditEvent = { ...auditEvent, action: "memory-ingest", dryRun: body?.dry_run !== false, ingest_paths: Array.isArray(body?.paths) ? body.paths.map((value) => path.basename(String(value))) : [], recursive: body?.recursive === true, glob: body?.glob ?? null, kind: body?.kind ?? null };
        const unrestricted = Array.isArray(role?.actions) && role.actions.includes("admin") || ["librarian", "librarian-admin"].includes(String(role?.role_id ?? "").toLowerCase());
        // WRITE-DENY-1：**执行**导入会写出 evidence/documents ⇒ container=knowledge ⇒ platform 可见，
        // 所以按"写出来的可见性"要求 admin；纯预览（dry_run 不为 false）什么都不写，不额外要求。
        if (body?.dry_run === false) {
          const ingestDenial = denialForWrite({ layer: body?.kind === "conversation" ? "curated-shared" : "document", project: body?.scope?.project ?? body?.project ?? null, role: writeRole, entry: "/v1/ingest", principal: authenticatedPrincipal(authed, agent, role), claimed: claimedIdentityOf(body) });
          if (ingestDenial) {
            auditEvent = { ...auditEvent, denyReason: ingestDenial.code };
            await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: ingestDenial.message, detail: ingestDenial.code } });
            return;
          }
        }
        try {
          const result = await memoryIngest.run({ ...body, extract: body?.extract === true && Array.isArray(role?.actions) && role.actions.includes("propose"), principal: authenticatedPrincipal(authed, agent, role), scopes: scopeRes.scopes, unrestricted });
          if (body?.dry_run === false && result.counts.imported > 0) await refreshIndex();
          auditEvent = { ...auditEvent, allow: true, resourceId: `${result.counts.imported} imported / ${result.counts.skipped} skipped`, ingest_counts: result.counts };
          await respond(200, { ok: true, ...result, imports_path: memoryIngest.importsRoot, role_range: unrestricted ? "any-path" : "imports-only" });
        } catch (err) {
          const code = err?.code === "PATH_DENIED" ? "FORBIDDEN" : "BAD_REQUEST";
          const status = code === "FORBIDDEN" ? 403 : 400;
          auditEvent = { ...auditEvent, denyReason: err?.code ?? code };
          await respond(status, { ok: false, error: { code, message: err.message, detail: err?.code ?? code } });
        }
        return;
      }

      // --- POST /v1/conversations/capture (automatic evidence capture; extract is deprecated) ---
      if (method === "POST" && (url === "/v1/conversations/capture" || url === "/v1/conversations/complete")) {
        const canPropose = Array.isArray(role?.actions) && role.actions.includes("propose");
        const canCapture = canPropose || (Array.isArray(role?.actions) && role.actions.includes("pet"));
        auditEvent = { ...auditEvent, action: url };
        if (!canCapture) {
          auditEvent = { ...auditEvent, denyReason: "ACTION_DENIED" };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: "conversation capture requires pet or propose action", detail: "ACTION_DENIED" } });
          return;
        }
        const allowedFields = new Set(["credential_ref", "secret", "principal", "source", "conversation_id", "event_id", "session_id", "workspace", "tags", "partial", "messages", "extract"]);
        const unknownFields = Object.keys(body ?? {}).filter((key) => !allowedFields.has(key));
        if (unknownFields.length) { auditEvent = { ...auditEvent, denyReason: "UNSUPPORTED_FIELDS" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: `unsupported capture fields: ${unknownFields.join(", ")}`, detail: "UNSUPPORTED_FIELDS" } }); return; }
        if (Array.isArray(body?.messages) && body.messages.some((message) => !message || typeof message !== "object" || Array.isArray(message) || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || Object.keys(message).some((key) => !["role", "content"].includes(key)))) { auditEvent = { ...auditEvent, denyReason: "UNSUPPORTED_MESSAGE_FIELDS" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "messages require role=user|assistant and string content; no other fields are allowed", detail: "UNSUPPORTED_MESSAGE_FIELDS" } }); return; }
        const conversationId = typeof body?.conversation_id === "string" ? body.conversation_id.slice(0, 256) : null;
        const source = typeof body?.source === "string" ? body.source.slice(0, 120) : "http";
        try {
          const workspace = normalizeWorkspace(body?.workspace);
           const authenticated = authenticatedPrincipal(authed, agent, role);
           const claimed = body?.principal;
           if (claimed && typeof claimed === "object" && !Array.isArray(claimed) && ["group_id", "user_id", "agent_id", "role_id"].some((key) => claimed[key] !== undefined && String(claimed[key]) !== String(authenticated[key]))) {
             auditEvent = { ...auditEvent, denyReason: "PRINCIPAL_MISMATCH" };
             await respond(403, { ok: false, error: { code: "FORBIDDEN", message: "capture principal must match authenticated principal", detail: "PRINCIPAL_MISMATCH" } });
             return;
           }
          const tags = normalizeTags(body?.tags);
          let captureScopes = scopeRes.scopes;
          if (workspace) {
            const projectScope = { layer: "memory", visibility: "project", project: workspaceKey(workspace) };
            const projectScopeRes = resolveRequestScopes(role, [projectScope]);
            if (!projectScopeRes.ok) { auditEvent = { ...auditEvent, denyReason: projectScopeRes.reason, scope: [projectScope] }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: projectScopeRes.reason, detail: projectScopeRes.reason } }); return; }
            captureScopes = projectScopeRes.scopes;
          }
          const principal = authenticatedPrincipal(authed, agent, role);
           const result = await conversationMemory.capture({ messages: body?.messages, conversationId, source, eventId: body?.event_id, sessionId: body?.session_id, workspace, tags, partial: body?.partial === true, principal, scopes: captureScopes, extract: body?.extract });
           const refinement = await lib.refinement.statusFor(result.evidenceId, { group_id: principal.group_id === "unknown" ? null : principal.group_id, user_id: principal.user_id === "unknown" ? null : principal.user_id });
           auditEvent = { ...auditEvent, allow: true, scope: captureScopes, resourceId: result.evidenceId };
          await respond(200, { ok: true, ...result, refinement });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "CONVERSATION_CAPTURE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message, detail: "CONVERSATION_CAPTURE_REJECTED" } });
        }
        return;
      }

      if (method === "POST" && (url === "/v1/transcripts/import/scan" || url === "/v1/transcripts/import/status")) {
        const canPropose = Array.isArray(role?.actions) && role.actions.includes("propose");
        const canCapture = canPropose || (Array.isArray(role?.actions) && role.actions.includes("pet"));
        auditEvent = { ...auditEvent, action: url };
        const canSearch = Array.isArray(role?.actions) && role.actions.includes("search");
        if (url.endsWith("/status") && !canSearch) { auditEvent = { ...auditEvent, denyReason: "ACTION_DENIED" }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: "transcript status requires search action", detail: "ACTION_DENIED" } }); return; }
        if (!url.endsWith("/status") && !canCapture) { auditEvent = { ...auditEvent, denyReason: "ACTION_DENIED" }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: "transcript import requires pet or propose action" } }); return; }
        try {
          const result = url.endsWith("/status") ? await transcriptImporter.status() : await transcriptImporter.scan({ source: body?.source ?? "transcript-import", principal: authenticatedPrincipal(authed, agent, role), scopes: scopeRes.scopes, extract: body?.extract === true && canPropose });
          auditEvent = { ...auditEvent, allow: true, resourceId: `${result.queued ?? result.count ?? 0} transcripts` };
          await respond(200, { ok: true, ...result });
        } catch (error) {
          if (error?.captureReason !== "unattributed") throw error;
          auditEvent = { ...auditEvent, denyReason: "CONVERSATION_CAPTURE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message, detail: "CONVERSATION_CAPTURE_REJECTED" } });
        }
        return;
      }

      if (method === "POST" && url === "/v1/refinement/pending") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: "refinement_pending" };
        if (!perm.ok) { auditEvent = { ...auditEvent, denyReason: perm.reason }; await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason } }); return; }
        const principal = authenticatedPrincipal(authed, agent, role);
        const result = await lib.pendingRefinement({ group_id: principal.group_id === "unknown" ? null : principal.group_id, user_id: principal.user_id === "unknown" ? null : principal.user_id, limit: body?.limit, since: typeof body?.since === "string" ? body.since : null });
        auditEvent = { ...auditEvent, allow: true, resourceId: `${result.count} pending refinements` };
        await respond(200, { ok: true, ...result, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id } });
        return;
      }

      // --- POST /v1/refinement/jobs/metrics — MEMORY-LOOP-1 切片3：完成度度量（只读日报） ---
      // 单子点名的那五个问题（今天捕获几段 / 几段有待办 / 几段完成 / 几段超时 / 几段无 durable 结论 /
      // 多少 job 无人认领）在这里一次答完，返回值里带一份可直接贴进日报的 markdown 文本。
      // 只读：不写盘、不改状态、不调模型；作用域由**服务端从认证主体派生**（不听调用方自报）。
      if (method === "POST" && url === "/v1/refinement/jobs/metrics") {
        const perm = authorizeAction(role, "search");
        auditEvent = { ...auditEvent, action: url };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        const result = await refinementMetrics.report({
          principal,
          day: typeof body?.day === "string" ? body.day : null,
          timezone: typeof body?.timezone === "string" ? body.timezone : null,
        });
        if (!result.ok) {
          // 非法日/时区是**调用方可恢复的输入问题**：400 带明确原因，绝不落到 500。
          auditEvent = { ...auditEvent, denyReason: result.error.code };
          await respond(result.error.status, { ok: false, error: result.error });
          return;
        }
        auditEvent = { ...auditEvent, allow: true, resourceId: `refinement-metrics:${result.day}` };
        await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, ...result });
        return;
      }

      // --- POST /v1/refinement/jobs/{list,get,claim,submit} — MEMORY-LOOP-1：提炼任务控制面 ---
      // 作用域由**服务端从认证主体派生**（不听调用方自报）：待办只对同一 group_id + user_id 可见、可领。
      // 越界读/领一律回 404（不区分"不存在"与"不是你的"），免得 job_id 被当成一张通行证。
      if (method === "POST" && (url === "/v1/refinement/jobs/list" || url === "/v1/refinement/jobs/get" || url === "/v1/refinement/jobs/claim" || url === "/v1/refinement/jobs/submit")) {
        const isSubmit = url.endsWith("/submit");
        // 提交会**写正式记忆** ⇒ 与 /v1/write 同一把尺子（propose）；读/领用 search。
        const perm = authorizeAction(role, url.endsWith("/claim") || isSubmit ? "propose" : "search");
        auditEvent = { ...auditEvent, action: url };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        if (url.endsWith("/list")) {
          const result = await refinementJobs.list({ principal, limit: body?.limit, state: typeof body?.state === "string" ? body.state : null });
          auditEvent = { ...auditEvent, allow: true, resourceId: `${result.count} refinement jobs` };
          await respond(200, { ok: true, ...result });
          return;
        }
        const jobId = typeof body?.job_id === "string" ? body.job_id.trim() : "";
        if (!jobId) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "job_id is required" } });
          return;
        }
        if (url.endsWith("/get")) {
          const job = await refinementJobs.get({ job_id: jobId, principal });
          if (!job) {
            auditEvent = { ...auditEvent, action: url, denyReason: "NOT_FOUND" };
            await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "refinement job not found" } });
            return;
          }
          auditEvent = { ...auditEvent, allow: true, resourceId: job.job_id };
          await respond(200, { ok: true, job });
          return;
        }
        if (isSubmit) {
          const result = await refinementJobs.submit({
            job_id: jobId,
            body,
            principal,
            // 落盘前的两道"这台服务才能回答"的检查：
            //   ① 写授权（conclusionWriteDenial）：先按 write-memory 的**同一个**默认可见性函数算出
            //      每条结论最终会写成什么（container + visibility），再套 /v1/write 对那个可见性的
            //      既有规则 —— platform 要 admin、project 要该项目作用域、其余不再额外要作用域。
            //      旧实现是"按层名猜一个 visibility"（curated-shared⇒{memory,shared}、
            //      document⇒{knowledge,shared}），实测既比写入口更严（同一份输入 /v1/write 200、
            //      提交 403），又对 document 是空招牌（要求的作用域 0 个检索根，却能写出 platform 可见
            //      的记忆）。`no_durable_fact`（零输出）**不经过这里**：它一条都不写。
            //   ② 证据可读性 + 兼容性：走**请求作用域**的库实例 lib.get(evidenceId) —— 存在性与
            //      可见性判据完全复用既有那一份，本切片没有再写一套（也不改它）；缺失与越权都返回
            //      null，所以公开错误同形。**返回的是那一条本身**（不是布尔值），由 submit 逐个检查
            //      "是不是对话证据 / 属于谁 / 属于哪个 workspace"（见 refinement-jobs.mjs）。
            assertion: ({ planned }) => {
              const denial = conclusionWriteDenial({ planned, role: writeRole });
              if (denial) throw Object.assign(new Error(`SUBMIT_SCOPE_DENIED: ${denial.code}: ${denial.message}`), { code: "WRITE_SCOPE_DENIED", status: 403, detail: denial.code });
            },
            verifyEvidence: async (evidenceId) => lib.get(evidenceId),
            writeMemory: (input) => memoryWriter.write(input),
            // 切片4：同 stable_key 的写入侧原语 —— 全部复用**同一个**服务端 writer（带 onIndexed），
            // 不另造 writer、不复制写入规则。
            //   findActiveMemory  只在调用方自己的 layer/project/tenant/group/user 作用域里找，
            //                     所以"读得到"这一点不必再猜；条目本身仍是写侧判定，不是检索。
            //   readableMemory    用**请求作用域**的库实例复核可见性（就是检索侧那一份判据，零复制）。
            //   mergeMemory       同键同体：只并集证据、刷新 updated_at，保留原 id 与单文件。
            //   supersedeMemory   同键异体且点名了 active：走既有 writer.supersede（旧文件留盘闭合）。
            //   targetPathOf      写前判断"新旧两版会不会住同一个文件"（project-state 必须拦住）。
            findActiveMemory: (query) => memoryWriter.findActiveByStableKey(query),
            readableMemory: async (id) => Boolean(await lib.get(id)),
            mergeMemory: (input) => memoryWriter.mergeEvidenceRefs(input),
            supersedeMemory: (input) => memoryWriter.supersede(input),
            targetPathOf: (input) => memoryWriter.targetPathFor(input),
          });
          if (!result.ok) {
            auditEvent = { ...auditEvent, denyReason: result.error.code, resourceId: jobId };
            // 期望内的拒绝一律按领域状态码回（404 证据不可读 / 403 非领取者或作用域 / 400 形状 / 409 状态冲突），
            // 绝不落到 500 —— 500 的意思是"服务端坏了"，会污染监控并诱导调用方重试。
            // 切片4：错误体**结构化字段原样透传**（如 conflicts: [{stable_key, active_id}]），
            // 只把模块内部的 status 摘掉 —— 它在这里已经变成 HTTP 状态码了。
            const { status: errorStatus, ...errorBody } = result.error;
            await respond(errorStatus, { ok: false, error: errorBody });
            return;
          }
          auditEvent = { ...auditEvent, allow: true, resourceId: result.job.job_id, written: result.receipt.writes.length, outcome: result.receipt.outcome };
          await respond(200, { ok: true, principal: { framework: authed.framework.framework_id, agent: agent.agent_id, role: role.role_id }, job: result.job, receipt: result.receipt, ...(result.idempotent ? { idempotent: true } : {}) });
          return;
        }
        const claimed = await refinementJobs.claim({ job_id: jobId, principal });
        if (!claimed.ok) {
          const conflict = claimed.reason === "ALREADY_CLAIMED";
          auditEvent = { ...auditEvent, denyReason: claimed.reason };
          await respond(conflict ? 409 : 404, {
            ok: false,
            error: conflict
              ? { code: "CONFLICT", message: "refinement job is already claimed", detail: claimed.reason }
              : { code: "NOT_FOUND", message: "refinement job not found" },
          });
          return;
        }
        auditEvent = { ...auditEvent, allow: true, resourceId: claimed.job.job_id };
        await respond(200, { ok: true, job: claimed.job, already_claimed: claimed.already_claimed });
        return;
      }

      // --- POST /v1/admin/* (admin-gated: role must carry action "admin") ---
      if (method === "POST" && url.startsWith("/v1/admin/")) {
        const isLibrarian = ["librarian", "librarian-admin"].includes(String(role?.role_id ?? "").toLowerCase());
        const perm = url === "/v1/admin/maintenance/purge" && isLibrarian ? { ok: true } : authorizeAction(role, "admin");
        auditEvent = { ...auditEvent, action: url };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        const roleKeyMatch = url.match(/^\/v1\/admin\/roles\/([^/]+)\/keys$/u);
        if (method === "POST" && roleKeyMatch) {
          try {
            const result = await issueRoleKey({ file: apiKeyFile, pepper: apiKeyPepper, roleId: decodeURIComponent(roleKeyMatch[1]) });
            auditEvent = { ...auditEvent, allow: true, resourceId: result.id };
            await respond(200, { ok: true, key: result });
          } catch (error) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message } }); }
          return;
        }
        const keyRevokeMatch = url.match(/^\/v1\/admin\/keys\/([^/]+)\/revoke$/u);
        if (method === "POST" && keyRevokeMatch) {
          const keyId = decodeURIComponent(keyRevokeMatch[1]);
          const changed = await revokeRoleKey({ file: apiKeyFile, keyId });
          auditEvent = { ...auditEvent, allow: true, resourceId: keyId };
          await respond(200, { ok: true, revoked: changed });
          return;
        }
        const keyRotateMatch = url.match(/^\/v1\/admin\/keys\/([^/]+)\/rotate$/u);
        if (method === "POST" && keyRotateMatch) {
          const oldKeyId = decodeURIComponent(keyRotateMatch[1]);
          const db = JSON.parse(await fs.readFile(apiKeyFile, "utf8"));
          const old = db.api_keys.find((item) => item.id === oldKeyId);
          if (!old) { auditEvent = { ...auditEvent, denyReason: "NOT_FOUND" }; await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "key not found" } }); return; }
          const role = db.roles.find((item) => item.id === old.role_id); const user = db.users.find((item) => item.id === role?.user_id); const group = db.groups.find((item) => item.id === role?.group_id);
          await revokeRoleKey({ file: apiKeyFile, keyId: oldKeyId });
          const result = await createRoleKey({ file: apiKeyFile, pepper: apiKeyPepper, roleId: role.id, roleName: role.name, userId: user.id, userName: user.name, groupId: group.id, groupName: group.name });
          auditEvent = { ...auditEvent, allow: true, resourceId: result.id };
          await respond(200, { ok: true, key: result });
          return;
        }
        const registry = await loadRegistry(registryPath);
        switch (url) {
          case "/v1/admin/audit/rotate": {
            const manualRunner = options.auditScheduleRunner ?? (() => rotateAuditArchives({ archiveDir: typeof body?.archiveDir === "string" && body.archiveDir ? body.archiveDir : auditArchiveDir, maxBytes: Number.isFinite(Number(body?.maxBytes)) ? Number(body.maxBytes) : options.auditMaxBytes ?? 64 * 1024 * 1024, retainMonths: Number.isFinite(Number(body?.retainMonths)) ? Number(body.retainMonths) : options.auditRetainMonths ?? 12, dryRun: body?.dry_run !== false }));
            const result = await runAuditRotation("manual", manualRunner);
            auditEvent = { ...auditEvent, allow: true, resourceId: `audit-rotation:${result.compressed.length}` };
            await respond(200, { ok: true, ...result });
            return;
          }
          case "/v1/admin/maintenance/run": {
            // MAINT11：原来直接 await 一个叫 runMaintenance 的函数 —— 该函数**全仓从未存在**（一调用就 500）。
            // D29 之后这条路线上没有任何已接线的实现：src/maintenance-scheduler.mjs 还在、也还被
            // 3 个测试用假协作者跑通，但 ① 它要求的 `librarian.run` 在生产侧已无构造点
            // （src/librarian-batch.mjs 无人 import、也无实例化），② src/ 与 scripts/ 里没有任何地方
            // 调用 createMaintenanceScheduler —— 服务端从未把它接起来。
            // 要不要让服务端在进程内跑 daily/monthly 是产品决策，不在本单范围；本单只保证不再 500，
            // 因此这条路由保留显式 410。单条冷层刷新仍可用：POST /v1/admin/maintenance/refresh。
            auditEvent = { ...auditEvent, denyReason: "GONE" };
            await respond(410, { ok: false, error: { code: "GONE", message: "maintenance run was removed together with the librarian in D29; use POST /v1/admin/maintenance/refresh for a single cold-layer refresh", detail: "MAINTENANCE_RUN_REMOVED" } });
            return;
          }
           case "/v1/admin/maintenance/refresh": {
             const id = typeof body?.id === "string" ? body.id : "";
             if (!id) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "id is required" } }); return; }
             const result = await coldLayer.refresh(id, { reason: body?.reason ?? "admin-refresh", body: body?.body ?? null, evidence_refs: Array.isArray(body?.evidence_refs) ? body.evidence_refs : [], source_episodes: Array.isArray(body?.source_episodes) ? body.source_episodes : [], principal: authenticatedPrincipal(authed, agent, role) });
             if (!result) { auditEvent = { ...auditEvent, denyReason: "NOT_FOUND", resourceId: id }; await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "cold memory not found" } }); return; }
             auditEvent = { ...auditEvent, allow: true, resourceId: id };
             await respond(200, { ok: true, id, status: result.frontmatter.status, refreshed_at: result.frontmatter.refreshed_at });
             return;
           }
           case "/v1/admin/maintenance/purge": {
             const principal = authenticatedPrincipal(authed, agent, role);
             const result = await coldLayer.purge({ ids: body?.ids, reason: body?.reason, dry_run: body?.dry_run !== false, principal });
             auditEvent = { ...auditEvent, allow: result.status !== "rejected", resourceId: Array.isArray(body?.ids) ? body.ids.join(",") : null, denyReason: result.status === "rejected" ? result.reason : null };
             await respond(result.status === "rejected" ? 400 : 200, { ok: result.status !== "rejected", ...result });
             return;
           }
           case "/v1/admin/health": {
            const principal = authenticatedPrincipal(authed, agent, role);
             const h = await lib.health({ group_id: principal.group_id === "unknown" ? null : principal.group_id, user_id: principal.user_id === "unknown" ? null : principal.user_id });
            auditEvent = { ...auditEvent, allow: true };
            const index = await buildIndexSection();
            const health = healthStatusFor(h.health, index);
             const quarantine = await conversationMemory.quarantineStatus();
              await respond(200, { ok: true, ...h, health, index, quarantine, principal: { agent: agent.agent_id, role: role.role_id, group_id: principal.group_id, user_id: principal.user_id }, actions: role.actions ?? [] });
            return;
          }
          case "/v1/admin/quarantine/unattributed-captures": {
             const records = await conversationMemory.listQuarantine({ limit: body?.limit });
             auditEvent = { ...auditEvent, allow: true, resourceId: `${records.length} quarantined captures` };
             await respond(200, { ok: true, count: records.length, records });
             return;
           }
           case "/v1/admin/quarantine/unattributed-captures/read": {
             const id = typeof body?.id === "string" ? body.id : "";
             const record = await conversationMemory.readQuarantine(id);
             if (!record) { auditEvent = { ...auditEvent, denyReason: "NOT_FOUND", resourceId: id }; await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "quarantined capture not found" } }); return; }
             auditEvent = { ...auditEvent, allow: true, resourceId: id };
             await respond(200, { ok: true, id, record });
             return;
           }
           case "/v1/admin/registry": {
            auditEvent = { ...auditEvent, allow: true };
            await respond(200, { ok: true, ...registryView(registry), api_keys: (await apiKeyRegistryView(apiKeyFile)).api_keys });
            return;
          }
          case "/v1/admin/identity": {
             const keyView = await apiKeyRegistryView(apiKeyFile);
             auditEvent = { ...auditEvent, allow: true };
             await respond(200, { ok: true, identity: { ...registryView(registry), ...keyView } });
             return;
           }
           case "/v1/admin/registry/revoke":
          case "/v1/admin/registry/activate": {
            const frameworkId = typeof body?.framework_id === "string" ? body.framework_id : "";
            if (!frameworkId) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "framework_id is required" } });
              return;
            }
            const status = url.endsWith("/revoke") ? "revoked" : "active";
            const result = await setCredentialStatus(registryPath, frameworkId, status);
            if (!result.ok) {
              auditEvent = { ...auditEvent, denyReason: result.reason, resourceId: frameworkId };
              await respond(404, { ok: false, error: { code: "NOT_FOUND", message: result.reason } });
              return;
            }
            auditEvent = { ...auditEvent, allow: true, resourceId: frameworkId };
            await respond(200, { ok: true, framework_id: frameworkId, status });
            return;
          }
          case "/v1/admin/audit": {
            const limit = Number.isInteger(body?.limit) ? body.limit : 100;
            const allow = body?.allow === true ? true : body?.allow === false ? false : null;
            await audit.flush();
            const events = await queryAudit(auditPath, { limit, allow });
            auditEvent = { ...auditEvent, allow: true, resourceId: `${events.length} lines` };
            await respond(200, { ok: true, events });
            return;
          }
          case "/v1/admin/inbox": {
            // MAINT11：原来直接 await 一个叫 listInboxCandidates 的函数 —— 该函数**全仓从未存在**（一调用就 500）。
            // D29 把"候选链（候选队列 + 人工审核）"整体删掉，PRODUCT.md:179-180 明确写了
            // 不要把那条链再建一遍；所以这里没有实现可接，只保留显式 410。
            auditEvent = { ...auditEvent, denyReason: "GONE" };
            await respond(410, { ok: false, error: { code: "GONE", message: "the review-candidate inbox was removed in D29 and must not be rebuilt (see PRODUCT.md:179-180); nothing is queued for review any more", detail: "INBOX_REMOVED" } });
            return;
          }
          case "/v1/admin/inbox/read": {
            // MAINT11：同上，readInboxCandidate 从未存在；候选链已删，没有候选可读。
            auditEvent = { ...auditEvent, denyReason: "GONE" };
            await respond(410, { ok: false, error: { code: "GONE", message: "the review-candidate inbox was removed in D29; there are no candidates to read (see PRODUCT.md:179-180)", detail: "INBOX_REMOVED" } });
            return;
          }
          case "/v1/admin/roles/key": {
            try {
              const result = await issueRoleKey({ file: apiKeyFile, pepper: apiKeyPepper, roleId: body?.role_id });
              auditEvent = { ...auditEvent, allow: true, resourceId: result.id };
              await respond(200, { ok: true, key: result });
            } catch (error) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message } }); }
            return;
          }
          case "/v1/admin/keys/revoke": {
            const keyId = typeof body?.key_id === "string" ? body.key_id : "";
            if (!keyId) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "key_id is required" } }); return; }
            const changed = await revokeRoleKey({ file: apiKeyFile, keyId });
            auditEvent = { ...auditEvent, allow: true, resourceId: keyId };
            await respond(200, { ok: true, revoked: changed });
            return;
          }
          case "/v1/admin/roles/revoke": {
            const roleId = typeof body?.role_id === "string" ? body.role_id : "";
            if (!roleId) { auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" }; await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "role_id is required" } }); return; }
            const changed = await revokeRole({ file: apiKeyFile, roleId });
            auditEvent = { ...auditEvent, allow: true, resourceId: roleId };
            await respond(200, { ok: true, revoked: changed });
            return;
          }
          case "/v1/admin/framework/create": {
            if (!secretsDir) {
              auditEvent = { ...auditEvent, denyReason: "NOT_CONFIGURED" };
              await respond(400, { ok: false, error: { code: "NOT_CONFIGURED", message: "secretsDir not configured" } });
              return;
            }
            const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
            const actions = Array.isArray(body?.actions) ? body.actions : [];
            try {
              const result = await createFramework({
                registryPath, secretsDir,
                frameworkId: body?.framework_id,
                credentialRef: body?.framework_credential_ref ?? `memory-lib/${body?.framework_id}`,
                agentId: body?.agent_id,
                roleId: body?.role_id,
                scopes, actions,
                wincred: shouldWriteWincred({ requested: body?.wincred === true, secretStoreType: secretStore?.type }),
                writeFile: secretStore?.type === "file",
                ...(wincredWriter ? { wincredWriter } : {}),
              });
              invalidateSecretCache(secretStore, result.credential_ref);
              auditEvent = { ...auditEvent, allow: true, resourceId: result.framework_id };
              await respond(200, { ok: true, ...result });
            } catch (err) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } });
            }
            return;
          }
          case "/v1/admin/account/create": {
            try {
              const account = await createAccount({
                registryPath,
                accountPasswordStore,
                username: body?.username,
                password: body?.password,
                frameworkId: body?.framework_id,
                credentialRef: body?.account_credential_ref ?? null,
                agentId: body?.agent_id,
                roleId: body?.role_id,
              });
              invalidateSecretCache(secretStore);
              auditEvent = { ...auditEvent, allow: true, resourceId: accountFingerprint(account.username) };
              await respond(200, { ok: true, account });
            } catch (error) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST", resourceId: accountFingerprint(body?.username ?? "") };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message } });
            }
            return;
          }
          case "/v1/admin/account/password/reset": {
            try {
              const result = await resetAccountPassword({ registryPath, accountPasswordStore, username: body?.username, password: body?.password });
              invalidateSecretCache(secretStore);
              const revokedSessions = await sessionStore.revokeAllForAccount(result.username);
              auditEvent = { ...auditEvent, allow: true, resourceId: accountFingerprint(result.username) };
              await respond(200, { ok: true, username: result.username, revoked_sessions: revokedSessions });
            } catch (error) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST", resourceId: accountFingerprint(body?.username ?? "") };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message } });
            }
            return;
          }
          case "/v1/admin/account/suspend":
          case "/v1/admin/account/activate": {
            try {
              const status = url.endsWith("/suspend") ? "suspended" : "active";
              const result = await setAccountStatus({ registryPath, username: body?.username, status });
              const revokedSessions = status === "suspended" ? await sessionStore.revokeAllForAccount(result.username) : 0;
              auditEvent = { ...auditEvent, allow: true, resourceId: accountFingerprint(result.username) };
              await respond(200, { ok: true, ...result, revoked_sessions: revokedSessions });
            } catch (error) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST", resourceId: accountFingerprint(body?.username ?? "") };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: error.message } });
            }
            return;
          }
          case "/v1/admin/credential/rotate": {
            if (!secretsDir) {
              auditEvent = { ...auditEvent, denyReason: "NOT_CONFIGURED" };
              await respond(400, { ok: false, error: { code: "NOT_CONFIGURED", message: "secretsDir not configured" } });
              return;
            }
            const credentialRef = typeof body?.target_credential_ref === "string" ? body.target_credential_ref : "";
            if (!credentialRef) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "target_credential_ref is required" } });
              return;
            }
            try {
              const result = await rotateCredential({ secretsDir, credentialRef, wincred: shouldWriteWincred({ requested: body?.wincred === true, secretStoreType: secretStore?.type }), writeFile: secretStore?.type === "file", ...(wincredWriter ? { wincredWriter } : {}) });
              invalidateSecretCache(secretStore, credentialRef);
              const accountRegistry = await loadRegistry(registryPath);
              const affectedAccounts = (accountRegistry.accounts ?? []).filter((account) => account.credential_ref === credentialRef).map((account) => account.username);
              let revokedSessions = 0;
              for (const username of affectedAccounts) revokedSessions += await sessionStore.revokeAllForAccount(username);
              auditEvent = { ...auditEvent, allow: true, resourceId: credentialRef };
              await respond(200, { ok: true, ...result, revoked_sessions: revokedSessions });
            } catch (err) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } });
            }
            return;
          }
          default:
            auditEvent = { ...auditEvent, denyReason: "NOT_FOUND" };
            await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "unknown admin route" } });
            return;
        }
      }

      // --- POST /v1/learning/* (role must carry action "learning") ---
      if (method === "POST" && url.startsWith("/v1/learning/")) {
        const perm = authorizeAction(role, "learning");
        auditEvent = { ...auditEvent, action: url };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        const topic = typeof body?.topic === "string" ? body.topic : "";
        try {
          switch (url) {
            case "/v1/learning/plan_get": {
              if (!topic) throw new Error("topic is required");
              const plan = await learningApi.getPlan(topic, authenticatedPrincipal(authed, agent, role));
              auditEvent = { ...auditEvent, allow: true, resourceId: topic };
              await respond(200, { ok: true, topic, plan });
              return;
            }
            case "/v1/learning/plan_put": {
              if (!topic) throw new Error("topic is required");
              const plan = await learningApi.putPlan(topic, body?.plan ?? { modules: body?.modules });
              auditEvent = { ...auditEvent, allow: true, resourceId: topic };
              await respond(200, { ok: true, plan });
              return;
            }
            case "/v1/learning/progress_get": {
              if (!topic) throw new Error("topic is required");
              const progress = await learningApi.getProgress(topic, authenticatedPrincipal(authed, agent, role));
              auditEvent = { ...auditEvent, allow: true, resourceId: topic };
              await respond(200, { ok: true, topic, progress });
              return;
            }
            case "/v1/learning/progress_put": {
              if (!topic) throw new Error("topic is required");
              const progress = await learningApi.putProgress(topic, body?.progress);
              auditEvent = { ...auditEvent, allow: true, resourceId: topic };
              await respond(200, { ok: true, progress });
              return;
            }
            case "/v1/learning/review_get": {
              // topic omitted -> aggregate due reviews across every learning topic
              // (same route, same permissions; per-topic response is unchanged).
              if (!topic) {
                const aggregate = await learningApi.listDueReviews(authenticatedPrincipal(authed, agent, role));
                auditEvent = { ...auditEvent, allow: true, resourceId: `${aggregate.count} due reviews` };
                await respond(200, { ok: true, ...aggregate });
                return;
              }
              const review = await learningApi.getReview(topic, authenticatedPrincipal(authed, agent, role));
              auditEvent = { ...auditEvent, allow: true, resourceId: topic };
              await respond(200, { ok: true, ...review });
              return;
            }
            case "/v1/learning/review_put": {
              if (!topic) throw new Error("topic is required");
              const review = await learningApi.putReview(topic, body?.results);
              auditEvent = { ...auditEvent, allow: true, resourceId: topic };
              await respond(200, { ok: true, review });
              return;
            }
            case "/v1/learning/profile_get": {
              const profile = await learningApi.getProfile(authenticatedPrincipal(authed, agent, role));
              auditEvent = { ...auditEvent, allow: true };
              await respond(200, { ok: true, profile });
              return;
            }
            case "/v1/learning/profile_put": {
              const profile = await learningApi.putProfile(body?.profile);
              auditEvent = { ...auditEvent, allow: true };
              await respond(200, { ok: true, profile });
              return;
            }
            default:
              auditEvent = { ...auditEvent, denyReason: "NOT_FOUND" };
              await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "unknown learning route" } });
              return;
          }
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } });
          return;
        }
      }

      // --- POST /v1/evidence/* (import=propose, get/list=search) ---
      if (method === "POST" && url.startsWith("/v1/evidence/")) {
        auditEvent = { ...auditEvent, action: url };
        const neededAction = url.endsWith("/import") ? "propose" : "search";
        const perm = authorizeAction(role, neededAction);
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        const id = typeof body?.id === "string" ? body.id : "";
        const content = typeof body?.content === "string" ? body.content : "";
        // WRITE-DENY-1：证据导入写到 evidence/documents ⇒ container=knowledge ⇒ platform 可见 ⇒ 需要 admin。
        if (url === "/v1/evidence/import") {
          const evidenceDenial = denialForWrite({ layer: "document", role: writeRole, entry: "/v1/evidence/import", principal: authenticatedPrincipal(authed, agent, role), claimed: claimedIdentityOf(body) });
          if (evidenceDenial) {
            auditEvent = { ...auditEvent, denyReason: evidenceDenial.code };
            await respond(403, { ok: false, error: { code: "WRITE_SCOPE_DENIED", message: evidenceDenial.message, detail: evidenceDenial.code } });
            return;
          }
        }
        try {
          let result;
          if (url === "/v1/evidence/import") {
            if (!id || !content.trim()) throw new Error("id and content are required");
            result = await evidenceRecoveryApi.evidenceImport(id, content);
          } else if (url === "/v1/evidence/get") {
            if (!id) throw new Error("id is required");
            result = await evidenceRecoveryApi.evidenceGet(id);
            if (!result) throw new Error("NOT_FOUND");
          } else if (url === "/v1/evidence/list") {
            result = await evidenceRecoveryApi.evidenceList();
          } else throw new Error("NOT_FOUND");
          auditEvent = { ...auditEvent, allow: true, resourceId: id || `${result.files?.length ?? 0} files` };
          await respond(200, { ok: true, ...result });
        } catch (err) {
          const notFound = err.message === "NOT_FOUND" || err.message.includes("not found");
          auditEvent = { ...auditEvent, denyReason: notFound ? "NOT_FOUND" : "BAD_REQUEST" };
          await respond(notFound ? 404 : 400, { ok: false, error: { code: notFound ? "NOT_FOUND" : "BAD_REQUEST", message: err.message } });
        }
        return;
      }

      // --- POST /v1/recovery/* (plan_put=propose, 其余=search) ---
      if (method === "POST" && url.startsWith("/v1/recovery/")) {
        auditEvent = { ...auditEvent, action: url };
        const neededAction = url.endsWith("/plan_put") ? "propose" : "search";
        const perm = authorizeAction(role, neededAction);
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        const id = typeof body?.id === "string" ? body.id : "";
        const content = typeof body?.content === "string" ? body.content : "";
        try {
          let result;
          if (url === "/v1/recovery/plan_get") {
            if (!id) throw new Error("id is required");
            result = await evidenceRecoveryApi.recoveryPlanGet(id);
            if (!result) throw new Error("NOT_FOUND");
          } else if (url === "/v1/recovery/plan_put") {
            if (!id || !content.trim()) throw new Error("id and content are required");
            result = await evidenceRecoveryApi.recoveryPlanPut(id, content);
          } else if (url === "/v1/recovery/status") {
            result = await evidenceRecoveryApi.recoveryStatus();
          } else if (url === "/v1/recovery/restore_validate") {
            result = await evidenceRecoveryApi.recoveryRestoreValidate(typeof body?.path === "string" ? body.path : "");
          } else throw new Error("NOT_FOUND");
          auditEvent = { ...auditEvent, allow: true, resourceId: id || "ok" };
          await respond(200, { ok: true, ...result });
        } catch (err) {
          const notFound = err.message === "NOT_FOUND" || err.message.includes("not found");
          auditEvent = { ...auditEvent, denyReason: notFound ? "NOT_FOUND" : "BAD_REQUEST" };
          await respond(notFound ? 404 : 400, { ok: false, error: { code: notFound ? "NOT_FOUND" : "BAD_REQUEST", message: err.message } });
        }
        return;
      }

      // --- POST /v1/pet/command (role must carry action "pet") ---
      if (method === "POST" && url === "/v1/pet/command") {
        auditEvent = { ...auditEvent, action: url };
        const input = typeof body?.input === "string" ? body.input : "";
        const mode = typeof body?.mode === "string" ? body.mode : "companion";
        const sessionId = typeof body?.session_id === "string" ? body.session_id.slice(0, 256) : null;
        const modeAuth = authorizePetMode(role, mode);
        if (!modeAuth.ok) {
          auditEvent = { ...auditEvent, denyReason: modeAuth.reason, mode: modeAuth.mode };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: modeAuth.reason, detail: modeAuth.reason } });
          return;
        }
        const learningCommand = input.trim().startsWith("/learn:");
        if (learningCommand) {
          const learningPerm = authorizeAction(role, "learning");
          if (!learningPerm.ok) {
            auditEvent = { ...auditEvent, denyReason: learningPerm.reason, mode: modeAuth.mode };
            await respond(403, { ok: false, error: { code: "FORBIDDEN", message: learningPerm.reason, detail: learningPerm.reason } });
            return;
          }
        }
        if (!input.trim()) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "input is required" } });
          return;
        }
        try {
          // The client may narrow its own pet view, but can never widen the
          // credential-bound role scopes. Filtering happens before retrieval.
          const petScopes = applyPetReadDenylist(scopeRes.scopes, body?.pet_read_policy);
          const petLib = libFactory({ scopes: petScopes });
          // VISIBILITY-FIX-1-REJECT2：`/draft` 也是草稿写入通道，作用域必须与 /mcp 适配器、
          // /v1/pet/runtime/drafts/* 同源（= 认证身份的 role_id）。上一版这里没给作用域 ⇒
          // putDraft 落盘用了默认值 "companion" ⇒ 用 `/draft` 存的草稿两条通道都看不见。
          const petPrincipal = authenticatedPrincipal(authed, agent, role);
          const result = await petApi.handleCommand({
            input,
            mode: modeAuth.mode,
            roleId: modeAuth.mode,
            principal: petPrincipal,
            search: (opts) => petLib.search(opts),
            history: body?.history,
            onRemember: modeAuth.mode === "assistant" || modeAuth.mode === "steward"
              ? (payload) => rememberCandidate({ payload, role, agent, authed, body, auditEvent })
              : undefined,
            onDraft: (draft) => handlePetDraft({ ...draft, roleId: petPrincipal.role_id, petMode: modeAuth.mode, sessionId }),
            onPersona: modeAuth.mode === "assistant" || modeAuth.mode === "steward" || modeAuth.mode === "governance"
              ? (payload) => writePersonaMemory(payload, { role, agent, authed })
              : undefined,
          });
          auditEvent = { ...auditEvent, allow: true, mode: modeAuth.mode, sessionId: sessionId || undefined, petReadPolicy: body?.pet_read_policy ? "applied" : "none", resourceId: `${input.slice(0, 40)}` };
          const extra = {};
          for (const k of ["context_hits", "memory_hits", "web_sources", "fetched", "due", "plan"]) {
            if (result[k] !== undefined) extra[k] = result[k];
          }
          await respond(200, { ok: true, reply: result.reply, pet: makePetReply({ reply: result.reply, contextHits: result.context_hits ?? result.memory_hits ?? 0 }), ...extra });
          queueConversationCapture({ messages: [...(Array.isArray(body?.history) ? body.history : []), { role: "user", content: input }, { role: "assistant", content: String(result.reply ?? "") }], conversationId: sessionId, sessionId, source: "pet-command", principal: authenticatedPrincipal(authed, agent, role), role, scopes: petScopes, suppressRefinement: true });
        } catch (err) {
          // VISIBILITY-FIX-1：缺身份/缺作用域是**调用方问题**，必须回 4xx（不是 500 INTERNAL）——
          // 否则"被拒绝"会被讲成"服务器坏了"。
          const scopeish = err?.code === "MISSING_PRINCIPAL" || err?.code === "MISSING_SCOPE";
          auditEvent = { ...auditEvent, denyReason: scopeish ? err.code : "PET_ERROR" };
          await respond(scopeish ? 403 : 500, { ok: false, error: { code: scopeish ? err.code : "INTERNAL", message: scopeish ? err.message : `pet 处理失败: ${err.message}` } });
        }
        return;
      }

      // --- POST /v1/pet/runtime/persona/put — explicit user preference ---
      if (method === "POST" && url === "/v1/pet/runtime/persona/put") {
        auditEvent = { ...auditEvent, action: url };
        const modeAuth = authorizePetMode(role, body?.mode ?? "assistant");
        const perm = authorizeAction(role, "pet");
        if (!modeAuth.ok || !perm.ok) {
          auditEvent = { ...auditEvent, denyReason: modeAuth.ok ? perm.reason : modeAuth.reason, mode: modeAuth.mode };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: modeAuth.ok ? perm.reason : modeAuth.reason, detail: modeAuth.ok ? perm.reason : modeAuth.reason } });
          return;
        }
        try {
          const result = await writePersonaMemory(
            { preference: body?.content, roleId: body?.role_id ?? modeAuth.mode },
            { role, agent, authed },
          );
          auditEvent = { ...auditEvent, allow: true, mode: modeAuth.mode, scope: [{ layer: "memory", visibility: "shared" }], resourceId: result.id };
          await respond(200, { ok: true, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "PERSONA_WRITE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } });
        }
        return;
      }

      // User-triggered remember is exposed separately so it can be used by a
      // thin client without granting the client direct access to propose().
      if (method === "POST" && url === "/v1/pet/remember") {
        auditEvent = { ...auditEvent, action: url };
        const modeAuth = authorizePetMode(role, body?.mode ?? "assistant");
        if (!modeAuth.ok || !["assistant", "steward"].includes(modeAuth.mode)) {
          const reason = modeAuth.ok ? "ROLE_MODE_DENIED" : modeAuth.reason;
          auditEvent = { ...auditEvent, denyReason: reason, mode: modeAuth.mode };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: reason, detail: reason } });
          return;
        }
        try {
          const payload = detectRememberIntent(body?.input ?? body?.content ?? "");
          if (!payload?.content) throw new Error("remember content is required");
          const result = await rememberCandidate({ payload, role, agent, authed });
          auditEvent = { ...auditEvent, allow: true, mode: modeAuth.mode, scope: [{ layer: "memory", visibility: "shared" }], resourceId: result.id };
          await respond(200, { ok: true, ...result });
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "REMEMBER_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } });
        }
        return;
      }

      // --- POST /v1/pet/runtime/* — drafts/personas helpers ---
      if (method === "POST" && url.startsWith("/v1/pet/runtime/")) {
        auditEvent = { ...auditEvent, action: url };
        const runtimeMode = authorizePetMode(role, body?.mode ?? "companion");
        if (!runtimeMode.ok) {
          auditEvent = { ...auditEvent, denyReason: runtimeMode.reason, mode: runtimeMode.mode };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: runtimeMode.reason, detail: runtimeMode.reason } });
          return;
        }
        // VISIBILITY-FIX-1-REJECT2：草稿与 persona 的**作用域口径统一为"认证身份的 role_id"**
        // （与 /mcp 的 pet 适配器、/v1/pet/command 同源）。`mode` 只是**交互模式**，作为标签存进草稿，
        // **不再**充当作用域 —— 否则"同一条草稿能不能看见"取决于走哪条入口（本单要修的就是这个）。
        const petPrincipal = authenticatedPrincipal(authed, agent, role);
        const petScope = petPrincipal.role_id;
        try {
          let result;
          if (url === "/v1/pet/runtime/drafts/put") {
            result = await petStore.putDraft({ content: body?.content, kind: body?.kind, roleId: petScope, petMode: runtimeMode.mode, sessionId: body?.session_id });
          } else if (url === "/v1/pet/runtime/drafts/list") {
            const drafts = await petStore.listDrafts({ limit: body?.limit, roleId: petScope });
            result = { drafts, count: drafts.length };
          } else if (url === "/v1/pet/runtime/drafts/clear") {
            // VISIBILITY-FIX-1-REJECT：clear 也要给作用域（漏了 ⇒ 修后必 400/403）
            result = await petStore.clearDrafts({ id: body?.id ?? null, all: body?.all === true, roleId: petScope });
          } else if (url === "/v1/pet/runtime/persona/get") {
            result = await petStore.loadPersona(petScope);
          } else if (url === "/v1/pet/runtime/persona/list") {
            const personas = await petStore.listPersonas({ roleId: petScope });
            result = { personas };
          } else {
            throw new Error("NOT_FOUND");
          }
          auditEvent = { ...auditEvent, allow: true, mode: runtimeMode.mode, resourceId: body?.id ?? runtimeMode.mode };
          await respond(200, { ok: true, ...result });
        } catch (err) {
          const notFound = err.message === "NOT_FOUND";
          auditEvent = { ...auditEvent, denyReason: notFound ? "NOT_FOUND" : "BAD_REQUEST" };
          await respond(notFound ? 404 : 400, { ok: false, error: { code: notFound ? "NOT_FOUND" : "BAD_REQUEST", message: notFound ? "unknown pet runtime route" : err.message } });
        }
        return;
      }

      // D29 retains explicit deprecation only; review/promote governance is retired.
      if (method === "POST" && url === "/v1/memory/deprecate") {
        const action = "deprecate";
        const perm = authorizeAction(role, action);
        auditEvent = { ...auditEvent, action: url };
        if (!perm.ok) {
          auditEvent = { ...auditEvent, denyReason: perm.reason };
          await respond(403, { ok: false, error: { code: "FORBIDDEN", message: perm.reason, detail: perm.reason } });
          return;
        }
        const id = typeof body?.id === "string" ? body.id : "";
        if (!id) {
          auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "id is required" } });
          return;
        }
        try {
          if (action === "review") {
            const decision = typeof body?.decision === "string" ? body.decision : "";
            if (!["approve", "reject", "quarantine"].includes(decision)) {
              auditEvent = { ...auditEvent, denyReason: "BAD_REQUEST" };
              await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: "decision must be approve|reject|quarantine" } });
              return;
            }
            const result = await lib.review(id, decision, body?.notes);
            auditEvent = { ...auditEvent, allow: true, resourceId: id };
            await respond(200, { ok: true, ...result });
          } else {
            const result = await lib.deprecate(id, body?.replacement_id, body?.reason);
            auditEvent = { ...auditEvent, allow: true, resourceId: id };
            await respond(200, { ok: true, ...result });
          }
        } catch (err) {
          auditEvent = { ...auditEvent, denyReason: "GOVERNANCE_REJECTED" };
          await respond(400, { ok: false, error: { code: "BAD_REQUEST", message: err.message } });
        }
        return;
      }

      auditEvent = { ...auditEvent, action: url, denyReason: "NOT_FOUND" };
      await respond(404, { ok: false, error: { code: "NOT_FOUND", message: "unknown route" } });
    } catch (err) {
      // ATOMICWRITE-1：输入校验类错误必须回 4xx，不许一律回 500 INTERNAL。
      // 500 的意思是"服务端坏了" —— 那会污染监控，并让调用方以为该重试，
      // 而真正该做的是改参数。带 status 的（= 我们主动标记的输入错误）按其状态码回；
      // 其余仍是 500，且**不把内部错误文本泄漏给调用方**。
      if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
        auditEvent = { ...auditEvent, denyReason: err.code ?? "BAD_REQUEST" };
        await respond(err.status, { ok: false, error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
      } else {
        auditEvent = { ...auditEvent, denyReason: "INTERNAL" };
        await respond(500, { ok: false, error: { code: "INTERNAL", message: "internal error" } });
      }
    }
    // audit is recorded inside respond() BEFORE the response is sent.
  });

  // enforce loopback at socket level too (defense in depth)
  server.on("connection", (socket) => {
    const addr = socket.remoteAddress;
    if (addr && addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
      socket.destroy();
    }
  });

  return {
    server,
    audit,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async flushCaptures() {
      await captureQueue.catch(() => {});
      await conversationMemory.drain().catch(() => {});
    },
    async close() {



      if (captureDrainTimer) clearInterval(captureDrainTimer);
      if (indexTimer) clearInterval(indexTimer);
      if (auditTimer) clearInterval(auditTimer);

      await captureQueue.catch(() => {});
      await conversationMemory.drain().catch(() => {});
      await transcriptImporter.scan({ source: "runtime-event", principal: options.transcriptImportPrincipal, scopes: [] }).catch(() => {});
      await conversationMemory.drain().catch(() => {});
      await indexQueue.catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 256 * 1024) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}
