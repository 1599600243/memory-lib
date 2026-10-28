// memory-lib Slice 2 — identity registry loader.
// The registry (identity.json) is a JSON fact source. It NEVER contains secrets —
// only credential_ref + status. Real secrets live in a secret store (v0: a
// restricted secret file; extension point for Windows Credential Manager).
//
// Security rules implemented here:
//   - framework_id is resolved FROM the credential (credential_ref -> framework),
//     never from request fields.
//   - agent_id / role_id from requests are CLAIMS: they must exist in the registry
//     for the resolved framework, else UNKNOWN_PRINCIPAL.
//   - role must be bound to the claimed agent.
//   - revocation is immediate: status is re-read from the registry file on every call.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeUsername } from "./password-hash.mjs";

export async function loadRegistry(registryPath) {
  let raw;
  try {
    raw = await fs.readFile(registryPath, "utf8");
  } catch {
    throw new Error(`identity registry not readable: ${registryPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`identity registry invalid JSON: ${registryPath}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.frameworks)) {
    throw new Error(`identity registry schema unsupported (expected version 1 with frameworks[]): ${registryPath}`);
  }
  return parsed;
}

// credential_ref -> framework entry (the ONLY trust anchor for framework identity)
export function frameworkByCredentialRef(registry, credentialRef) {
  if (typeof credentialRef !== "string" || !credentialRef) return null;
  return registry.frameworks.find((f) => f.credential_ref === credentialRef) ?? null;
}

// Human accounts are explicit bindings. The resolver intentionally does not infer
// an agent or role from framework array order; a missing/invalid binding is not a
// usable login principal.
export function resolveAccount(registry, username) {
  const normalized = normalizeUsername(username);
  if (!normalized || !Array.isArray(registry?.accounts)) return null;
  const account = registry.accounts.find((item) => normalizeUsername(item?.username) === normalized) ?? null;
  if (!account) return null;
  return { ...account, username: normalized, status: account.status ?? "active" };
}

export function accountPrincipal(account) {
  if (!account || typeof account !== "object") return null;
  if (![account.framework_id, account.agent_id, account.role_id].every((value) => typeof value === "string" && value.length > 0)) return null;
  return { framework_id: account.framework_id, agent_id: account.agent_id, role_id: account.role_id };
}

// claim validation: agent must exist in framework; role must be bound to that agent
export function resolveClaimedPrincipal(framework, claimed) {
  if (!framework) return { ok: false, reason: "UNKNOWN_CREDENTIAL" };
  if (framework.credential?.status !== "active") return { ok: false, reason: "REVOKED" };
  const agentId = claimed?.agent_id;
  const roleId = claimed?.role_id;
  if (typeof agentId !== "string" || !agentId) return { ok: false, reason: "AGENT_REQUIRED" };
  if (typeof roleId !== "string" || !roleId) return { ok: false, reason: "ROLE_REQUIRED" };
  const agent = framework.agents?.find((a) => a.agent_id === agentId);
  if (!agent) return { ok: false, reason: "UNKNOWN_AGENT" };
  const role = agent.roles?.find((r) => r.role_id === roleId);
  if (!role) return { ok: false, reason: "UNKNOWN_ROLE" };
  return { ok: true, framework, agent, role };
}

export function authorizeAction(role, action) {
  if (!Array.isArray(role.actions) || !role.actions.includes(action)) {
    return { ok: false, reason: "ACTION_DENIED" };
  }
  return { ok: true };
}

// scope request must be a subset of the role's allowed scopes (structured).
// request scope may be omitted -> default to role's scopes (all of them).
export function resolveRequestScopes(role, requestedScopes) {
  const allowed = Array.isArray(role.scopes) ? role.scopes : [];
  if (allowed.length === 0) return { ok: false, reason: "NO_SCOPES" };
  if (requestedScopes === undefined || requestedScopes === null || (Array.isArray(requestedScopes) && requestedScopes.length === 0)) {
    return { ok: true, scopes: allowed };
  }
  if (!Array.isArray(requestedScopes)) return { ok: false, reason: "SCOPE_MALFORMED" };
  // every requested scope must be structurally present in the allowed list
  for (const req of requestedScopes) {
    // project:"*" 是通配：授权该角色访问任意项目（用于 steward 建/审任意新项目）
    const hit = allowed.some((a) =>
      a?.layer === req?.layer && a?.visibility === req?.visibility &&
      ((a?.project ?? null) === (req?.project ?? null) || a?.project === "*")
    );
    if (!hit) return { ok: false, reason: "SCOPE_DENIED" };
  }
  return { ok: true, scopes: requestedScopes };
}
