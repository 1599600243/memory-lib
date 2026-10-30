// memory-lib MCP adapter — stdio + in-process JSON-RPC MCP server.
// Exposes the active D29 memory core (search/get/direct-write/deprecate/
// learning/pet/admin) as MCP tools. Retired proposal and promotion operations
// are not exposed.
//
// Identity comes from environment (stdio) or X-MCP-* headers (streamable-http),
// never from client input. Authorization is enforced by the CORE (this server
// never decides access). Capture payload validation mirrors the HTTP protocol
// boundary so both transports reject private fields identically. Stdio may use
// either the legacy machine credential variables or MCP_MEMORY_TOKEN, which is
// forwarded as the same Bearer session used by REST and Streamable HTTP.

//
//   MCP_MEMORY_URL          default http://127.0.0.1:8787
//   MCP_MEMORY_TOKEN        optional Bearer session token; takes precedence over machine credentials
//   MCP_MEMORY_CRED_REF     default memory-lib/deepseek-harness
//   MCP_MEMORY_SECRET       optional; takes precedence over MCP_MEMORY_SECRET_FILE
//   MCP_MEMORY_SECRET_FILE  optional; path to secret file
//   MCP_MEMORY_AGENT        default pilot-01
//   MCP_MEMORY_ROLE         default researcher
//
// Usage: node mcp/mcp-server.mjs   (MCP clients spawn it with stdio transport)

import fs from "node:fs/promises";
import readline from "node:readline";
import { resolveDateText } from "../src/date-query.mjs";
import { resultingWriteTarget, writeAuthorizationDenial, supersedeDenialFor, claimedIdentityOf } from "../src/write-authorization.mjs";

const PROTOCOL_VERSION = "2024-11-05";

const CAPTURE_FIELDS = new Set(["source", "conversation_id", "event_id", "session_id", "workspace", "tags", "extract", "partial", "messages"]);
const CAPTURE_MESSAGE_FIELDS = new Set(["role", "content"]);

function captureValidationError(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "capture event must be an object";
  const unknownFields = Object.keys(event).filter((key) => !CAPTURE_FIELDS.has(key));
  if (unknownFields.length) return `unsupported capture fields: ${unknownFields.join(", ")}`;
  if (!Array.isArray(event.messages) || event.messages.length === 0) return "messages are required";
  for (const message of event.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message) || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || Object.keys(message).some((key) => !CAPTURE_MESSAGE_FIELDS.has(key))) {
      return "messages require role=user|assistant and string content; no other fields are allowed";
    }
  }
  return null;
}

