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
    packs: (registry.packs ?? []).map((p) => ({ pack_id: p.pack_id, actions: p.actions ?? [], scopes: p.scopes ?? [] })),
    frameworks: (registry.frameworks ?? []).map((f) => ({
      framework_id: f.framework_id,
      credential_ref: f.credential_ref,
      claim_allowlist: Array.isArray(f.claim_allowlist) ? f.claim_allowlist : null,
      credential_status: f.credential?.status ?? "unknown",
      revoked_at: f.credential?.revoked_at ?? null,
      agents: (f.agents ?? []).map((a) => ({
        agent_id: a.agent_id,
        ...(a.tier ? { tier: a.tier } : {}),
        roles: (a.roles ?? []).map((r) => ({ role_id: r.role_id, scopes: r.scopes ?? [], actions: r.actions ?? [], ...(r.group_id ? { group_id: r.group_id } : {}), ...(r.user_id ? { user_id: r.user_id } : {}) })),
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

const IDENT_ACTIONS = new Set(["search", "get", "propose", "admin", "capture", "pet", "learn", "write"]);
const IDENT_LAYERS = new Set(["memory", "learning", "pet", "role", "project", "tool", "knowledge", "plan", "evidence", "curated", "shared"]);
const IDENT_VISIBILITY = new Set(["user", "shared", "platform", "agent", "private", "project", "role", "daily"]);

function claimRuleMatches(rule, agentId, roleId) {
  const [a, r] = String(rule).split("/");
  const part = (pat, val) => pat === "*" || (pat.endsWith("*") ? val.startsWith(pat.slice(0, -1)) : pat === val);
  return part(a, agentId) && part(r, roleId);
}

function diffIdentity(before, after) {
  const out = [];
  const b = Array.isArray(before.claim_allowlist) ? before.claim_allowlist : null;
  const a = Array.isArray(after.claim_allowlist) ? after.claim_allowlist : null;
  if (JSON.stringify(b) !== JSON.stringify(a)) out.push(`claim_allowlist: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
  const bMap = new Map((before.agents ?? []).map((x) => [x.agent_id, x]));
  const aMap = new Map((after.agents ?? []).map((x) => [x.agent_id, x]));
  for (const id of new Set([...bMap.keys(), ...aMap.keys()])) {
    if (JSON.stringify(bMap.get(id) ?? null) !== JSON.stringify(aMap.get(id) ?? null)) {
      out.push(`agent ${id}: ${bMap.has(id) ? "modified" : "added"}${aMap.has(id) ? "" : " (removed)"}`);
    }
  }
  return out;
}

// 身份可视化编辑：allowlist + agents/roles 的受控写入口。
// - dry_run 只返回 diff；真写前先备份 identity.json
// - 自锁保护：不能把当前操作者自己的 admin/claim 能力改没（除非显式 confirm_self_lockout）
export async function updateIdentity(registryPath, patch = {}, { actor = null, actorTier = null } = {}) {
  let reg;
  try { reg = JSON.parse(await fs.readFile(registryPath, "utf8")); } catch { return { ok: false, reason: "REGISTRY_UNREADABLE", status: 500 }; }
  const frameworkId = typeof patch.framework_id === "string" ? patch.framework_id : "";
  const fw = (reg.frameworks ?? []).find((f) => f.framework_id === frameworkId);
  if (!fw) return { ok: false, reason: "UNKNOWN_FRAMEWORK", status: 404 };
  const before = { claim_allowlist: fw.claim_allowlist ?? null, agents: fw.agents ?? [] };
  const next = { claim_allowlist: before.claim_allowlist, agents: before.agents };

  if ("claim_allowlist" in patch) {
    if (!Array.isArray(patch.claim_allowlist)) return { ok: false, reason: "CLAIM_ALLOWLIST_MUST_BE_ARRAY", status: 400 };
    const cleaned = [];
    for (const raw of patch.claim_allowlist) {
      const rule = String(raw ?? "").trim();
      if (!rule) continue;
      if (!/^[^/\s]+\/[^/\s]+$/.test(rule)) return { ok: false, reason: "INVALID_CLAIM_RULE", rule, status: 400 };
      if (!cleaned.includes(rule)) cleaned.push(rule);
    }
    next.claim_allowlist = cleaned;
  }

  if ("agents" in patch) {
    if (!Array.isArray(patch.agents)) return { ok: false, reason: "AGENTS_MUST_BE_ARRAY", status: 400 };
    const agents = [];
    for (const a of patch.agents) {
      const agentId = String(a?.agent_id ?? "").trim();
      if (!agentId) return { ok: false, reason: "AGENT_ID_REQUIRED", status: 400 };
      if (agents.some((x) => x.agent_id === agentId)) return { ok: false, reason: "DUPLICATE_AGENT", agent_id: agentId, status: 400 };
      const roles = [];
      for (const r of a.roles ?? []) {
        const roleId = String(r?.role_id ?? "").trim();
        if (!roleId) return { ok: false, reason: "ROLE_ID_REQUIRED", agent_id: agentId, status: 400 };
        const actions = Array.isArray(r.actions) ? [...new Set(r.actions.map(String))] : [];
        for (const act of actions) if (!IDENT_ACTIONS.has(act)) return { ok: false, reason: "INVALID_ACTION", action: act, status: 400 };
        const scopes = Array.isArray(r.scopes) ? r.scopes.map((s) => ({ layer: String(s?.layer ?? ""), visibility: String(s?.visibility ?? "") })) : [];
        for (const s of scopes) {
          if (!IDENT_LAYERS.has(s.layer)) return { ok: false, reason: "INVALID_LAYER", layer: s.layer, status: 400 };
          if (!IDENT_VISIBILITY.has(s.visibility)) return { ok: false, reason: "INVALID_VISIBILITY", visibility: s.visibility, status: 400 };
        }
        const role = { role_id: roleId, scopes, actions };
        const old = (before.agents.find((x) => x.agent_id === agentId)?.roles ?? []).find((x) => x.role_id === roleId);
        if (old) for (const [k, v] of Object.entries(old)) if (!(k in role)) role[k] = v;
        if (r.group_id !== undefined && r.group_id !== null) role.group_id = String(r.group_id);
        if (r.user_id !== undefined && r.user_id !== null) role.user_id = String(r.user_id);
        roles.push(role);
      }
      if (!roles.length) return { ok: false, reason: "AGENT_NEEDS_ROLE", agent_id: agentId, status: 400 };
      agents.push({ ...before.agents.find((x) => x.agent_id === agentId), agent_id: agentId, roles });
    }
    next.agents = agents;
  }

  const selfBefore = (before.agents.find((a) => a.agent_id === actor?.agent_id)?.roles ?? []).find((r) => r.role_id === actor?.role_id);
  const actorIsAdmin = Array.isArray(selfBefore?.actions) && selfBefore.actions.includes("admin");
  if (actorIsAdmin && actor && String(actor.framework_id ?? "") === frameworkId) {
    const self = next.agents.find((a) => a.agent_id === actor.agent_id)?.roles.find((r) => r.role_id === actor.role_id);
    const stillAdmin = self && Array.isArray(self.actions) && self.actions.includes("admin");
    const rules = next.claim_allowlist;
    const allowed = !Array.isArray(rules) || rules.length === 0 || rules.some((rule) => claimRuleMatches(rule, actor.agent_id, actor.role_id));
    if ((!stillAdmin || !allowed) && patch.confirm_self_lockout !== true) {
      return { ok: false, reason: "SELF_LOCKOUT", message: "这次保存会让当前登录身份失去 admin/claim 能力；确认请带 confirm_self_lockout=true", status: 409 };
    }
  }

  const adminRoles = (agents) => {
    const out = [];
    for (const a of agents ?? []) for (const r of a.roles ?? []) if (Array.isArray(r.actions) && r.actions.includes("admin")) out.push(a.agent_id + "/" + r.role_id);
    return out.sort();
  };
  if (actor && patch.framework_id && actor.framework_id && String(patch.framework_id) !== String(actor.framework_id) && actorTier !== "superadmin") {
    return { ok: false, reason: "FRAMEWORK_SCOPE", message: "只能管理自己框架内的主体", status: 403 };
  }
  const tierChanged =
    JSON.stringify((before.agents ?? []).map((a) => a.tier ?? null)) !== JSON.stringify((next.agents ?? []).map((a) => a.tier ?? null));
  const packsChanged = JSON.stringify(reg.packs ?? null) !== JSON.stringify(next.packs ?? reg.packs ?? null);
  const coreChange =
    packsChanged ||
    JSON.stringify(before.claim_allowlist ?? null) !== JSON.stringify(next.claim_allowlist ?? null) ||
    JSON.stringify(adminRoles(before.agents)) !== JSON.stringify(adminRoles(next.agents)) ||
    JSON.stringify((before.agents ?? []).filter((a) => adminRoles([a]).length).map((a) => a.agent_id).sort()) !==
      JSON.stringify((next.agents ?? []).filter((a) => adminRoles([a]).length).map((a) => a.agent_id).sort()) ||
    tierChanged;

  // packs 是唯一权威：授予里只允许写 role_id / user_id / group_id，
  // actions/scopes 一律从 packs 回填（防止调用方绕过定义改权限）。
  if (Array.isArray(reg.packs) && reg.packs.length) {
    const byPack = new Map(reg.packs.map((p) => [p.pack_id, p]));
    for (const agent of next.agents) {
      for (const role of agent.roles ?? []) {
        const pack = byPack.get(role.role_id);
        if (!pack) return { ok: false, reason: "UNKNOWN_PACK", pack_id: role.role_id, status: 400 };
        role.actions = pack.actions;
        role.scopes = pack.scopes;
      }
    }
  }
  if ("packs" in patch) {
    if (!Array.isArray(patch.packs)) return { ok: false, reason: "PACKS_MUST_BE_ARRAY", status: 400 };
    const seen = new Set();
    const packsNext = [];
    for (const p of patch.packs) {
      const id = String(p?.pack_id ?? "").trim();
      if (!id) return { ok: false, reason: "PACK_ID_REQUIRED", status: 400 };
      if (seen.has(id)) return { ok: false, reason: "DUPLICATE_PACK", pack_id: id, status: 400 };
      seen.add(id);
      const actions = Array.isArray(p.actions) ? [...new Set(p.actions.map(String))] : [];
      for (const act of actions) if (!IDENT_ACTIONS.has(act)) return { ok: false, reason: "INVALID_ACTION", action: act, status: 400 };
      const scopes = Array.isArray(p.scopes) ? p.scopes.map((s) => ({ ...s, layer: String(s?.layer ?? ""), visibility: String(s?.visibility ?? "") })) : [];
      for (const s of scopes) {
        if (!IDENT_LAYERS.has(s.layer)) return { ok: false, reason: "INVALID_LAYER", layer: s.layer, status: 400 };
        if (!IDENT_VISIBILITY.has(s.visibility)) return { ok: false, reason: "INVALID_VISIBILITY", visibility: s.visibility, status: 400 };
      }
      packsNext.push({ pack_id: id, actions, scopes });
    }
    next.packs = packsNext;
  }
  const diff = diffIdentity(before, next);
  if (diff.length === 0) return { ok: true, dry_run: true, changed: 0, diff };

  if (coreChange) {
    if (actorTier !== "superadmin") {
      return { ok: false, reason: "CORE_PROTECTED", message: "核心资源（声明白名单 / 管理员权限包）只有超级管理员能改", status: 403 };
    }
    if (patch.dry_run !== true && patch.confirm_core !== true) {
      return { ok: false, reason: "CORE_CONFIRM_REQUIRED", message: "这是核心变更，确认请带 confirm_core=true", status: 409, diff };
    }
  }

  if (patch.dry_run === true) return { ok: true, dry_run: true, changed: diff.length, diff };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${registryPath}.bak-identity-ui-${stamp}`;
  await fs.copyFile(registryPath, backup);
  if (next.packs) reg.packs = next.packs;
  fw.claim_allowlist = next.claim_allowlist;
  fw.agents = next.agents;
  await atomicWriteFile(registryPath, JSON.stringify(reg, null, 2) + "\n");
  return { ok: true, dry_run: false, changed: diff.length, diff, backup };
}

import path from "node:path";

const MEM_COUNT_CACHE = { at: 0, root: null, value: null };

// 按 user_id 统计 curated 记忆数（60s 缓存）。身份页用 ref_count 判断
// 「这个身份名下到底有没有东西」，0 引用才允许 retire / 回收。
export async function memoryCountsByUser(root) {
  if (MEM_COUNT_CACHE.value && MEM_COUNT_CACHE.root === root && Date.now() - MEM_COUNT_CACHE.at < 60_000) {
    return MEM_COUNT_CACHE.value;
  }
  const counts = {};
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith(".md")) continue;
      let text;
      try { text = await fs.readFile(full, "utf8"); } catch { continue; }
      const m = /^user_id:\s*"?([^"\r\n]+)"?/mu.exec(text);
      if (!m) continue;
      const uid = m[1].trim();
      if (!uid) continue;
      counts[uid] = (counts[uid] || 0) + 1;
      total += 1;
    }
  };
  for (const sub of ["shared", "agents", "project", "project-pilot", "templates"]) {
    await walk(path.join(root, "curated", sub));
  }
  const value = { counts, total, scanned_at: new Date().toISOString() };
  MEM_COUNT_CACHE.at = Date.now();
  MEM_COUNT_CACHE.root = root;
  MEM_COUNT_CACHE.value = value;
  return value;
}

// 访客 TTL：tier=guest 且 expires_at 已过期时，
// 名下 0 引用 → 从注册表移除；有引用 → 转成 session 保留（不删记忆）。
export async function gcExpiredGuests(registryPath, { counts = {}, now = Date.now() } = {}) {
  let reg;
  try { reg = JSON.parse(await fs.readFile(registryPath, "utf8")); } catch { return { ok: false, reason: "REGISTRY_UNREADABLE" }; }
  const removed = [];
  const kept = [];
  for (const fw of reg.frameworks ?? []) {
    const keep = [];
    for (const a of fw.agents ?? []) {
      const expired = a.tier === "guest" && a.expires_at && Date.parse(a.expires_at) < now;
      if (!expired) { keep.push(a); continue; }
      const uid = a.roles?.[0]?.user_id ?? "";
      const refs = counts[uid] ?? 0;
      if (refs === 0) { removed.push(a.agent_id); continue; }
      delete a.expires_at;
      a.tier = "session";
      kept.push(a.agent_id);
      keep.push(a);
    }
    fw.agents = keep;
  }
  if (!removed.length && !kept.length) return { ok: true, removed: [], kept: [], changed: 0 };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${registryPath}.bak-guest-gc-${stamp}`;
  await fs.copyFile(registryPath, backup);
  await atomicWriteFile(registryPath, JSON.stringify(reg, null, 2) + "\n");
  return { ok: true, removed, kept, changed: removed.length + kept.length, backup };
}
