// memory-lib — admin operations (management API v1).
// Used by the localhost server's POST /v1/admin/* routes. All ops are admin-gated
// at the route layer (role must carry the "admin" action). Credential lifecycle
// and explicitly authorized maintenance operations are the administrative surface;
// proposal/inbox/review/promotion operations are retired. Credential lifecycle mutates
// the identity registry atomically. Secrets never appear in any output.
import fs from "node:fs/promises";
import { readAuditTail } from "./audit.mjs";
import { atomicWriteFile as sharedAtomicWriteFile } from "./atomic-write.mjs";

// registry view: credential_ref + status only, NO secrets
export function registryView(registry) {
  return {
    frameworks: (registry.frameworks ?? []).map((f) => ({
      framework_id: f.framework_id,
      credential_ref: f.credential_ref,
      credential_status: f.credential?.status ?? "unknown",
      revoked_at: f.credential?.revoked_at ?? null,
      agents: (f.agents ?? []).map((a) => ({
        agent_id: a.agent_id,
        roles: (a.roles ?? []).map((r) => ({ role_id: r.role_id, scopes: r.scopes ?? [], actions: r.actions ?? [] })),
      })),
    })),
    accounts: (registry.accounts ?? []).map((account) => ({
      username: account.username,
      framework_id: account.framework_id,
      credential_ref: account.credential_ref ?? null,
      agent_id: account.agent_id,
      role_id: account.role_id,
      status: account.status ?? "active",
    })),
  };
}

export async function setCredentialStatus(registryPath, frameworkId, status) {
  let reg;
  try {
    reg = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    return { ok: false, reason: "REGISTRY_UNREADABLE" };
  }
  const f = (reg.frameworks ?? []).find((x) => x.framework_id === frameworkId);
  if (!f) return { ok: false, reason: "UNKNOWN_FRAMEWORK" };
  if (!f.credential) f.credential = {};
  f.credential.status = status;
  if (status === "active") f.credential.revoked_at = null;
  else f.credential.revoked_at = new Date().toISOString();
  await atomicWriteFile(registryPath, JSON.stringify(reg, null, 2) + "\n");
  return { ok: true, framework_id: frameworkId, status };
}

// audit query: last N lines, optional allow filter (denyReason present = denied).
// Tail scanning keeps the admin endpoint bounded even when the append-only log is large.
export async function queryAudit(auditPath, { limit = 100, allow = null, maxScanBytes, chunkBytes } = {}) {
  return readAuditTail(auditPath, { limit, allow, maxScanBytes, chunkBytes });
}

// atomic write (same dir temp + rename)
// ATOMICWRITE-1：收敛到统一助手（rename 遇 EPERM/EACCES/EBUSY 会短退避重试）。
// 保留导出名与签名，`account-admin.mjs` 等既有 import 零改动。
export async function atomicWriteFile(targetPath, content) {
  return sharedAtomicWriteFile(targetPath, content);
}