// ---- tool catalog -------------------------------------------------------------
// name, description, inputSchema (JSON Schema). MCP clients surface these verbatim.
const TOOLS = [
  { name: "memory_search", description: "在授权范围内搜索记忆库；省略 query 时按时间枚举。取全某一**天**用 calendarDate + calendarTimezone，或等价的 since=until=同一天（DAY-INTERVAL-1 起两种写法**完全等价**，都按该时区解析成半开窗口）。区间真值是半开 [since, untilExclusive)；回显的 until 是闭口径（= 最后一毫秒），两者相差 1ms。带时刻的 since/until 是**瞬时**边界，不做按天扩张。翻页优先用 nextCursor（keyset，写入并发下不重不漏）；offset 为兼容保留，见 next_offset 的局限。", inputSchema: { type: "object", properties: { query: { type: "string", description: "搜索关键词；时间枚举时可省略" }, limit: { type: "number", description: "每页条数，默认 10，上限 100" }, cursor: { type: "string", description: "keyset 游标：把上一页返回的 nextCursor 原样回传；与 offset 互斥，优先 cursor" }, offset: { type: "number", description: "【兼容保留】时间枚举偏移，默认 0。基于位次而非位置，翻页期间有新写入会重复/漏行；新接入请用 cursor" }, calendarDate: { type: "string", description: "本地日历日 YYYY-MM-DD；与 calendarTimezone 一起把「那一天」解析成半开 UTC 窗口（与 since=until=该日 完全等价）" }, calendarTimezone: { type: "string", description: "IANA 时区名（如 Asia/Shanghai）：同时解释 calendarDate 与**纯日期**形式的 since/until；省略则用**部署默认时区**（由运维用 --calendar-timezone 设定，未配置时为 UTC；实际用值见响应的 resolvedRange.calendarTimezone）" }, graphExpand: { type: "boolean", description: "默认启用图谱扩展；false 时仅使用索引和向量" }, documentQuota: { type: "number", description: "额外资料层配额，默认 3；0 表示关闭资料层" }, rawQuota: { type: "number", description: "原文层独立配额，默认 3；至少 1" }, searchMode: { type: "string", enum: ["memories", "documents", "evidence", "hybrid", "formal", "raw"], description: "正式记忆、资料、原文或混合，默认 hybrid；formal/raw 为兼容别名" }, as_of: { type: "string", description: "按指定时间点读取有效事实" }, include_superseded: { type: "boolean", description: "包含已被取代的历史记忆" }, workspace: { type: "string" }, tags: { type: "array", items: { type: "string" } }, since: { type: "string", description: "发生时间下限，**含**。纯 YYYY-MM-DD = 该日按 calendarTimezone 的**本地日**零点（DAY-INTERVAL-1 起；此前按 UTC 日）；带时刻 = 该瞬时" }, until: { type: "string", description: "发生时间上限，**含**（= 最后一毫秒）。纯 YYYY-MM-DD = 该日本地日的最后一毫秒（由次日本地零点减 1ms 派生；此前按 UTC 日）；带时刻 = 该瞬时，不做按天扩张" } } } },
  { name: "memory_graph_query", description: "查询认证 principal 可见的项目图谱；与 REST POST /v1/graph/query 对齐。", inputSchema: { type: "object", properties: { project_id: { type: "string", description: "项目标识" } }, required: ["project_id"] } },
  { name: "memory_list", description: "列出授权范围内的正式记忆，可按 workspace/tags 过滤。", inputSchema: { type: "object", properties: { limit: { type: "number" }, workspace: { type: "string" }, tags: { type: "array", items: { type: "string" } }, since: { type: "string", description: "发生时间下限（ISO 或 YYYY-MM-DD）" }, until: { type: "string", description: "发生时间上限（ISO 或 YYYY-MM-DD）" } } } },
  { name: "memory_get", description: "按 id 读取正式记忆；默认排除 cold，include_cold=true 可显式取回冷层。", inputSchema: { type: "object", properties: { id: { type: "string" }, include_cold: { type: "boolean" } }, required: ["id"] } },
  { name: "memory_health", description: "记忆库健康状态。", inputSchema: { type: "object", properties: {} } },
  { name: "memory_resolve_date", description: "把「10/10」「昨天」「上周三」「三天前」「最近三天」「上周一到上周三」这类人话时间表达归一成绝对日期范围（**纯规则、零模型**）。语法含：绝对日期与缺年日期、今天/昨天/前天/大前天/明天/后天/大后天、N天前、本周X/上周X/下X、本周/上周/上上周/下周、这个月/上个月/上上个月/上个月N号、最近N天/近N周/近N个月、A到B 区间、以及「…那天」口语尾巴。拿到结果后：`calendarDate` 非空时用 `memory_search` 的 calendarDate + calendarTimezone 取全那一天；是区间时用 since/until（或逐日枚举）。`now` 必须由调用方给出（平台不猜当前时间），以便同一请求可重放。解析不了会明确失败且**不返回 range** —— 不要把失败当成「搜全库」。", inputSchema: { type: "object", properties: { text: { type: "string", description: "时间表达，也可以是「最近三天聊了什么」这样的整句" }, now: { type: "string", description: "ISO 瞬时，解析相对时间的锚点（如 2026-10-10T01:00:00.000Z）；必填" }, timezone: { type: "string", description: "IANA 时区名（如 Asia/Shanghai）；也接受已收录的 Windows 名（如 China Standard Time），响应会回传归一化后的 IANA 名" }, locale: { type: "string", description: "如 zh-CN；缺省 zh-CN。显式传 null 表示 locale 未知，此时 10/11 这类会返回 ambiguous 候选而不是替你选" }, weekStartsOn: { type: "number", description: "0=周日, 1=周一（默认）。影响「本周/上周/上上周/下周」与裸星期几的锚点，并会在响应里回传" } }, required: ["text", "now"] } },
  { name: "memory_refinement_pending", description: "列出认证 principal 可见且尚未被正式记忆引用的对话证据。", inputSchema: { type: "object", properties: { limit: { type: "number" }, since: { type: "string", description: "ISO 日期或时间；默认今天" } } } },
  { name: "memory_write", description: "统一零模型直接写入记忆层。允许 curated-shared、agent、project-state、project-decision、project-progress、tool、plan、profile、document。", inputSchema: { type: "object", properties: { layer: { type: "string" }, id: { type: "string" }, agent: { type: "string" }, project: { type: "string" }, body: { type: "string" }, occurred_at: { type: "string" }, valid_from: { type: "string" }, valid_to: { type: "string" }, tags: { type: "array", items: { type: "string" } }, evidence_refs: { type: "array", items: { type: "string" } }, entries: { type: "array", items: { type: "object" } }, visibility: { type: "string", enum: ["platform", "shared", "user", "private", "role", "agent", "project", "daily"], description: "可选可见性；省略时保持当前默认" } }, required: ["layer", "evidence_refs"] } },
  { name: "memory_supersede", description: "用新记忆原子取代同一授权作用域内的旧记忆；保留旧记忆和取代链。", inputSchema: { type: "object", properties: { old_id: { type: "string" }, layer: { type: "string" }, id: { type: "string" }, body: { type: "string" }, valid_from: { type: "string" }, evidence_refs: { type: "array", items: { type: "string" } }, visibility: { type: "string" } }, required: ["old_id", "layer", "body", "evidence_refs"] } },
  { name: "memory_deprecate", description: "废弃一条正式记忆（需 deprecate 角色），可带 replacement_id / reason。", inputSchema: { type: "object", properties: { id: { type: "string" }, replacement_id: { type: "string" }, reason: { type: "string" } }, required: ["id"] } },

  { name: "learning_plan_get", description: "读学习计划（需 learning 角色）。", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
  { name: "learning_plan_put", description: "写学习计划（需 learning 角色）。", inputSchema: { type: "object", properties: { topic: { type: "string" }, plan: { type: "object" } }, required: ["topic", "plan"] } },
  { name: "learning_progress_get", description: "读学习进度（需 learning 角色）。", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
  { name: "learning_progress_put", description: "写学习进度（需 learning 角色）。", inputSchema: { type: "object", properties: { topic: { type: "string" }, progress: { type: "object" } }, required: ["topic", "progress"] } },
  { name: "learning_review_get", description: "读间隔重复复习记录（需 learning 角色）。省略 topic 时返回所有学习主题的到期复习项（含 topic 与 plan.json 的模块标题，按 next_due 升序）。", inputSchema: { type: "object", properties: { topic: { type: "string", description: "学习主题；省略=聚合全部主题的到期项" } } } },
  { name: "learning_review_put", description: "写间隔重复复习结果（需 learning 角色）。", inputSchema: { type: "object", properties: { topic: { type: "string" }, results: { type: "object" } }, required: ["topic", "results"] } },
  { name: "learning_profile_get", description: "读学习者画像（需 learning 角色）。", inputSchema: { type: "object", properties: {} } },
  { name: "learning_profile_put", description: "写学习者画像（需 learning 角色）。", inputSchema: { type: "object", properties: { profile: { type: "object" } }, required: ["profile"] } },

  { name: "pet_command", description: "宠物交互：斜杠命令 + 多模式对话（需 pet 角色）。", inputSchema: { type: "object", properties: { input: { type: "string", description: "命令或对话内容" }, mode: { type: "string", description: "chat|learn|research|...，默认 chat" }, history: { type: "array", items: { type: "object" } } }, required: ["input"] } },
  { name: "memory_capture_conversation", description: "保存脱敏对话原文 evidence；不创建候选。extract 是已废弃并忽略的兼容字段。", inputSchema: { type: "object", properties: { source: { type: "string" }, conversation_id: { type: "string" }, event_id: { type: "string" }, session_id: { type: "string" }, workspace: { type: "string" }, tags: { type: "array", items: { type: "string" } }, extract: { type: "boolean" }, partial: { type: "boolean" }, messages: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } }, required: ["role", "content"], additionalProperties: false } } }, required: ["source", "conversation_id", "event_id", "messages"] } },
  { name: "memory_capture_complete", description: "完成一次对话捕获；语义与 memory_capture_conversation 相同。", inputSchema: { type: "object", properties: { source: { type: "string" }, conversation_id: { type: "string" }, event_id: { type: "string" }, session_id: { type: "string" }, workspace: { type: "string" }, tags: { type: "array", items: { type: "string" } }, extract: { type: "boolean" }, partial: { type: "boolean" }, messages: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } }, required: ["role", "content"], additionalProperties: false } } }, required: ["source", "conversation_id", "event_id", "messages"], additionalProperties: false } },
  { name: "memory_ingest", description: "从显式文件或目录导入外部记忆；默认 dry_run=true，执行前必须用相同参数预览。", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } }, recursive: { type: "boolean" }, glob: { type: "string" }, kind: { type: "string", enum: ["conversation", "document"] }, source: { type: "string" }, tags: { type: "array", items: { type: "string" } }, scope: { type: "object" }, extract: { type: "boolean" }, dry_run: { type: "boolean" } }, required: ["paths"] } },
  { name: "evidence_import", description: "写入一条证据资料。", inputSchema: { type: "object", properties: { id: { type: "string" }, content: { type: "string" } }, required: ["id", "content"] } },
  { name: "evidence_get", description: "读取证据资料。", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "evidence_list", description: "列出证据资料。", inputSchema: { type: "object", properties: {} } },
  { name: "recovery_plan_get", description: "读取恢复计划。", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "recovery_plan_put", description: "写入恢复计划。", inputSchema: { type: "object", properties: { id: { type: "string" }, content: { type: "string" } }, required: ["id", "content"] } },
  { name: "recovery_status", description: "读取恢复状态。", inputSchema: { type: "object", properties: {} } },
  { name: "recovery_restore_validate", description: "验证恢复路径。", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "memory_transcript_import_status", description: "查看 transcript 导入状态（只读）。", inputSchema: { type: "object", properties: {} } },
  { name: "memory_transcript_import_scan", description: "扫描 transcript 导入目录并进入统一捕获队列。", inputSchema: { type: "object", properties: { source: { type: "string" } } } },
  { name: "pet_remember", description: "通过宠物 remember 语义直接写入 D29 目标层，并保留证据引用。", inputSchema: { type: "object", properties: { input: { type: "string" }, content: { type: "string" }, mode: { type: "string" }, session_id: { type: "string" } } } },
  { name: "pet_drafts_put", description: "保存宠物运行时草稿。", inputSchema: { type: "object", properties: { content: { type: "string" }, kind: { type: "string" }, mode: { type: "string" }, session_id: { type: "string" } }, required: ["content"] } },
  { name: "pet_drafts_list", description: "列出宠物运行时草稿。", inputSchema: { type: "object", properties: { limit: { type: "number" }, mode: { type: "string" } } } },
  { name: "pet_drafts_clear", description: "清理宠物运行时草稿。", inputSchema: { type: "object", properties: { id: { type: "string" }, all: { type: "boolean" }, mode: { type: "string" } } } },
  { name: "pet_persona_get", description: "读取宠物 Persona。", inputSchema: { type: "object", properties: { role_id: { type: "string" }, mode: { type: "string" } } } },
  { name: "pet_persona_list", description: "列出宠物 Persona。", inputSchema: { type: "object", properties: { mode: { type: "string" } } } },
  { name: "pet_persona_put", description: "保存用户明确提供的 Persona 偏好。", inputSchema: { type: "object", properties: { content: { type: "string" }, role_id: { type: "string" }, mode: { type: "string" } }, required: ["content"] } },

  { name: "admin_registry", description: "查看身份注册表无密视图（需 admin 角色）。", inputSchema: { type: "object", properties: {} } },
  { name: "admin_audit", description: "查询审计日志（需 admin 角色）。", inputSchema: { type: "object", properties: { limit: { type: "number" }, allow: { type: "boolean" } } } },
  { name: "admin_registry_revoke", description: "撤销框架凭证（需 admin 角色）。", inputSchema: { type: "object", properties: { framework_id: { type: "string" } }, required: ["framework_id"] } },
  { name: "admin_registry_activate", description: "恢复框架凭证（需 admin 角色）。", inputSchema: { type: "object", properties: { framework_id: { type: "string" } }, required: ["framework_id"] } },
  { name: "admin_maintenance_purge", description: "删除冷层条目；必须显式 ids，默认 dry_run，需 admin 或 librarian 身份。", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, reason: { type: "string" }, dry_run: { type: "boolean" } }, required: ["ids", "reason"] } },






  { name: "memory_tool_list", description: "列出工具记忆（tools-memory），可按 env 过滤。", inputSchema: { type: "object", properties: { env: { type: "string" } } } },

  { name: "memory_plan_confirm", description: "人工确认：把 draft 计划升为 active。", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
  { name: "memory_plan_done", description: "把 active 计划标记为 done（默认视图隐藏但可检索）。", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
  { name: "memory_plan_list", description: "列出计划（plans）；done 默认隐藏。", inputSchema: { type: "object", properties: { include_done: { type: "boolean" } } } },

  { name: "memory_recall_brief", description: "主动召回：返回有界摘要（默认 ≤2000 字，format=prompt 时 ≤1500 字），固定五板块 + 「近期记忆」 + 「我的经验」；format=prompt 可直接注入系统提示。INJECT-1 起「近期记忆」会读 curated/shared：带 query 时按相关度取、否则取近 days 天，并在 included 里回执 {id, calendarDate, excerpt}。", inputSchema: { type: "object", properties: { project: { type: "string" }, days: { type: "number", description: "近期经历天数，默认 7" }, limit_chars: { type: "number", description: "总长度上限" }, format: { type: "string", description: "markdown（默认）| prompt" }, query: { type: "string", description: "有 query 时「近期记忆」按相关度取（自动注入用最近几条对话文本）" }, memories: { type: "number", description: "「近期记忆」最多几条，默认 6，上限 8" }, memory_limit_chars: { type: "number", description: "「近期记忆」字数上限，默认 600" }, memory_only: { type: "boolean", description: "true 时只渲染「近期记忆」段（给自动注入用）" } } } },

  { name: "memory_role_list", description: "列出角色记忆；可按 agent_id/role_id 过滤。", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, role_id: { type: "string" } } } },
];

