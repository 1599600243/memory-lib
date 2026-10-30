import fs from "node:fs/promises";
import crypto from "node:crypto";
import { atomicWriteFile } from "./atomic-write.mjs";

function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function pepperValue(pepper) { return String(pepper ?? process.env.MEMORY_LIB_KEY_PEPPER ?? "memory-lib-development-pepper"); }
function digest(secret, pepper) { return crypto.createHmac("sha256", pepperValue(pepper)).update(secret, "utf8").digest("hex"); }
// ATOMICWRITE-1：收敛到统一助手（含建目录 + rename 重试）。
function atomic(file, value) { return atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n"); }
async function read(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return { version: 1, groups: [], users: [], roles: [], api_keys: [] }; } }
function secret() { return `mlk_${crypto.randomBytes(32).toString("base64url")}`; }

export async function createRoleKey({ file, groupId, groupName, userId, userName, roleId, roleName, pepper } = {}) {
  if (!file || !groupId || !userId || !roleId) throw new Error("file/groupId/userId/roleId required");
  const db = await read(file);
  const group = db.groups.find((x) => x.id === groupId) ?? { id: groupId, name: groupName ?? groupId };
  const user = db.users.find((x) => x.id === userId) ?? { id: userId, group_id: groupId, name: userName ?? userId };
  if (user.group_id !== groupId) throw new Error("user group mismatch");
  const role = db.roles.find((x) => x.id === roleId) ?? { id: roleId, user_id: userId, group_id: groupId, name: roleName ?? roleId, status: "active" };
  if (role.user_id !== userId || role.group_id !== groupId) throw new Error("role ownership mismatch");
  const raw = secret(); const keyId = id("key"); const prefix = raw.slice(0, 12);
  db.groups = [...db.groups.filter((x) => x.id !== group.id), group];
  db.users = [...db.users.filter((x) => x.id !== user.id), user];
  db.roles = [...db.roles.filter((x) => x.id !== role.id), role];
  db.api_keys.push({ id: keyId, role_id: role.id, prefix, secret_hash: digest(raw, pepper), created_at: new Date().toISOString(), revoked_at: null, last_used_at: null });
  await atomic(file, db);
  return { id: keyId, role_id: role.id, prefix, secret: raw, group_id: group.id, user_id: user.id };
}

export async function authenticateRoleKey({ file, presented, pepper } = {}) {
  if (!file || typeof presented !== "string" || !presented) return null;
  const db = await read(file); const hash = digest(presented, pepper);
  const record = db.api_keys.find((x) => x.secret_hash === hash && !x.revoked_at);
  if (!record) return null;
  const role = db.roles.find((x) => x.id === record.role_id && x.status !== "revoked");
  const user = role && db.users.find((x) => x.id === role.user_id);
  const group = role && db.groups.find((x) => x.id === role.group_id);
  if (!role || !user || !group || user.group_id !== group.id) return null;
  record.last_used_at = new Date().toISOString(); await atomic(file, db);
  return {
    key_id: record.id,
    role_id: role.id,
    role_name: role.name,
    user_id: user.id,
    user_name: user.name,
    group_id: group.id,
    group_name: group.name,
    agent_id: role.id,
    created_at: record.created_at,
  };
}

export async function apiKeyRegistryView(file) {
  const db = await read(file);
  const groups = (db.groups ?? []).map((group) => ({ id: group.id, name: group.name, status: group.status ?? "active", created_at: group.created_at ?? null }));
  const users = (db.users ?? []).map((user) => ({ id: user.id, name: user.name, group_id: user.group_id ?? null, status: user.status ?? "active", created_at: user.created_at ?? null }));
  const roles = (db.roles ?? []).map((role) => ({ id: role.id, name: role.name, user_id: role.user_id ?? null, group_id: role.group_id ?? null, status: role.status ?? "active", created_at: role.created_at ?? null }));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const api_keys = (db.api_keys ?? []).map((key) => {
    const role = roleById.get(key.role_id);
    return { id: key.id, role_id: key.role_id, role_name: role?.name ?? null, user_id: role?.user_id ?? null, group_id: role?.group_id ?? null, created_at: key.created_at ?? null, revoked_at: key.revoked_at ?? null, last_used_at: key.last_used_at ?? null };
  });
  return { groups, users, roles, api_keys };
}

export async function issueRoleKey({ file, roleId, pepper } = {}) {
  if (!file || !roleId) throw new Error("file/roleId required");
  const db = await read(file);
  const role = db.roles.find((item) => item.id === roleId && item.status !== "revoked");
  if (!role || !role.user_id || !role.group_id) throw new Error("canonical role binding required");
  const user = db.users.find((item) => item.id === role.user_id && item.status !== "revoked");
  const group = db.groups.find((item) => item.id === role.group_id && item.status !== "revoked");
  if (!user || !group || user.group_id !== group.id) throw new Error("canonical role ownership invalid");
  return createRoleKey({ file, roleId: role.id, roleName: role.name, userId: user.id, userName: user.name, groupId: group.id, groupName: group.name, pepper });
}

export async function revokeRoleKey({ file, keyId } = {}) { const db = await read(file); const key = db.api_keys.find((x) => x.id === keyId); if (!key) return false; key.revoked_at = key.revoked_at ?? new Date().toISOString(); await atomic(file, db); return true; }
export async function revokeRole({ file, roleId } = {}) { const db = await read(file); const role = db.roles.find((x) => x.id === roleId); if (!role) return false; role.status = "revoked"; for (const key of db.api_keys.filter((x) => x.role_id === roleId)) key.revoked_at = key.revoked_at ?? new Date().toISOString(); await atomic(file, db); return true; }
export function keyDigest(secret, pepper) { return digest(secret, pepper); }
