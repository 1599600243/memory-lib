// memory-lib — F3: server-side auto-review (automatic inbox routing policy).
//
// Why server-side: the routing decision used to live in a host-side scheduled script
// (%DSH_HOME%\memory-capture\auto-review.mjs + task Memory-Auto-Review). A host script
// makes the policy machine-local and framework-specific, which contradicts "any framework
// joins through the same protocol". The policy is therefore a server capability: ONE
// decision engine shared by every capture channel (REST, MCP, in-process) and by the pet
// path, one audit trail, no host-side judgement.
//
// Default rules are the conservative three-level policy the user approved
// (2026-09-18: 「steward 自动审日常 + 用户审重要」/「低风险可自动流转」), ported verbatim in
// spirit from that host script so server behaviour matches what was already agreed:
//   1) reject obvious process fragments / transcript metadata (no long-term value)
//   2) promote only long statements that carry a decision + a system name (low risk)
//   3) leave everything else (critical, ambiguous, sensitive) to a human reviewer
// A rule never rewrites candidate wording, and a decision never records candidate
// content: the inbox file stays the truth, the audit records only which rule fired.
//
// Decisions: approve (candidate -> reviewed, still needs a human promote) |
//            promote (reviewed + moved into curated) |
//            reject (candidate -> rejected) | leave (untouched, pending).
// Modes: actual (apply) | dry-run (decide + audit, write nothing).

export const AUTO_REVIEW_DECISIONS = Object.freeze(["approve", "promote", "reject", "leave"]);
export const AUTO_REVIEW_MODES = Object.freeze(["actual", "dry-run"]);

// Content signals are named, never logged with content, so an audit line can say which
// rule fired without copying text (which may contain credentials) into the audit log.
// The patterns are the approved host-side policy, kept byte-compatible for parity.
const CONTENT_SIGNALS = Object.freeze({
  // credential values / long digit runs — never auto-promote, never auto-reject blindly
  sensitive: /密码|password|passwd|口令|secret|token|api[_-]?key|bossA\d|bossB\d|\d{8,}/i,
  "test-marker": /marker|冒烟|测试标记|test marker/i,
  // transient state / process narration ("我已提交", "端口 8787", "下一步"…)
  noise: /已提交|已同步|已推送|未提交|工作树|本地提交|已重启|已修复|已确认|已通过|端口 |health|日志路径|节编号|测试通过|健康状态|pid|PID|哈希|SHA-256|冒烟|marker|ALPHA-\d|BETA-\d|SCOPE[A-Z0-9_]+|书签|快捷方式|浏览器|跳转|后台任务号|临时方案|手动指定|记录后台|路径为|地址为 http|已识别|统计显示|需统计|下一步|待续|进度：/i,
  // long-term conclusion vocabulary (what makes a statement worth keeping)
  decision: /结论|决策|方案|规范|要求|架构|根因|规则|选型|部署|配置|流程|策略|机制|设计|评审|调研|迁移|接口|协议|约定/i,
  // named systems: a conclusion that names one is project-relevant
  system: /GLPI|SiteTrackr|memory-lib|OpenClaw|闲鱼|frp|ZeroTier|Ollama|MCP|workspace|Desktop-pet|Docker|Nginx|MariaDB|SQLite|Qwen|DeepSeek/i,
  // tool/process meta-talk ("本次任务", "脚本", "路径为", "验收", "统计"…)
  meta: /任务|文档|报告|格式|§|验收|统计|摘要生成|交接|授权|判定|留人工|审核规则|产物|交付|脚本|路径为|按授权|本次|建议改为|需统计|覆盖率|抽查|哈希|只读校验|中间产物|生成器|finalize/i,
  // technical mechanism vocabulary: meta-talk that still describes a mechanism is kept
  mechanism: /端点|API|字段|scope|权限|角色|协议|架构|部署|配置|索引|检索|向量|embedding|数据库|SQLite|表结构|事务|锁|缓存|workspace|幂等|认证|凭证|审计|治理|生命周期|提炼|去重|重要度/i,
});