// ---- tool dispatch: tool name -> (core, args) => {status, data} -----------------
const DISPATCH = {
  memory_search: (c, a) => c.search(a.query, a.limit, a.documentQuota, a.workspace, a.tags, a.since, a.until, a.graphExpand !== false, a.rawQuota, a.searchMode, a.as_of, a.include_superseded, a.offset, a.cursor ?? null, a.calendarDate ?? null, a.calendarTimezone ?? null),
  memory_graph_query: (c, a) => c.graphQuery(a.project_id),
  memory_list: (c, a) => c.memoryList(a.limit, a.workspace, a.tags, a.since, a.until),
  memory_get: (c, a) => c.get(a.id, a.include_cold === true),
  memory_health: (c) => c.health(),
  memory_resolve_date: (c, a) => c.resolveDate({ text: a.text, now: a.now, timezone: a.timezone, locale: a.locale, weekStartsOn: a.weekStartsOn }),
  memory_refinement_pending: (c, a) => c.refinementPending(a.limit, a.since),
  memory_write: (c, a) => c.write(a),
  memory_supersede: (c, a) => c.supersede(a),
  memory_deprecate: (c, a) => c.deprecate(a.id, a.replacement_id, a.reason),
  learning_plan_get: (c, a) => c.learningPlanGet(a.topic),
  learning_plan_put: (c, a) => c.learningPlanPut(a.topic, a.plan),
  learning_progress_get: (c, a) => c.learningProgressGet(a.topic),
  learning_progress_put: (c, a) => c.learningProgressPut(a.topic, a.progress),
  learning_review_get: (c, a) => c.learningReviewGet(a.topic),
  learning_review_put: (c, a) => c.learningReviewPut(a.topic, a.results),
  learning_profile_get: (c) => c.learningProfileGet(),
  learning_profile_put: (c, a) => c.learningProfilePut(a.profile),
  pet_command: (c, a) => c.petCommand(a.input, a.mode, a.history),
  memory_capture_conversation: (c, a) => {
    const error = captureValidationError(a);
    return error ? { status: 400, data: { error: { code: "BAD_REQUEST", message: error, detail: error.startsWith("unsupported capture fields") ? "UNSUPPORTED_FIELDS" : "UNSUPPORTED_MESSAGE_FIELDS" } } } : c.captureConversation(a);
  },
  memory_capture_complete: (c, a) => {
    const error = captureValidationError(a);
    return error ? { status: 400, data: { error: { code: "BAD_REQUEST", message: error, detail: error.startsWith("unsupported capture fields") ? "UNSUPPORTED_FIELDS" : "UNSUPPORTED_MESSAGE_FIELDS" } } } : c.captureComplete(a);
  },
  memory_ingest: (c, a) => c.memoryIngest(a),
  evidence_import: (c, a) => c.evidenceImport(a.id, a.content),
  evidence_get: (c, a) => c.evidenceGet(a.id),
  evidence_list: (c) => c.evidenceList(),
  recovery_plan_get: (c, a) => c.recoveryPlanGet(a.id),
  recovery_plan_put: (c, a) => c.recoveryPlanPut(a.id, a.content),
  recovery_status: (c) => c.recoveryStatus(),
  recovery_restore_validate: (c, a) => c.recoveryRestoreValidate(a.path || ""),
  memory_transcript_import_status: (c) => c.transcriptImportStatus(),
  memory_transcript_import_scan: (c, a) => c.transcriptImportScan(a.source),
  pet_remember: (c, a) => c.petRemember(a),
  pet_drafts_put: (c, a) => c.petDraftsPut(a),
  pet_drafts_list: (c, a) => c.petDraftsList(a),
  pet_drafts_clear: (c, a) => c.petDraftsClear(a),
  pet_persona_get: (c, a) => c.petPersonaGet(a),
  pet_persona_list: (c, a) => c.petPersonaList(a),
  pet_persona_put: (c, a) => c.petPersonaPut(a),
  admin_registry: (c) => c.adminRegistry(),
  admin_audit: (c, a) => c.adminAudit(a.limit, a.allow),
  admin_registry_revoke: (c, a) => c.adminRevoke(a.framework_id),
  admin_registry_activate: (c, a) => c.adminActivate(a.framework_id),
  admin_maintenance_purge: (c, a) => c.adminMaintenancePurge(a.ids, a.reason, a.dry_run),
  memory_tool_list: (c, a) => c.toolList(a),
  memory_plan_confirm: (c, a) => c.planConfirm(a.topic),
  memory_plan_done: (c, a) => c.planDone(a.topic),
  memory_plan_list: (c, a) => c.planList(a),
  memory_recall_brief: (c, a) => c.recallBrief(a),
  memory_role_list: (c, a) => c.roleList(a),
};

