// memory-lib — standalone core server entry (shell-core separation).
// Runs the memory core as an independent process; OpenClaw is NOT required.
//
// Usage:
//   node server.mjs
//   node server.mjs --data-root "I:\OpenClaw\memory-data\memory" --workspace-root "I:\OpenClaw\memory-data" --port 8787
//   node server.mjs --registry <identity.json> --secrets-dir <dir> --audit <audit.jsonl>
//
// Secret store (F8): wincred (Windows Credential Manager) is authoritative and is
// the default. The file store is an explicit opt-in, and the wincred migration
// fallback is opt-in too:
//   node server.mjs                                              # wincred only
//   node server.mjs --secret-store file                          # file store authoritative
//   node server.mjs --secret-fallback-file                       # wincred + file fallback (migration)
// An unusable --secret-store fails loudly here, before any data root is touched.
//
// All endpoints bind 127.0.0.1 only (host override is rejected unless loopback).
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServerLibFactory } from "./src/server-wiring.mjs";
import { loadSummaryIndex } from "./src/zh-summary-index.mjs";
import { createLocalhostServer } from "./src/localhost-server.mjs";
import { readFlagValue, readNonNegativeNumberFlag, resolveSecretStoreConfig, describeSecretStore, resolveCalendarTimezoneConfig, describeCalendarTimezone, ServerConfigError, SECRET_STORE_FLAG, FALLBACK_FLAG, WINCRED_CACHE_FLAG, CALENDAR_TIMEZONE_FLAG } from "./src/server-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// 2026-10-04：数据与本体搬到 .（旧路径 I:\OpenClaw\memory-data 保留为 junction 门牌，
// 供 openclaw.json / clawdbot.json / Memory-Archive-Daily 等既有引用继续解析）。
// 默认值跟着搬到新家，避免裸跑 `node server.mjs` 时又指回旧路径。
const dataRoot = arg("--data-root", "D:\\MemoryLib\\data\\memory");
const workspaceRoot = arg("--workspace-root", "D:\\MemoryLib\\data");
const port = Number(arg("--port", "8787"));
const host = arg("--host", "127.0.0.1");
const registryPath = arg("--registry", "D:\\MemoryLib\\data\\runtime\\identity.json");
const secretsDir = arg("--secrets-dir", "D:\\MemoryLib\\data\\runtime\\secrets");
const auditPath = arg("--audit", "D:\\MemoryLib\\data\\runtime\\audit\\access.jsonl");
const auditMaxBytes = Number(arg("--audit-max-bytes", String(64 * 1024 * 1024)));
const auditRetainMonths = Number(arg("--audit-retain-months", "12"));
const auditRotateIntervalMinutes = Number(arg("--audit-rotate-interval-minutes", "1440"));
const auditUnauthenticatedThreshold = Number(arg("--audit-unauthenticated-threshold", "100"));
const indexRefreshIntervalMinutes = Number(arg("--index-refresh-interval-minutes", "10"));
const indexScheduleEnabled = !process.argv.includes("--disable-index-refresh");
// REFINE-LOOP-1-REJECT1b：巡检报告落点。默认（不传）= <data-root>/project-state/memory-system/refinement-inspection.md
// （产品实际在读的那一份）。需要"报告不进检索根"的更严姿态时，指到 data root 之外或 runtime/ 下。
const refinementReportPath = arg("--refinement-report-path", null);
const apiKeyPepper = arg("--api-key-pepper", process.env.MEMORY_LIB_KEY_PEPPER || "");
let wincredCacheMs = null;
try {
  wincredCacheMs = readNonNegativeNumberFlag(process.argv, WINCRED_CACHE_FLAG);
} catch (error) {
  if (error instanceof ServerConfigError) {
    console.error(`[memory-lib] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

// F8: wincred is authoritative by default; file store and migration fallback are
// explicit opt-ins. Validate before anything else so a bad configuration can never
// start a server against the wrong credential store.
let secretStore;
try {
  secretStore = resolveSecretStoreConfig({
    flag: readFlagValue(process.argv, SECRET_STORE_FLAG),
    secretsDir,
    wincredReadScript: path.join(here, "scripts", "wincred-read.ps1"),
    fileFallback: process.argv.includes(FALLBACK_FLAG),
    wincredCacheMs,
  });
} catch (error) {
  if (error instanceof ServerConfigError) {
    console.error(`[memory-lib] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
if (secretStore.type === "wincred") {
  try {
    await fs.access(secretStore.readScript);
  } catch {
    console.error(`[memory-lib] wincred read helper not found: ${secretStore.readScript}`);
    process.exit(1);
  }
}

// TZ-CONFIG-1: deployment default timezone for bare (timezone-less) date input.
// Absent flag ⇒ null ⇒ the server keeps its historical **UTC** default, because the
// interpreted range of a bare date is observable behaviour that must not change
// silently. An unusable value fails startup here, before any data root is touched.
let calendarTimezone;
try {
  calendarTimezone = resolveCalendarTimezoneConfig({
    flag: readFlagValue(process.argv, CALENDAR_TIMEZONE_FLAG),
    env: process.env.MEMORY_LIB_CALENDAR_TIMEZONE ?? null,
  });
} catch (error) {
  if (error instanceof ServerConfigError) {
    console.error(`[memory-lib] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

// pet research: optional web-search provider (e.g. AutoSearch/ai-search-mcp bridge)
const petWebSearch = arg("--pet-web-search", "");
const petCredentialRef = arg("--pet-credential-ref", "");
const petAgentId = arg("--pet-agent-id", "");
const petRoleId = arg("--pet-role-id", "");
const captureAgentId = arg("--capture-agent-id", petAgentId);
const captureRoleId = arg("--capture-role-id", "capture-ingest");
// --capture-extract is deprecated and intentionally ignored; unknown compatibility flags do not block startup.
const petLlmConfigPath = arg("--pet-llm-config", "");
const petConfig = {
  webSearch: petWebSearch ? { provider: "http", endpoint: petWebSearch } : { provider: "none" },
  ...(petCredentialRef && petAgentId && petRoleId ? { openai: { credentialRef: petCredentialRef, principal: { agent_id: petAgentId, role_id: petRoleId } } } : {}),
};

const ollama = { endpoint: arg("--ollama-endpoint", "http://127.0.0.1:11434"), model: arg("--ollama-model", "bge-m3"), dimension: Number(arg("--ollama-dimension", "1024")) };
let petLlmConfig = {};
if (petLlmConfigPath) {
  try {
    petLlmConfig = JSON.parse(await fs.readFile(petLlmConfigPath, "utf8"));
  } catch (error) {
    console.error(`[memory-lib] pet LLM config unreadable: ${error.message}`);
    process.exit(1);
  }
}

// F6：控制台中文摘要 sidecar（离线产物，只读，不改记忆库/不进协议）。
// 解析顺序：--summary-index <path> > 环境变量 MEMORY_LIB_ZH_SUMMARY_INDEX > <workspace-root>/zh-summary.json。
// 传 none/off、文件不存在或 JSON 损坏 = 不附加摘要，控制台按英文原文回退（不报错、不影响任何端点）。
// 这里只做一次启动自检用于日志；真正读取由 library 按 mtime 缓存，sidecar 重新生成后无需重启。
const summaryIndexPath = arg("--summary-index", process.env.MEMORY_LIB_ZH_SUMMARY_INDEX || path.join(workspaceRoot, "zh-summary.json"));
const summaryIndex = loadSummaryIndex(summaryIndexPath, { onError: false });
console.log(summaryIndex
  ? `[memory-lib] zh summary sidecar: ${summaryIndexPath} (${summaryIndex.size} entries)`
  : `[memory-lib] zh summary sidecar: none (console falls back to English) — supply one with --summary-index <path>`);

// TZ-CONFIG-1-REJECT：libFactory 由 src/server-wiring.mjs 构造，与测试**同一份**实现。
// 上一版在这里手写工厂、解构里漏了 calendarTimezone ⇒ REST 吃了部署默认、`/mcp` 吃不到。
const libFactory = createServerLibFactory({
  dataRoot,
  workspaceRoot,
  calendarTimezone,
  ollama,
  summaryIndex: summaryIndexPath,
  onDerivedIndexError: ({ lane, operation, path: filePath, error }) => console.error(`[memory-lib] derived index ${lane}/${operation} failed for ${filePath}: ${error?.message ?? error}`),
});
const transcriptImportPrincipal = captureAgentId && captureRoleId ? { framework_id: "deepseek-harness", agent_id: captureAgentId, role_id: captureRoleId } : null;
const adapter = createLocalhostServer({ libFactory, registryPath, secretStore, auditPath, host, port, petConfig, secretsDir, llmConfig: petLlmConfig, transcriptImportPrincipal, auditMaxBytes, auditRetainMonths, auditRotateIntervalMinutes, auditUnauthenticatedThreshold, indexRefreshIntervalMinutes, indexScheduleEnabled, ...(calendarTimezone ? { calendarTimezone } : {}), ...(apiKeyPepper ? { apiKeyPepper } : {}), ...(refinementReportPath ? { refinementReportPath } : {}) });
let addr;
try {
  addr = await adapter.listen();
} catch (err) {
  if (err?.code === "EADDRINUSE") {
    console.error(`[memory-lib] 端口 ${port} 已被占用 —— 可能已有一个服务实例在运行。`);
    console.error(`[memory-lib] 请勿重复启动；控制台地址: http://127.0.0.1:${port}/console`);
  } else if (err?.code === "EACCES") {
    console.error(`[memory-lib] 无权限监听 ${host}:${port} —— 请换端口或用管理员运行。`);
  } else {
    console.error(`[memory-lib] 启动失败: ${err.message}`);
  }
  process.exit(1);
}
console.log(`[memory-lib] core listening on http://${addr.address}:${addr.port}`);
console.log(`[memory-lib] dataRoot: ${dataRoot}`);
console.log(`[memory-lib] registry: ${registryPath}`);
console.log(`[memory-lib] audit: ${auditPath}`);
console.log(`[memory-lib] secret store: ${describeSecretStore(secretStore)}`);
console.log(`[memory-lib] calendar timezone default: ${describeCalendarTimezone(calendarTimezone)}`);
if (secretStore.fileFallback) {
  console.log(`[memory-lib] ⚠️  migration file fallback ENABLED (dir: ${secretStore.fileFallback.dir}): a WinCred miss is served from the secret file once per credential_ref, with a one-time notice. Drop ${FALLBACK_FLAG} once every credential lives in WinCred.`);
}
console.log(`[memory-lib] health: http://127.0.0.1:${addr.port}/v1/health`);

process.on("SIGINT", async () => { await adapter.close(); process.exit(0); });
process.on("SIGTERM", async () => { await adapter.close(); process.exit(0); });