export const AUTO_REVIEW_SIGNAL_NAMES = Object.freeze(Object.keys(CONTENT_SIGNALS));

export function contentSignals(content) {
  const text = String(content ?? "");
  return AUTO_REVIEW_SIGNAL_NAMES.filter((name) => CONTENT_SIGNALS[name].test(text));
}

// Length is counted without whitespace, matching the approved host-side policy.
export function contentLength(content) {
  return String(content ?? "").replace(/\s/gu, "").length;
}

// Ordered rules; the first match wins. Every field is optional:
//   sources / tags / notTags / importance  -> source, tag and importance dimensions
//   minContentChars / maxContentChars      -> length heuristic
//   contentSignals / notContentSignals     -> content-value heuristics (named)
export const DEFAULT_AUTO_REVIEW_RULES = Object.freeze([
  Object.freeze({ id: "sensitive-leave", decision: "leave", reason: "含敏感词，留人工", contentSignals: ["sensitive"] }),
  // User decision 2026-09-18: the steward pre-reviews ORDINARY daily items; anything the
  // user marked sensitive/critical still waits for the user. Kept ahead of the content
  // heuristics so ordinary pet-remember semantics are unchanged by F3.
  Object.freeze({ id: "pet-ordinary-approve", decision: "approve", reason: "日常事项，管家初审（用户保留最终确认）", sources: ["pet-remember"], notTags: ["user-sensitive"], importance: ["ordinary", "important"] }),
  Object.freeze({ id: "test-marker-reject", decision: "reject", reason: "测试残留", contentSignals: ["test-marker"] }),
  Object.freeze({ id: "process-fragment-reject", decision: "reject", reason: "对话过程/任务元话语，无长期价值", contentSignals: ["meta"], notContentSignals: ["mechanism"] }),
  Object.freeze({ id: "noise-reject", decision: "reject", reason: "过程碎片/瞬时状态", contentSignals: ["noise"], notContentSignals: ["mechanism"] }),
  Object.freeze({ id: "critical-leave", decision: "leave", reason: "critical，留人工复核", importance: ["critical"] }),
  Object.freeze({ id: "high-value-promote", decision: "promote", reason: "长内容+决策词+系统名词+技术机制", minContentChars: 50, contentSignals: ["decision", "system", "mechanism"] }),
  Object.freeze({ id: "value-promote", decision: "promote", reason: "长内容+决策词+系统名词", minContentChars: 50, contentSignals: ["decision", "system"] }),
]);

// Rules that exist but are NOT on by default, so an operator can opt in through
// `createLocalhostServer({ autoReview: { rules: [...] } })`. `tooShort` is the host
// script's "过短 → reject" rule: it is off by default because the extraction gate (F1)
// already drops fragments before the inbox, while a SHORT statement can still be a real
// long-term memory ("用户偏好用中文回答。"). Auto-rejecting those is worse than leaving
// them: a rejected candidate is also skipped by cross-conversation dedup afterwards, so a
// genuine preference restated later would be silently dropped forever.
export const OPTIONAL_AUTO_REVIEW_RULES = Object.freeze({
  tooShort: Object.freeze({ id: "too-short-reject", decision: "reject", reason: "过短，无长期价值", maxContentChars: 24 }),
});

function matchesSource(patterns, source) {
  if (patterns === undefined) return true;
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const value = String(source ?? "");
  return patterns.some((pattern) => {
    const text = String(pattern);
    return text.endsWith("*") ? value.startsWith(text.slice(0, -1)) : value === text;
  });
}

function lowerTags(candidate) {
  return (Array.isArray(candidate?.tags) ? candidate.tags : []).map((tag) => String(tag).toLowerCase());
}

const RULE_KEYS = new Set(["id", "decision", "reason", "sources", "tags", "notTags", "importance", "minContentChars", "maxContentChars", "contentSignals", "notContentSignals"]);

function validateRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("auto-review rule must be an object");
  if (!rule.id) throw new Error("auto-review rule requires an id");
  if (!AUTO_REVIEW_DECISIONS.includes(rule.decision)) throw new Error(`auto-review rule ${rule.id}: decision must be ${AUTO_REVIEW_DECISIONS.join("|")}`);
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length) throw new Error(`auto-review rule ${rule.id}: unsupported fields ${unknown.join(", ")}`);
  for (const key of ["sources", "tags", "notTags", "importance", "contentSignals", "notContentSignals"]) {
    if (rule[key] !== undefined && (!Array.isArray(rule[key]) || rule[key].some((value) => typeof value !== "string"))) {
      throw new Error(`auto-review rule ${rule.id}: ${key} must be an array of strings`);
    }
  }
  for (const key of ["contentSignals", "notContentSignals"]) {
    if (rule[key]?.some((name) => !AUTO_REVIEW_SIGNAL_NAMES.includes(name))) {
      throw new Error(`auto-review rule ${rule.id}: unknown ${key}`);
    }
  }
  for (const key of ["minContentChars", "maxContentChars"]) {
    if (rule[key] !== undefined && (!Number.isFinite(rule[key]) || rule[key] < 0)) throw new Error(`auto-review rule ${rule.id}: ${key} must be a non-negative number`);
  }
  if (rule.minContentChars !== undefined && rule.maxContentChars !== undefined && rule.minContentChars > rule.maxContentChars) {
    throw new Error(`auto-review rule ${rule.id}: minContentChars must not exceed maxContentChars`);
  }
  return rule;
}

export function ruleMatches(rule, candidate) {
  if (!matchesSource(rule?.sources, candidate?.source)) return false;
  const tags = lowerTags(candidate);
  if (Array.isArray(rule.tags) && rule.tags.length && !rule.tags.some((tag) => tags.includes(String(tag).toLowerCase()))) return false;
  if (Array.isArray(rule.notTags) && rule.notTags.some((tag) => tags.includes(String(tag).toLowerCase()))) return false;
  if (Array.isArray(rule.importance) && rule.importance.length && !rule.importance.includes(String(candidate?.importance ?? "ordinary"))) return false;
  const length = contentLength(candidate?.content);
  if (Number.isFinite(rule.minContentChars) && length < rule.minContentChars) return false;
  if (Number.isFinite(rule.maxContentChars) && length > rule.maxContentChars) return false;
  const present = new Set(contentSignals(candidate?.content));
  if (Array.isArray(rule.contentSignals) && rule.contentSignals.some((name) => !present.has(name))) return false;
  if (Array.isArray(rule.notContentSignals) && rule.notContentSignals.some((name) => present.has(name))) return false;
  return true;
}

export function normalizeAutoReviewConfig(overrides = {}) {
  const config = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("auto-review enabled must be boolean");
  if (config.mode !== undefined && !AUTO_REVIEW_MODES.includes(config.mode)) throw new Error(`unsupported auto-review mode: ${JSON.stringify(config.mode)}`);
  if (config.fallback !== undefined && !AUTO_REVIEW_DECISIONS.includes(config.fallback)) throw new Error(`unsupported auto-review fallback: ${JSON.stringify(config.fallback)}`);
  if (config.disabledRules !== undefined && (!Array.isArray(config.disabledRules) || config.disabledRules.some((id) => typeof id !== "string"))) throw new Error("auto-review disabledRules must be an array of strings");
  if (config.rules !== undefined && !Array.isArray(config.rules)) throw new Error("auto-review rules must be an array");
  const disabled = new Set((config.disabledRules ?? []).map(String));
  const source = config.rules ?? DEFAULT_AUTO_REVIEW_RULES;
  const rules = source.map(validateRule).filter((rule) => !disabled.has(String(rule.id)));
  return {
    enabled: config.enabled !== false,
    mode: config.mode ?? "actual",
    fallback: config.fallback ?? "leave",
    rules,
  };
}

