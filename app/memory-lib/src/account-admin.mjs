import fs from "node:fs/promises";
import { atomicWriteFile } from "./admin.mjs";
import { frameworkByCredentialRef, resolveClaimedPrincipal, resolveRequestScopes } from "./identity-registry.mjs";
import { hashPassword, normalizeUsername } from "./password-hash.mjs";

async function readRegistry(registryPath) {
  return JSON.parse(await fs.readFile(registryPath, "utf8"));
}

function validateBinding(registry, { frameworkId, credentialRef, agentId, roleId }) {
  const framework = credentialRef
    ? frameworkByCredentialRef(registry, credentialRef)
    : (registry.frameworks ?? []).find((item) => item.framework_id === frameworkId);
  if (!framework || framework.framework_id !== frameworkId) throw new Error("unknown framework binding");
  const resolved = resolveClaimedPrincipal(framework, { agent_id: agentId, role_id: roleId });
  if (!resolved.ok) throw new Error(resolved.reason);
  const scopes = resolveRequestScopes(resolved.role);
  if (!scopes.ok) throw new Error(scopes.reason);
  return framework;
}

export async function createAccount({ registryPath, accountPasswordStore, username, password, frameworkId, credentialRef = null, agentId, roleId }) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error("username is required");
  const registry = await readRegistry(registryPath);
  if ((registry.accounts ?? []).some((item) => normalizeUsername(item?.username) === normalized)) throw new Error("account already exists");
  const framework = validateBinding(registry, { frameworkId, credentialRef, agentId, roleId });
  const record = await hashPassword(password);
  await accountPasswordStore.write(normalized, record);
  const account = {
    username: normalized,
    framework_id: framework.framework_id,
    credential_ref: framework.credential_ref,
    agent_id: agentId,
    role_id: roleId,
    status: "active",
  };
  try {
    registry.accounts = [...(registry.accounts ?? []), account];
    await atomicWriteFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  } catch (error) {
    await accountPasswordStore.remove(normalized).catch(() => {});
    throw error;
  }
  return account;
}

export async function resetAccountPassword({ registryPath, accountPasswordStore, username, password }) {
  const normalized = normalizeUsername(username);
  const registry = await readRegistry(registryPath);
  const account = (registry.accounts ?? []).find((item) => normalizeUsername(item?.username) === normalized);
  if (!account) throw new Error("account not found");
  await accountPasswordStore.write(normalized, await hashPassword(password));
  return { username: normalized };
}

export async function setAccountStatus({ registryPath, username, status }) {
  if (!["active", "suspended"].includes(status)) throw new Error("invalid account status");
  const normalized = normalizeUsername(username);
  const registry = await readRegistry(registryPath);
  const account = (registry.accounts ?? []).find((item) => normalizeUsername(item?.username) === normalized);
  if (!account) throw new Error("account not found");
  account.username = normalized;
  account.status = status;
  await atomicWriteFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { username: normalized, status };
}
