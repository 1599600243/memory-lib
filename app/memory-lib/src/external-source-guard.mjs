const EXTERNAL_SOURCE_RE = /^(?:napcat-|napcat:|qq-|qq:)/iu;

export function isExternalSource(source) {
  return typeof source === "string" && EXTERNAL_SOURCE_RE.test(source);
}

export function externalSourcesOf(evidenceRefs) {
  const sources = new Set();
  if (!Array.isArray(evidenceRefs)) return sources;
  for (const ref of evidenceRefs) {
    if (typeof ref !== "string" || !ref.trim() || !ref.includes(":")) continue;
    const parts = ref.split(":");
    const source = (/^(?:napcat|qq)$/iu.test(parts[0]) && parts[1] ? `${parts[0]}:${parts[1]}` : parts[0]).toLowerCase();
    if (isExternalSource(source)) sources.add(source);
  }
  return sources;
}

export function externalVisibilityDenial({ evidenceRefs, visibility } = {}) {
  if (visibility !== "shared" && visibility !== "platform") return null;
  const sources = [...externalSourcesOf(evidenceRefs)];
  if (!sources.length) return null;
  return {
    code: "EXTERNAL_SOURCE_VISIBILITY_DENIED",
    message: `external evidence sources cannot be written with visibility "${visibility}"`,
    sources,
  };
}


// 外部通道 agent（QQ/napcat 派生身份）只能在"自己的层"里写：
// 人线是 visibility=user；private/agent/role 是自留层，允许；shared/platform 会放大到组/全员可见，一律拒绝。
const EXTERNAL_AGENT_PATTERN = /^(qq|napcat)[:-]/iu;
const EXTERNAL_AGENT_ALLOWED_VISIBILITY = new Set(["user", "private", "agent", "role"]);

export function isExternalAgent(agentId) {
  return EXTERNAL_AGENT_PATTERN.test(String(agentId ?? "").trim());
}

export function externalAgentVisibilityDenial({ agentId, visibility } = {}) {
  if (!isExternalAgent(agentId)) return null;
  const target = String(visibility ?? "").trim().toLowerCase();
  if (!target || EXTERNAL_AGENT_ALLOWED_VISIBILITY.has(target)) return null;
  return {
    code: "EXTERNAL_AGENT_VISIBILITY_DENIED",
    message: `external channel agent "${agentId}" can only write its own layers (user/private/agent/role); "${target}" would widen visibility`,
  };
}
