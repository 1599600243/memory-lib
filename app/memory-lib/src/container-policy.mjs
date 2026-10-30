// M1.2 container policy. File truth remains authoritative; this module centralizes
// container identity and principal visibility decisions for every repository.

export const CONTAINERS = Object.freeze([
  "temporary", "evidence", "long-term", "project", "tool", "graph", "plan", "role", "knowledge",
]);

const CONTAINER_SET = new Set(CONTAINERS);
const IDENTITY_SENTINELS = new Set(["", "unknown", "null", "n/a", "-"]);

function isIdentitySentinel(value) {
  return IDENTITY_SENTINELS.has(String(value ?? "").trim().toLowerCase());
}

function identitiesMatch(left, right) {
  return !isIdentitySentinel(left) && !isIdentitySentinel(right) && left === right;
}

const LEGACY = Object.freeze({
  "curated-shared": "long-term",
  agent: "role",
  "project-state": "project",
  "project-decision": "project",
  "project-progress": "project",
  tool: "tool",
  plan: "plan",
  profile: "long-term",
  document: "knowledge",
  evidence: "evidence",
  temporary: "temporary",
});

export function normalizeContainer(value) {
  const key = String(value ?? "").trim();
  const container = LEGACY[key] ?? key;
  return CONTAINER_SET.has(container) ? container : null;
}

export function normalizeContainerScope(scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const container = normalizeContainer(scope.container ?? scope.layer);
  if (!container) return null;
  const visibility = String(scope.visibility ?? "private").trim();
  const project = scope.project === undefined || scope.project === null || scope.project === ""
    ? null : String(scope.project).trim();
  if (!visibility || visibility.length > 80 || project === "") return null;
  if (container === "temporary") return { container, visibility: "private", project: null };
  return { container, visibility, project };
}

export function principalIdentity(principal = {}) {
  return {
    tenant_id: typeof principal?.tenant_id === "string" ? principal.tenant_id : null,
    framework_id: typeof principal?.framework_id === "string" ? principal.framework_id : null,
    group_id: typeof principal?.group_id === "string" ? principal.group_id : null,
    user_id: typeof principal?.user_id === "string" ? principal.user_id : null,
    agent_id: typeof principal?.agent_id === "string" ? principal.agent_id : null,
    role_id: typeof principal?.role_id === "string" ? principal.role_id : null,
  };
}

export function principalAllowsContainer(principal, metadata = {}) {
  const p = principalIdentity(principal);
  const scope = normalizeContainerScope(metadata);
  if (!scope || scope.container === "temporary") return false;
  const group = metadata.group_id ?? metadata.groupId ?? null;
  const user = metadata.user_id ?? metadata.userId ?? null;
  const agent = metadata.agent_id ?? metadata.agentId ?? null;
  const role = metadata.role_id ?? metadata.roleId ?? null;
  if (scope.visibility === "platform") return true;
  const groupCompatible = () => !group || !p.group_id || group === p.group_id;
  if (scope.visibility === "shared") return groupCompatible();
  if (scope.visibility === "project") return Boolean(scope.project && (scope.project === "*" || scope.project === metadata.project) && groupCompatible());
  if (scope.container === "project") return Boolean(metadata.project && groupCompatible() && (scope.project === "*" || scope.project === metadata.project));
  if (scope.visibility === "role" || scope.container === "role") return Boolean(identitiesMatch(p.role_id, role));
  if (scope.visibility === "user") return Boolean(identitiesMatch(p.user_id, user));
  if (scope.visibility === "agent" || scope.container === "long-term") return Boolean(identitiesMatch(p.agent_id, agent) || identitiesMatch(p.user_id, user) || identitiesMatch(p.role_id, role));
  if (scope.visibility === "private") return Boolean(identitiesMatch(p.user_id, user) || identitiesMatch(p.agent_id, agent) || identitiesMatch(p.role_id, role));
  return false;
}

export function pathContainer(dataRoot, filePath) {
  const rel = String(filePath).replaceAll("\\", "/").slice(String(dataRoot).replaceAll("\\", "/").length).replace(/^\/+/, "");
  if (rel.startsWith("curated/shared/")) return "long-term";
  if (rel.startsWith("curated/agents/")) return "role";
  if (rel.startsWith("project-state/")) return "project";
  if (rel.startsWith("tools-memory/")) return "tool";
  if (rel.startsWith("plans/")) return "plan";
  if (rel.startsWith("profile/")) return "long-term";
  if (rel.startsWith("evidence/documents/")) return "knowledge";
  if (rel.startsWith("evidence/conversations/")) return "evidence";
  return null;
}

export function safeTemporaryKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.length > 160 || /[\\/\0\r\n]/u.test(key)) throw new Error("temporary key is invalid");
  return key;
}