// ---- stdio (HTTP) core client --------------------------------------------------
export function createCoreClient(baseUrl, identity) {
  async function call(route, body) {
    const headers = { "content-type": "application/json" };
    const bearer = identity.token ?? identity.accessToken;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const authBody = bearer ? {} : { credential_ref: identity.credRef, secret: identity.secret, principal: { agent_id: identity.agent, role_id: identity.role } };
    const res = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...authBody, ...(body || {}) }),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  return {
    resolveDate: ({ text, now, timezone, locale, weekStartsOn } = {}) => call("/v1/date/resolve", { text, now, timezone, locale, weekStartsOn }),
    health: async () => { const res = await fetch(`${baseUrl}/v1/health`); return { status: res.status, data: await res.json().catch(() => ({})) }; },
    refinementPending: (limit, since) => call("/v1/refinement/pending", { limit, since }),
    search: (q, limit, documentQuota, workspace, tags, since, until, graphExpand = true, rawQuota, searchMode, as_of, include_superseded, offset, cursor = null, calendarDate = null, calendarTimezone = null) => call("/v1/search", { query: q, limit, offset, cursor, calendarDate, calendarTimezone, documentQuota, rawQuota, searchMode, as_of, include_superseded, workspace, tags, since, until, graphExpand }),
    graphQuery: (project_id) => call("/v1/graph/query", { project_id }),
    memoryList: (limit, workspace, tags, since, until) => call("/v1/memory/list", { limit, workspace, tags, since, until }),
    get: (id, include_cold = false) => call("/v1/get", { id, include_cold }),
    write: (payload) => call("/v1/write", payload),
    supersede: (payload) => call("/v1/memory/supersede", payload),
    deprecate: (id, replacement_id, reason) => call("/v1/memory/deprecate", { id, replacement_id, reason }),
    learningPlanGet: (topic) => call("/v1/learning/plan_get", { topic }),
    learningPlanPut: (topic, plan) => call("/v1/learning/plan_put", { topic, plan }),
    learningProgressGet: (topic) => call("/v1/learning/progress_get", { topic }),
    learningProgressPut: (topic, progress) => call("/v1/learning/progress_put", { topic, progress }),
    learningReviewGet: (topic) => call("/v1/learning/review_get", topic ? { topic } : {}),
    learningReviewPut: (topic, results) => call("/v1/learning/review_put", { topic, results }),
    learningProfileGet: () => call("/v1/learning/profile_get", {}),
    learningProfilePut: (profile) => call("/v1/learning/profile_put", { profile }),
    petCommand: (input, mode, history) => call("/v1/pet/command", { input, mode, history }),
    captureConversation: (event) => call("/v1/conversations/capture", event),
    captureComplete: (event) => call("/v1/conversations/complete", event),
    memoryIngest: (payload) => call("/v1/ingest", payload),
    transcriptImportStatus: () => call("/v1/transcripts/import/status", {}),
    transcriptImportScan: (source) => call("/v1/transcripts/import/scan", { source }),
    petRemember: (payload) => call("/v1/pet/remember", payload),
    petDraftsPut: (payload) => call("/v1/pet/runtime/drafts/put", payload),
    petDraftsList: (payload) => call("/v1/pet/runtime/drafts/list", payload),
    petDraftsClear: (payload) => call("/v1/pet/runtime/drafts/clear", payload),
    petPersonaGet: (payload) => call("/v1/pet/runtime/persona/get", payload),
    petPersonaList: (payload) => call("/v1/pet/runtime/persona/list", payload),
    petPersonaPut: (payload) => call("/v1/pet/runtime/persona/put", payload),
    adminRegistry: () => call("/v1/admin/registry", {}),
    adminAudit: (limit, allow) => call("/v1/admin/audit", { limit, allow }),
    adminRevoke: (framework_id) => call("/v1/admin/registry/revoke", { framework_id }),
    adminActivate: (framework_id) => call("/v1/admin/registry/activate", { framework_id }),
     adminMaintenancePurge: (ids, reason, dry_run = true) => call("/v1/admin/maintenance/purge", { ids, reason, dry_run }),




    evidenceImport: (id, content) => call("/v1/evidence/import", { id, content }),
    evidenceGet: (id) => call("/v1/evidence/get", { id }),
    evidenceList: () => call("/v1/evidence/list", {}),
    recoveryPlanGet: (id) => call("/v1/recovery/plan_get", { id }),
    recoveryPlanPut: (id, content) => call("/v1/recovery/plan_put", { id, content }),
    recoveryStatus: () => call("/v1/recovery/status", {}),
    recoveryRestoreValidate: (path) => call("/v1/recovery/restore_validate", { path }),
    toolList: (payload) => call("/v1/tools/list", payload || {}),
    planConfirm: (topic) => call("/v1/plans/confirm", { topic }),
    planDone: (topic) => call("/v1/plans/done", { topic }),
    planList: (payload) => call("/v1/plans/list", payload || {}),
    recallBrief: (payload) => call("/v1/recall/brief", payload || {}),
    roleList: (payload) => call("/v1/roles/list", payload || {}),
  };
}

