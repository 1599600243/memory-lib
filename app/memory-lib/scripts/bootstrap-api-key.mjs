#!/usr/bin/env node
// Bootstrap one role across identity.json and api-keys.json, then issue its first key.
import fs from "node:fs/promises";
import { createRoleKey } from "../src/api-key-registry.mjs";
import { atomicWriteFile } from "../src/atomic-write.mjs";

function value(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; }
function required(args, name) { const result = value(args, name); if (!result) throw new Error(`${name} is required`); return result; }
function list(args, name, fallback) { const result = value(args, name); return result ? result.split(",").map((item) => item.trim()).filter(Boolean) : fallback; }
function output(args, payload) { const target = value(args, "--output-file"); return target ? fs.writeFile(target, `${JSON.stringify(payload)}\n`, "utf8") : process.stdout.write(`${JSON.stringify(payload)}\n`); }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }

const args = process.argv.slice(2);
let registryWritten = false;
try {
  const registryPath = required(args, "--registry");
  const apiKeysPath = required(args, "--api-keys");
  const frameworkId = required(args, "--framework");
  const credentialRef = required(args, "--credential-ref");
  const agentId = required(args, "--agent");
  const roleId = required(args, "--role");
  const groupId = required(args, "--group");
  const groupName = required(args, "--group-name");
  const userId = required(args, "--user");
  const userName = required(args, "--user-name");
  const roleName = required(args, "--role-name");
  const pepper = required(args, "--pepper");
  const actions = list(args, "--actions", ["search", "get", "propose"]);
  const scopes = [{ layer: "memory", visibility: "agent", project: roleId }, { layer: "memory", visibility: "user", project: userId }, { layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "platform" }];
  const dryRun = args.includes("--dry-run");
  const registry = await readJson(registryPath, { version: 1, frameworks: [], accounts: [] });
  const framework = (registry.frameworks ?? []).find((item) => item.framework_id === frameworkId);
  if (!framework || framework.credential_ref !== credentialRef || framework.credential?.status === "revoked") throw new Error("active framework/credential binding required");
  const existingAgent = (framework.agents ?? []).find((item) => item.agent_id === agentId);
  const existingRole = existingAgent?.roles?.find((item) => item.role_id === roleId);
  if (existingRole && (JSON.stringify(existingRole.actions ?? []) !== JSON.stringify(actions) || JSON.stringify(existingRole.scopes ?? []) !== JSON.stringify(scopes))) throw new Error("existing registry role conflicts with bootstrap request");
  const db = await readJson(apiKeysPath, { version: 1, groups: [], users: [], roles: [], api_keys: [] });
  const existingGroup = db.groups.find((item) => item.id === groupId);
  const existingUser = db.users.find((item) => item.id === userId);
  const existingBinding = db.roles.find((item) => item.id === roleId);
  if (existingGroup && existingGroup.name !== groupName) throw new Error("existing group conflicts with bootstrap request");
  if (existingUser && (existingUser.name !== userName || existingUser.group_id !== groupId)) throw new Error("existing user conflicts with bootstrap request");
  if (existingBinding && (existingBinding.user_id !== userId || existingBinding.group_id !== groupId || existingBinding.name !== roleName)) throw new Error("existing key role conflicts with bootstrap request");
  const plan = { framework_id: frameworkId, credential_ref: credentialRef, agent_id: agentId, role_id: roleId, group: { id: groupId, name: groupName }, user: { id: userId, name: userName, group_id: groupId }, role: { id: roleId, name: roleName, actions, scopes }, api_keys_path: apiKeysPath };
  if (dryRun) { await output(args, { dry_run: true, plan }); process.exit(0); }
  const nextRegistry = JSON.parse(JSON.stringify(registry));
  const targetFramework = nextRegistry.frameworks.find((item) => item.framework_id === frameworkId);
  targetFramework.agents ??= [];
  const targetAgent = targetFramework.agents.find((item) => item.agent_id === agentId) ?? { agent_id: agentId, roles: [] };
  if (!targetFramework.agents.includes(targetAgent)) targetFramework.agents.push(targetAgent);
  targetAgent.roles ??= [];
  if (!targetAgent.roles.some((item) => item.role_id === roleId)) targetAgent.roles.push({ role_id: roleId, scopes, actions });
  // ATOMICWRITE-1：原先这里调本地 `atomicJson()`，而该函数的**定义**在同一次收敛里被删掉了
  // ⇒ 真实路径 ReferenceError、CLI 退出码 2（只有 `--dry-run` 那条路走得通，所以测试没抓到）。
  // 现在直接调统一助手：它自带建目录与 rename 重试。
  await atomicWriteFile(registryPath, JSON.stringify(nextRegistry, null, 2) + "\n");
  registryWritten = true;
  let key;
  try {
    key = await createRoleKey({ file: apiKeysPath, groupId, groupName, userId, userName, roleId, roleName, pepper });
  } catch (error) {
    if (registryWritten) throw new Error(`单侧已写入，请重跑（重跑是幂等的）：${error.message}`);
    throw error;
  }
  const persisted = await readJson(apiKeysPath, { groups: [], users: [], roles: [], api_keys: [] });
  const persistedGroup = persisted.groups.find((item) => item.id === groupId);
  const persistedUser = persisted.users.find((item) => item.id === userId);
  const persistedRole = persisted.roles.find((item) => item.id === roleId);
  const persistedKey = persisted.api_keys.find((item) => item.id === key.id);
  if (!persistedGroup || !persistedUser || !persistedRole || !persistedKey || persistedUser.group_id !== persistedGroup.id || persistedRole.user_id !== persistedUser.id || persistedRole.group_id !== persistedGroup.id) throw new Error("bootstrap verification failed: both canonical bindings are not persisted");
  await output(args, { ok: true, bootstrap: { ...plan, group: persistedGroup, user: persistedUser, role: { ...persistedRole, actions, scopes } }, key });
} catch (error) { process.stderr.write(`bootstrap-api-key: ${error.message}\n`); process.exitCode = 2; }
