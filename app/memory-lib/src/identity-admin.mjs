// memory-lib — 框架注册 + 凭证轮换（供 HTTP admin 端点与 onboard 脚本复用）。
// 把「注册新框架/agent/role」「轮换 secret」抽成可调用函数，让它们既走脚本、也走协议。
//
// F8/R9：wincred（Windows 凭据管理器）是权威凭证存储。被要求写 wincred 却写失败时
// **必须显式失败**。WinCred 写入通过 stdin 传 secret，不落临时明文文件；只有显式 file
// 权威模式才写 `<credential_ref>.secret`。写入器可注入，测试无需触碰真实凭据管理器。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { atomicWriteFile } from "./atomic-write.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WINCRED_WRITE = path.join(here, "..", "scripts", "wincred-write.ps1");

export function sanitizeRef(ref) {
  return String(ref).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function secretFileFor(secretsDir, credentialRef) {
  return path.join(secretsDir, `${sanitizeRef(credentialRef)}.secret`);
}

export class WincredWriteError extends Error {
  constructor(message, { target = null, reason = null } = {}) {
    super(message);
    this.name = "WincredWriteError";
    this.target = target;
    this.reason = reason;
  }
}

// 是否必须写 wincred：显式请求，或服务端本身就以 wincred 为权威存储
// （wincred 权威模式下轮换不写 wincred = 新 secret 在权威存储里不存在）。
export function shouldWriteWincred({ requested = false, secretStoreType = null } = {}) {
  return requested === true || secretStoreType === "wincred";
}

function newSecret() {
  return crypto.randomBytes(48).toString("base64url");
}

function describeFailure(error) {
  if (error?.code !== undefined && error?.code !== null && typeof error.code === "string") return error.code;
  if (error?.status !== undefined && error?.status !== null) return `exit ${error.status}`;
  return String(error?.message ?? "unknown");
}

async function writeSecretFile(secretsDir, credentialRef, secret) {
  await fs.mkdir(secretsDir, { recursive: true });
  const file = secretFileFor(secretsDir, credentialRef);
  await fs.writeFile(file, secret, { encoding: "utf8", mode: 0o600 });
  return file;
}

function writeWincredDefault(credentialRef, secret) {
  const target = sanitizeRef(credentialRef);
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINCRED_WRITE, "-Target", target], { input: secret, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
    return { ok: true, target };
  } catch (error) {
    return { ok: false, target, reason: describeFailure(error) };
  }
}

async function applyWincred(credentialRef, secret, writer) {
  const target = sanitizeRef(credentialRef);
  const result = (await writer(credentialRef, secret)) ?? {};
  if (result.ok === true) return true;
  const reason = result.reason ?? "unknown";
  throw new WincredWriteError(
    `wincred write failed for ${target} (${reason}); the credential is NOT stored in Windows Credential Manager`,
    { target: result.target ?? target, reason }
  );
}

// 注册新框架：生成 secret + 写权威 store + 增量更新 identity.json。
export async function createFramework({ registryPath, secretsDir, frameworkId, credentialRef, agentId, roleId, scopes, actions, wincred = false, writeFile = !wincred, wincredWriter = writeWincredDefault }) {
  if (!registryPath || (writeFile && !secretsDir)) throw new Error("registryPath required; secretsDir required for file storage");
  if (!frameworkId || !credentialRef || !agentId || !roleId) throw new Error("frameworkId/credentialRef/agentId/roleId required");
  if (!Array.isArray(scopes) || !scopes.length) throw new Error("scopes required");
  if (!Array.isArray(actions) || !actions.length) throw new Error("actions required");

  const secret = newSecret();
  let wincredOk = null;
  if (wincred) wincredOk = await applyWincred(credentialRef, secret, wincredWriter);
  const secretFile = writeFile ? await writeSecretFile(secretsDir, credentialRef, secret) : null;

  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  let framework = registry.frameworks.find((f) => f.framework_id === frameworkId);
  if (!framework) {
    framework = { framework_id: frameworkId, credential_ref: credentialRef, credential: { status: "active", revoked_at: null }, agents: [] };
    registry.frameworks.push(framework);
  } else if (framework.credential_ref && framework.credential_ref !== credentialRef) {
    throw new Error(`framework ${frameworkId} already bound to ${framework.credential_ref}`);
  }
  framework.credential_ref = credentialRef;

  let agent = framework.agents.find((a) => a.agent_id === agentId);
  if (!agent) { agent = { agent_id: agentId, roles: [] }; framework.agents.push(agent); }
  let role = agent.roles.find((r) => r.role_id === roleId);
  if (!role) { role = { role_id: roleId, scopes: [], actions: [] }; agent.roles.push(role); }
  role.scopes = scopes;
  role.actions = actions;
  // ATOMICWRITE-1：收敛到统一助手。原先用固定 `<registryPath>.tmp`：并发/重入时
  // 两次写入会共用同一个临时文件，彼此踩坏；助手每次生成唯一临时名，并自带 rename 重试。
  await atomicWriteFile(registryPath, JSON.stringify(registry, null, 2) + "\n");

  return { framework_id: frameworkId, credential_ref: credentialRef, secret, ...(secretFile ? { secret_file: secretFile } : {}), wincred: wincredOk, agent: agentId, role: roleId };
}

// 轮换凭证：生成新 secret + 写权威 store；不碰 registry（credential_ref 不变）。
export async function rotateCredential({ secretsDir, credentialRef, wincred = false, writeFile = !wincred, wincredWriter = writeWincredDefault }) {
  if (!credentialRef || (writeFile && !secretsDir)) throw new Error("credentialRef required; secretsDir required for file storage");
  const secret = newSecret();
  let wincredOk = null;
  if (wincred) wincredOk = await applyWincred(credentialRef, secret, wincredWriter);
  const secretFile = writeFile ? await writeSecretFile(secretsDir, credentialRef, secret) : null;
  return { credential_ref: credentialRef, secret, ...(secretFile ? { secret_file: secretFile } : {}), wincred: wincredOk };
}