// ---- action gates for the in-process core --------------------------------------
// The REST routes authorize every operation against the authenticated role's
// action list. This in-process core is the same trust boundary reached through
// MCP, so it must apply the identical gates: an MCP client must never reach an
// operation that the same identity could not reach over REST (nor vice versa).
// The granted actions always come from the authenticated role, never from
// request input; when the host supplies none, only the legacy
// read/write/pet compatibility flags are granted and every other action fails closed.
const REQUIRED_ACTIONS = Object.freeze({
  search: ["search"],
  // M2.1-B1：日期归一与 REST 的 /v1/date/resolve 同口径（只读换算，要求 search 动作）。
  resolveDate: ["search"],
  graphQuery: ["search"],
  memoryList: ["search"],
  refinementPending: ["search"],
  get: ["get"],
  write: ["propose"],
  supersede: ["propose"],
  deprecate: ["deprecate"],
  learningPlanGet: ["learning"],
  learningPlanPut: ["learning"],
  learningProgressGet: ["learning"],
  learningProgressPut: ["learning"],
  learningReviewGet: ["learning"],
  learningReviewPut: ["learning"],
  learningProfileGet: ["learning"],
  learningProfilePut: ["learning"],
  petCommand: ["pet"],
  captureConversation: ["propose", "pet"],
  captureComplete: ["propose", "pet"],
  transcriptImportStatus: ["search"],
  transcriptImportScan: ["propose", "pet"],
  adminRegistry: ["admin"],
  adminAudit: ["admin"],
  adminRevoke: ["admin"],
  adminActivate: ["admin"],
  adminMaintenancePurge: ["admin", "librarian"],
  evidenceImport: ["propose"],
  evidenceGet: ["search"],
  evidenceList: ["search"],
  recoveryPlanGet: ["search"],
  recoveryPlanPut: ["propose"],
  recoveryStatus: ["search"],
  recoveryRestoreValidate: ["search"],
  toolList: ["search"],
  planConfirm: ["propose"],
  planDone: ["propose"],
  planList: ["search"],
  recallBrief: ["search"],
  roleList: ["search"],
});

function gateCore(core, grantedActions) {
  const granted = new Set(Array.isArray(grantedActions) ? grantedActions : []);
  const out = {};
  for (const [name, fn] of Object.entries(core)) {
    const required = REQUIRED_ACTIONS[name];
    out[name] = !required || required.some((action) => granted.has(action))
      ? fn
      : () => ({ status: 403, data: { error: { code: "FORBIDDEN", message: `${name} requires the ${required.join(" or ")} action`, detail: "ACTION_DENIED" } } });
  }
  return out;
}