// Pure decision engine: candidate metadata (+ content) -> { decision, rule, reason }.
export function createAutoReviewPolicy(overrides = {}) {
  const config = normalizeAutoReviewConfig(overrides);
  return {
    ...config,
    decide(candidate) {
      if (!config.enabled) return { decision: "leave", rule: "policy-disabled", reason: "自动审策略已关闭" };
      for (const rule of config.rules) {
        if (ruleMatches(rule, candidate)) return { decision: rule.decision, rule: rule.id, reason: rule.reason ?? rule.id };
      }
      return { decision: config.fallback, rule: null, reason: "无规则命中，留人工" };
    },
  };
}

// Router: applies a decision to a just-proposed inbox candidate and audits it.
// `lib` is the write-capable library of the explicit proposal path, so scopes and
// authorization remain those of the authenticated caller. The candidate is durable first.
export function createAutoReview({ audit = null, config = {}, llm = null, onError = null } = {}) {
  const policy = createAutoReviewPolicy(config);
  const triage = config.llmTriage && typeof config.llmTriage === "object" ? config.llmTriage : {};
  const triageEnabled = triage.enabled === true && llm && typeof llm.chat === "function";

  function reviewNotes(verdict) {
    return `服务端自动审（${verdict.rule}）：${verdict.reason}`;
  }

  async function applyDecision({ lib, candidate, verdict }) {
    if (verdict.decision === "approve" || verdict.decision === "reject") {
      await lib.review(candidate.id, verdict.decision, reviewNotes(verdict));
      return verdict.decision;
    }
    if (verdict.decision === "promote") {
      // promote() requires a reviewed item: approve first, then move it into curated.
      await lib.review(candidate.id, "approve", reviewNotes(verdict));
      await lib.promote(candidate.id);
      return "promote";
    }
    return "leave";
  }

  async function route({ lib, candidates } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const decisions = [];
    for (const candidate of list) {
      let verdict = policy.decide(candidate);
      if (triageEnabled) {
        try {
          const raw = await llm.chat([
            { role: "system", content: "你是长期记忆分诊器，只回答 YES 或 NO。YES 表示这条内容值得未来长期记住，NO 表示只是噪音、过程、技术细节或短期状态。" },
            { role: "user", content: `候选内容：${String(candidate?.content ?? "").slice(0, 4000)}\n只回答 YES 或 NO。` },
          ], { temperature: 0 });
          const answer = String(raw ?? "").trim().toUpperCase();
          if (!/^YES(?:\\b|[：:，,。.!！?？\\s])/u.test(answer)) verdict = { decision: "reject", rule: "llm-triage-no", reason: "LLM 分诊判定不值得长期记住" };
        } catch (error) {
          if (typeof onError === "function") onError({ candidateId: candidate.id, rule: "llm-triage", error });
        }
      }
      let applied = "leave";
      let failure = null;
      if (policy.enabled && policy.mode === "actual" && verdict.decision !== "leave") {
        try {
          applied = await applyDecision({ lib, candidate, verdict });
        } catch (error) {
          applied = "failed";
          failure = "AUTO_REVIEW_APPLY_FAILED";
          if (typeof onError === "function") onError({ candidateId: candidate.id, rule: verdict.rule, decision: verdict.decision, error });
        }
      }
      if (audit && typeof audit.record === "function") {
        // Fixed whitelist (audit.mjs): decision metadata only — never candidate content.
        await audit.record({
          channel: "auto-review",
          action: "auto-review",
          scope: candidate.scope ?? null,
          resourceId: candidate.id,
          allow: failure === null,
          denyReason: failure,
          decision: verdict.decision,
          rule: verdict.rule,
          dryRun: policy.mode === "dry-run",
        });
      }
      decisions.push({ id: candidate.id, path: candidate.path ?? null, decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, applied, dryRun: policy.mode === "dry-run" });
    }
    return { enabled: policy.enabled, mode: policy.mode, decisions };
  }

  return {
    policy,
    get triageEnabled() { return triageEnabled; },
    get enabled() { return policy.enabled; },
    get mode() { return policy.mode; },
    route,
  };
}
