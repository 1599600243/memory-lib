// Shared deterministic redaction and text-comparison utilities retained by capture, ingest, recall,
// role memory, and compatibility code. Candidate/inbox governance was removed in D29.
export const REDACTION_MARKERS = Object.freeze({
  credential: "（含凭证，略）",
  privateKey: "（含私钥，略）",
  connection: "（含连接串，略）",
  path: "路径（已省略）",
  email: "（含邮箱，略）",
});
const TOKEN_STOP = "\\s\"'`|?*<>，。；：、！？（）【】《》,;:)\\]}";
const URI_STOP = "\\s\"'`|?*<>，。；：、！？（）【】《》,;)\\]}";
const TOKEN = `[^${TOKEN_STOP}]`;
const URI = `[^${URI_STOP}]`;
const CREDENTIAL_KEYWORDS = "api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret|token|password|passwd|passphrase|pwd|credential|密码|口令|密钥|私钥|令牌|凭证";
const REDACTION_RULES = [
  { re: /-{5}BEGIN[^-]{0,40}PRIVATE KEY-{5}[\s\S]*?-{5}END[^-]{0,40}PRIVATE KEY-{5}/g, to: () => REDACTION_MARKERS.privateKey },
  { re: new RegExp(`\\bfile:\\/\\/${URI}*`, "gi"), to: () => REDACTION_MARKERS.path },
  { re: new RegExp(`\\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|redis|amqp|mssql|sqlserver|ftp|sftp|smtp|imap|https?):\\/\\/[^\\s/@:]+:[^\\s/@]+@${URI}+`, "gi"), to: () => REDACTION_MARKERS.connection },
  { re: new RegExp(`\\b(?:Server|Data Source|Host|Address)=${TOKEN}+\\s*;[^;\\r\\n]*?(?:Password|Pwd|User Id)=${TOKEN}+`, "gi"), to: () => REDACTION_MARKERS.connection },
  { re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, to: () => REDACTION_MARKERS.credential },
  { re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g, to: () => REDACTION_MARKERS.credential },
  { re: /\b(?:AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}\b/g, to: () => REDACTION_MARKERS.credential },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, to: () => REDACTION_MARKERS.credential },
  { re: new RegExp(`[\"'](?:${CREDENTIAL_KEYWORDS})[\"']\\s*:\\s*[\"']${TOKEN}{4,}[\"']`, "gi"), to: () => REDACTION_MARKERS.credential },
  { re: new RegExp(`(?:${CREDENTIAL_KEYWORDS})\\s*[:=＝]\\s*${TOKEN}{4,}`, "gi"), to: () => REDACTION_MARKERS.credential },
  { re: new RegExp(`(?:${CREDENTIAL_KEYWORDS})\\s*(?:是|为)\\s*${TOKEN}{4,}`, "gi"), to: () => REDACTION_MARKERS.credential },
  { re: new RegExp(`(?<![A-Za-z0-9_/\\\\])[A-Za-z]:[\\\\/]${URI}*`, "g"), to: () => REDACTION_MARKERS.path },
  { re: new RegExp(`\\\\\\\\[A-Za-z0-9._-]+\\\\${URI}*`, "g"), to: () => REDACTION_MARKERS.path },
  { re: new RegExp(`(?<![\\w:/.-])/(?:Users|home|root|opt|srv|var|etc|mnt|media|tmp|usr|Applications|Library|Volumes)/${URI}*`, "g"), to: () => REDACTION_MARKERS.path },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, to: () => REDACTION_MARKERS.email },
];
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const MARKER_VALUES = Object.values(REDACTION_MARKERS);
const MARKER_SET = new Set(MARKER_VALUES);
const MARKER_SPLIT = new RegExp(`(${MARKER_VALUES.map(escapeRegExp).join("|")})`, "g");
function applyRedactionRules(text) { let out = text; for (const rule of REDACTION_RULES) out = out.replace(rule.re, rule.to); return out; }
export function redactSensitiveText(value) {
  const text = String(value ?? "");
  return text ? text.split(MARKER_SPLIT).map((part) => MARKER_SET.has(part) ? part : applyRedactionRules(part)).join("") : text;
}
export function containsSensitiveText(value) { const text = String(value ?? ""); return Boolean(text) && redactSensitiveText(text) !== text; }
export function containsCredentialSensitiveText(value) {
  const redacted = redactSensitiveText(value);
  return [REDACTION_MARKERS.credential, REDACTION_MARKERS.privateKey, REDACTION_MARKERS.connection].some((marker) => redacted.includes(marker));
}
function normalizeForCompare(value) { return String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ""); }
function bigrams(text) { const grams = new Set(); if (text.length < 2) { if (text) grams.add(text); return grams; } for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2)); return grams; }
export function candidateSimilarity(a, b) {
  const left = normalizeForCompare(a); const right = normalizeForCompare(b);
  if (!left || !right) return 0; if (left === right) return 1;
  const leftGrams = bigrams(left); const rightGrams = bigrams(right); let shared = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared += 1;
  return (2 * shared) / (leftGrams.size + rightGrams.size);
}
export const CANDIDATE_DEDUP_THRESHOLD = 0.72;