// ---- in-process core (used by the /mcp HTTP endpoint) --------------------------
// services = { lib, learning, pet, admin, graph } — all provided by the host.
export function coreFromLib(services, principal, { allowPropose = true, allowPet = true, allowSearch = true, actions = null, scopes = null, calendarTimezone = null } = {}) {
  const { lib, learning, pet, admin, conversationMemory, transcriptImporter, memoryIngest, petRuntime, petRemember, tools, plans, project, recall, profile, roleMemory, writer, evidenceRecovery } = services;
  // TZ-CONFIG-1-REJECT：**部署默认时区**必须由宿主（localhost-server）注入，与 REST 路由同源。
  // 本文件**不读 flag/env**，也不自己兜底 "UTC" —— 否则进程内 `/mcp` 会与 /v1/search 分裂
  // （这正是本单被打回的原因：REST 177/Asia/Shanghai vs /mcp 146/UTC）。
  // 优先用宿主显式给的；没给就退回**同一个 lib 实例**的部署默认（两者同源于 createMemoryLib）。
  const deploymentTimezone = calendarTimezone ?? lib?.calendarTimezone ?? null;
  if (typeof deploymentTimezone !== "string" || !deploymentTimezone) {
    throw new Error("coreFromLib requires the host's deployment calendarTimezone (or a lib exposing .calendarTimezone); refusing to invent a default");
  }
  // When the host provides the role's action list it is the single authority and
  // the legacy flags are derived from it, so inner checks cannot drift from the
  // outer gates.
  const grantedActions = Array.isArray(actions)
    ? actions
    : [...(allowSearch ? ["search", "get"] : []), ...(allowPropose ? ["propose"] : []), ...(allowPet ? ["pet"] : [])];
  if (Array.isArray(actions)) {
    allowPropose = actions.includes("propose");
    allowPet = actions.includes("pet");
    allowSearch = actions.includes("search");
  }
  // WRITE-DENY-1：/mcp 与 REST 是同一道写门。这里把宿主的 actions + scopes 组成同一个 role 形状，
  // 交给**同一个** write-authorization 判据（不另写一套），保证两条传输不会各判一套。
  const roleLike = { actions: grantedActions, scopes: Array.isArray(scopes) ? scopes : [] };
  function writeGate(payload = {}, entry = "/mcp memory_write") {
    const denial = writeAuthorizationDenial({
      target: resultingWriteTarget({ layer: payload?.layer ?? null, container: payload?.container ?? null, visibility: payload?.visibility ?? undefined }),
      role: roleLike,
      project: payload?.project ?? null,
      entry,
      // WRITE-DENY-1-REJECT1（F4）：/mcp 也必须有身份位判据，且身份只能来自服务端绑定。
      principal,
      claimed: claimedIdentityOf(payload),
    });
    if (denial) throw Object.assign(new Error(`WRITE_SCOPE_DENIED: ${denial.code}: ${denial.message}`), { code: "WRITE_SCOPE_DENIED", detail: denial.code });
  }
  /** F2：取代会同时改新旧两条记录，必须在写之前按旧记录真实的可见性走同一把尺子。 */
  function supersedeGate(oldRecord, payload = {}, entry = "/mcp memory_supersede") {
    const denial = supersedeDenialFor({ oldRecord, role: roleLike, entry, principal, claimed: claimedIdentityOf(payload) });
    if (denial) throw Object.assign(new Error(`WRITE_SCOPE_DENIED: ${denial.code}: ${denial.message}`), { code: "WRITE_SCOPE_DENIED", detail: denial.code });
  }
  function authenticatedWrite(payload = {}) {
    if (!principal || ![principal.framework_id, principal.agent_id, principal.role_id].every((value) => typeof value === "string" && value.trim())) throw Object.assign(new Error("validated principal is required"), { code: "INVALID_WRITE_IDENTITY" });
    const refs = payload.evidence_refs;
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== "string" || !ref.trim())) throw new Error("evidence_refs must be a non-empty string array");
    const visibility = payload.visibility === undefined ? null : String(payload.visibility).trim();
    const allowed = new Set(["platform", "shared", "user", "private", "role", "agent", "project", "daily"]);
    if (visibility !== null && !allowed.has(visibility)) throw Object.assign(new Error("WRITE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED" });
    if (visibility === "user" && payload.user_id !== undefined && String(payload.user_id) !== String(principal.user_id)) throw Object.assign(new Error("WRITE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED" });
    if (visibility === "shared" && payload.group_id !== undefined && String(payload.group_id) !== String(principal.group_id)) throw Object.assign(new Error("WRITE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED" });
    if (visibility === "role" && payload.role_id !== undefined && String(payload.role_id) !== String(principal.role_id)) throw Object.assign(new Error("WRITE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED" });
    if (visibility === "agent" && payload.agent !== undefined && String(payload.agent) !== String(principal.agent_id)) throw Object.assign(new Error("WRITE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED" });
    // WRITE-DENY-1：把"写出来的可见性"这把尺子也用在 /mcp 上（显式 platform 的旧检查被它覆盖；
    // document/tool 这类**默认**写成 platform 的层同样被拦，而 payload 里没有 visibility 也一样）。
    writeGate(payload, "/mcp memory_write");
    return { ...payload, evidence_refs: [...new Set(refs.map((ref) => ref.trim()))], principal };
  }
  async function wrap(fn) {
    try { return { status: 200, data: await fn() }; }
    catch (e) {
      // A service may throw a tagged denial to keep the status/code of the REST
      // route it mirrors (e.g. pet mode denied -> 403 FORBIDDEN).
      return { status: Number.isInteger(e?.status) ? e.status : 400, data: { error: { code: e?.code ?? "BAD_REQUEST", message: e.message } } };
    }
  }
  const petDenied = () => ({ status: 403, data: { error: { code: "FORBIDDEN", message: "pet action denied", detail: "ACTION_DENIED" } } });
  return gateCore({
    // VISIBILITY-FIX-1（内容级）：`lib.health()` 会带回 checks[].path 等**服务器绝对路径**。
    // REST 的 GET /v1/health 本来就是 path-free（localhost-server.mjs:722），这里对齐它，
    // 只保留状态与原因，不暴露部署路径/用户名。
    health: async () => {
      const h = await lib.health();
      const stripPaths = (list) => Array.isArray(list) ? list.map(({ path: _p, ...rest }) => rest) : list;
      return {
        status: 200,
        data: {
          health: h.health,
          reason: h.reason ?? null,
          vector: h.vector ? { status: h.vector.status, reason: h.vector.reason, model: h.vector.detail?.model ?? null, dimension: h.vector.detail?.dimension ?? null } : null,
          capacity: h.capacity ?? null,
          checks: stripPaths(h.checks).map((c) => ({ name: c.name, status: c.status })),
        },
      };
    },
    resolveDate: ({ text, now, timezone, locale, weekStartsOn } = {}) => {
      const resolved = resolveDateText({ text, now, timezone: timezone ?? deploymentTimezone, locale, weekStartsOn });
      if (resolved.ok) return { status: 200, data: { ok: true, principal, ...resolved } };
      // 解析失败是**调用方可恢复的输入问题**：用 422 + 精确 reason 回报，
      // 而不是一句吞掉原因的"操作失败"。失败分支**不带 range** ⇒ 调用方不可能把它当 wildcard。
      return {
        status: 422,
        data: {
          ok: false,
          reason: resolved.reason,
          error: {
            code: resolved.reason.toUpperCase().replace(/-/gu, "_"),
            message: resolved.message,
            detail: resolved.reason,
            ...(resolved.ambiguous ? { ambiguous: resolved.ambiguous } : {}),
          },
        },
      };
    },
    search: async (query, limit, documentQuota, workspace, tags, since, until, graphExpand = true, rawQuota, searchMode, as_of, include_superseded, offset, cursor = null, calendarDate = null, calendarTimezone = null) => {
      // DAYRECALL-1：calendarDate 与 since/until 一样是「时间范围」入口，单独给出即合法。
      if (!String(query ?? "").trim() && !since && !until && !calendarDate) return { status: 400, data: { error: { code: "BAD_REQUEST", message: "query or time range is required" } } };
      if (!String(query ?? "").trim()) return { status: 200, data: { ok: true, principal, ...await lib.timeline({ limit, offset, cursor, calendarDate, ...(calendarTimezone ? { calendarTimezone } : {}), workspace, tags, since, until, include_superseded }) } };
      const results = await lib.search({ query, limit, documentQuota, rawQuota, searchMode, as_of, include_superseded, workspace, tags, since, until, graphExpand, calendarDate, calendarTimezone: calendarTimezone ?? deploymentTimezone });
      return { status: 200, data: { ok: true, principal, count: results.length, results } };
    },
    graphQuery: async (projectId) => wrap(async () => ({ ok: true, principal: { framework: principal.framework_id, agent: principal.agent_id, role: principal.role_id }, graph: await lib.graph({ tenantId: principal.tenant_id ?? "default", projectId, principal }) })),
    memoryList: async (limit, workspace, tags, since, until) => allowSearch ? (async () => { const items = await lib.listMemories({ limit, workspace, tags, since, until }); return { status: 200, data: { ok: true, principal, count: items.length, items } }; })() : { status: 403, data: { error: { code: "FORBIDDEN", message: "memory list requires the search action", detail: "ACTION_DENIED" } } },
    refinementPending: async (limit, since) => allowSearch ? wrap(() => lib.pendingRefinement({ group_id: principal.group_id === "unknown" ? null : principal.group_id, user_id: principal.user_id === "unknown" ? null : principal.user_id, limit, since })) : { status: 403, data: { error: { code: "FORBIDDEN", message: "refinement pending list requires the search action", detail: "ACTION_DENIED" } } },
     get: async (id, includeCold = false) => { const item = await lib.get(id, { include_cold: includeCold }); return item ? { status: 200, data: { item } } : { status: 404, data: { error: { code: "NOT_FOUND", message: "item not found" } } }; },
    write: (payload) => !allowPropose ? { status: 403, data: { error: { code: "FORBIDDEN", message: "write requires write authorization", detail: "ACTION_DENIED" } } } : wrap(() => { const authenticated = authenticatedWrite(payload); return (authenticated.layer === "project-progress" ? writer.writeProgress : writer.write)(authenticated); }),
     supersede: async (payload) => !allowPropose ? { status: 403, data: { error: { code: "FORBIDDEN", message: "supersede requires write authorization", detail: "ACTION_DENIED" } } } : wrap(async () => { const oldId = payload?.old_id ?? payload?.oldId; const old = await lib.get(oldId); if (!old) throw Object.assign(new Error("superseded memory not found or not authorized"), { code: "NOT_FOUND", status: 404 }); if (payload?.visibility !== undefined && old.frontmatter?.visibility && String(payload.visibility) !== String(old.frontmatter.visibility)) throw Object.assign(new Error("SUPERSEDE_SCOPE_DENIED"), { code: "WRITE_SCOPE_DENIED", status: 403 }); supersedeGate(old, payload); return writer.supersede(authenticatedWrite({ ...payload, oldId, ...(old.frontmatter?.visibility ? { visibility: old.frontmatter.visibility } : {}) })); }),
      deprecate: (id, replacementId, reason) => wrap(() => lib.deprecate(id, replacementId, reason)),
    // VISIBILITY-FIX-1：学习读路径必须带**服务端解析出来的身份**（此前完全不接身份，
    // 只有动作门 `learning`；而 pilot-01/learner 与 pilot-01/pet 两个角色当下就有该动作）。
    learningPlanGet: (topic) => wrap(() => learning.getPlan(topic, principal)),
    learningPlanPut: (topic, plan) => wrap(() => learning.putPlan(topic, plan)),
    learningProgressGet: (topic) => wrap(() => learning.getProgress(topic, principal)),
    learningProgressPut: (topic, progress) => wrap(() => learning.putProgress(topic, progress)),
    learningReviewGet: (topic) => wrap(() => topic ? learning.getReview(topic, principal) : learning.listDueReviews(principal)),
    learningReviewPut: (topic, results) => wrap(() => learning.putReview(topic, results)),
    learningProfileGet: () => wrap(() => learning.getProfile(principal)),
    learningProfilePut: (profile) => wrap(() => learning.putProfile(profile)),
    petCommand: (input, mode, history) => allowPet ? wrap(() => pet.handleCommand({ input, mode, principal, search: (opts) => lib.search(opts), history })) : petDenied(),
    captureConversation: (event) => {
      if (!allowPropose && !allowPet) return { status: 403, data: { error: { code: "FORBIDDEN", message: "capture requires write authorization", detail: "ACTION_DENIED" } } };
      return wrap(() => conversationMemory.capture({ messages: event.messages, conversationId: event.conversation_id, source: event.source, eventId: event.event_id, sessionId: event.session_id, workspace: event.workspace, tags: event.tags, partial: event.partial === true, principal, scopes: lib.scopes, extract: false }).then(async (result) => ({ ok: true, ...result, refinement: await lib.refinement.statusFor(result.evidenceId, { group_id: principal.group_id === "unknown" ? null : principal.group_id, user_id: principal.user_id === "unknown" ? null : principal.user_id }) })));
    },
    captureComplete: (event) => {
      if (!allowPropose && !allowPet) return { status: 403, data: { error: { code: "FORBIDDEN", message: "capture requires write authorization", detail: "ACTION_DENIED" } } };
      return wrap(() => conversationMemory.capture({ messages: event.messages, conversationId: event.conversation_id, source: event.source, eventId: event.event_id, sessionId: event.session_id, workspace: event.workspace, tags: event.tags, partial: event.partial === true, principal, scopes: lib.scopes, extract: false }).then(async (result) => ({ ok: true, ...result, refinement: await lib.refinement.statusFor(result.evidenceId, { group_id: principal.group_id === "unknown" ? null : principal.group_id, user_id: principal.user_id === "unknown" ? null : principal.user_id }) })));
    },
    memoryIngest: (payload) => wrap(() => { if (payload?.dry_run === false) writeGate({ layer: payload?.kind === "conversation" ? "curated-shared" : "document", project: payload?.project ?? null }, "/mcp memory_ingest"); return memoryIngest.run({ ...payload, extract: payload?.extract === true && allowPropose, principal, scopes: lib.scopes, unrestricted: grantedActions.includes("admin") || ["librarian", "librarian-admin"].includes(String(principal?.role_id ?? "").toLowerCase()) }); }),
    transcriptImportStatus: () => allowSearch ? wrap(() => transcriptImporter.status()) : { status: 403, data: { error: { code: "FORBIDDEN", message: "transcript status requires the search action", detail: "ACTION_DENIED" } } },
    transcriptImportScan: (source) => {
      if (!allowPropose && !allowPet) return { status: 403, data: { error: { code: "FORBIDDEN", message: "transcript scan requires write authorization", detail: "ACTION_DENIED" } } };
      return wrap(() => transcriptImporter.scan({ source: source || "transcript-import", principal, scopes: lib.scopes, extract: false }));
    },
    petRemember: (payload) => !allowPet ? petDenied() : petRemember ? wrap(() => petRemember(payload)) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet remember unavailable" } } },
    // VISIBILITY-FIX-1：pet 草稿/persona 的**作用域由服务端绑定**（用认证身份的 role_id），
    // 不接受调用方自报 role_id ⇒ 否则任何持 pet 动作的身份都能读别的角色的草稿/persona。
    petDraftsPut: (payload) => !allowPet ? petDenied() : petRuntime ? wrap(() => petRuntime.draftsPut({ ...payload, roleId: principal.role_id })) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet runtime unavailable" } } },
    petDraftsList: (payload) => !allowPet ? petDenied() : petRuntime ? wrap(() => petRuntime.draftsList({ ...payload, roleId: principal.role_id })) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet runtime unavailable" } } },
    petDraftsClear: (payload) => !allowPet ? petDenied() : petRuntime ? wrap(() => petRuntime.draftsClear({ ...payload, roleId: principal.role_id })) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet runtime unavailable" } } },
    petPersonaGet: (payload) => !allowPet ? petDenied() : petRuntime ? wrap(() => petRuntime.personaGet({ ...payload, role_id: principal.role_id })) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet runtime unavailable" } } },
    petPersonaList: (payload) => !allowPet ? petDenied() : petRuntime ? wrap(() => petRuntime.personaList({ ...payload, roleId: principal.role_id })) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet runtime unavailable" } } },
    petPersonaPut: (payload) => !allowPet ? petDenied() : petRuntime ? wrap(() => petRuntime.personaPut({ ...payload, role_id: principal.role_id })) : { status: 501, data: { error: { code: "NOT_IMPLEMENTED", message: "pet runtime unavailable" } } },
    adminRegistry: () => wrap(() => admin.registry()),
    adminAudit: (limit, allow) => wrap(() => admin.audit(limit, allow)),


    adminRevoke: (frameworkId) => wrap(() => admin.revoke(frameworkId)),
    adminActivate: (frameworkId) => wrap(() => admin.activate(frameworkId)),
    adminMaintenancePurge: (ids, reason, dryRun = true) => wrap(() => admin.maintenancePurge(ids, reason, dryRun, principal)),
    evidenceImport: (id, content) => wrap(() => { writeGate({ layer: "document" }, "/mcp evidence_import"); return evidenceRecovery.evidenceImport(id, content); }),
    evidenceGet: (id) => wrap(() => evidenceRecovery.evidenceGet(id)),
    evidenceList: () => wrap(() => evidenceRecovery.evidenceList()),
    recoveryPlanGet: (id) => wrap(() => evidenceRecovery.recoveryPlanGet(id)),
    recoveryPlanPut: (id, content) => wrap(() => evidenceRecovery.recoveryPlanPut(id, content)),
    recoveryStatus: () => wrap(() => evidenceRecovery.recoveryStatus()),
    recoveryRestoreValidate: (path) => wrap(() => evidenceRecovery.recoveryRestoreValidate(path)),
    toolNote: (payload) => wrap(() => { writeGate({ ...payload, layer: "tool", visibility: resultingWriteTarget({ layer: "tool" })?.visibility ?? "platform" }, "/mcp memory_tool_note"); return tools.putToolNote(authenticatedWrite(payload)); }),
    toolList: (payload) => wrap(() => tools.listTools({ ...payload, principal })),
    planPut: (payload) => wrap(() => plans.writePlan(authenticatedWrite(payload))),
    planConfirm: (topic) => wrap(() => plans.confirm(topic, { principal })),
    planDone: (topic) => wrap(() => plans.markDone(topic, { principal })),
    planList: (payload) => wrap(() => plans.listPlans({ ...payload, principal })),
    projectState: (payload) => wrap(() => project.putCurrentState(authenticatedWrite(payload))),
    projectDecision: (payload) => wrap(() => project.appendDecision(authenticatedWrite(payload))),
    profileConfirm: (payload) => wrap(() => { authenticatedWrite(payload); return profile.confirm(payload.id, { evidence_refs: payload.evidence_refs, principal }); }),
    // VISIBILITY-FIX-1：身份**只能**来自宿主注入的 principal。
    // 此前 `recall.recallBrief(payload)` 会把调用方自报的 `agent_id`/`role_id` 当身份用
    // （recall.mjs:93-97 → listRoleNotes 不带 principal）⇒ 可读别人的角色记忆。
    // 现在显式覆盖成服务端解析出来的身份；调用方给的这两个字段**一律忽略**。
    recallBrief: (payload) => wrap(() => {
      const { agent_id: _ignoredAgent, role_id: _ignoredRole, ...rest } = payload ?? {};
      return recall.recallBrief({ ...rest, agent_id: principal.agent_id, role_id: principal.role_id, principal });
    }),
    roleNote: (payload) => wrap(() => roleMemory.putRoleNote({ ...authenticatedWrite(payload), agent_id: principal.agent_id, role_id: principal.role_id })),
    roleList: (payload) => wrap(() => roleMemory.listRoleNotes({ ...payload, principal })),
  }, grantedActions);
}

// ---- MCP JSON-RPC handler ------------------------------------------------------
export function createMcpHandler(core) {
  function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
  function err(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

  async function handle(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || !message.method) {
      return err(message?.id ?? null, -32600, "invalid request");
    }
    const { id, method, params } = message;
    switch (method) {
      case "initialize":
        return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "memory-lib-mcp", version: "0.2.0" } });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        const fn = DISPATCH[name];
        if (!fn) return err(id, -32602, `unknown tool: ${name}`);
        try {
          const r = await fn(core, args);
          if (r.status === 200) {
            return ok(id, { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }], isError: false });
          }
          const e = r.data?.error ?? {};
          return ok(id, { content: [{ type: "text", text: `操作失败(${r.status}): ${e.code || ""} ${e.message || ""}` }], isError: true });
        } catch (e) {
          return ok(id, { content: [{ type: "text", text: `工具执行错误: ${e.message}` }], isError: true });
        }
      }
      default:
        return err(id, -32601, `method not found: ${method}`);
    }
  }

  return { handle, tools: TOOLS };
}

// ---- stdio main ----------------------------------------------------------------
export async function loadIdentityFromEnv() {
  const token = process.env.MCP_MEMORY_TOKEN || "";
  const credRef = process.env.MCP_MEMORY_CRED_REF || "memory-lib/deepseek-harness";
  let secret = process.env.MCP_MEMORY_SECRET;
  if (!secret && process.env.MCP_MEMORY_SECRET_FILE) {
    try {
      secret = (await fs.readFile(process.env.MCP_MEMORY_SECRET_FILE, "utf8")).replace(/\r?\n$/, "");
    } catch {
      throw new Error(`cannot read MCP_MEMORY_SECRET_FILE: ${process.env.MCP_MEMORY_SECRET_FILE}`);
    }
  }
  if (!token && !secret) throw new Error("MCP_MEMORY_TOKEN or MCP_MEMORY_SECRET or MCP_MEMORY_SECRET_FILE is required");
  return {
    url: process.env.MCP_MEMORY_URL || "http://127.0.0.1:8787",
    ...(token ? { token } : { credRef, secret, agent: process.env.MCP_MEMORY_AGENT || "pilot-01", role: process.env.MCP_MEMORY_ROLE || "researcher" }),
  };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("mcp/mcp-server.mjs");
if (isMain) {
  try {
    const identity = await loadIdentityFromEnv();
    const core = createCoreClient(identity.url, identity);
    const handler = createMcpHandler(core);
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); return; }
      const response = await handler.handle(msg);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    });
  } catch (e) {
    console.error(`[memory-lib-mcp] ${e.message}`);
    process.exit(1);
  }
}