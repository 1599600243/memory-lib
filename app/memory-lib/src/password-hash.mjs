// memory-lib F11 — account password hashing and secret-store adapter.
// Password hashes are account credentials, not identity-registry facts: the registry
// only maps a username to an explicit framework/agent/role triple. The adapter keeps
// the hash record in the configured secret store and never returns plaintext.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSecret, sanitizeRef } from "./credential-resolver.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const DEFAULT_PASSWORD_POLICY = Object.freeze({
  algo: "scrypt",
  N: 2 ** 15,
  r: 8,
  p: 1,
  keylen: 32,
  saltBytes: 32,
  minLength: 8,
});

const DUMMY_RECORD = Object.freeze({
  algo: DEFAULT_PASSWORD_POLICY.algo,
  N: DEFAULT_PASSWORD_POLICY.N,
  r: DEFAULT_PASSWORD_POLICY.r,
  p: DEFAULT_PASSWORD_POLICY.p,
  keylen: DEFAULT_PASSWORD_POLICY.keylen,
  salt_b64: Buffer.alloc(DEFAULT_PASSWORD_POLICY.saltBytes, 0x5a).toString("base64"),
  hash_b64: Buffer.alloc(DEFAULT_PASSWORD_POLICY.keylen, 0).toString("base64"),
});
const here = path.dirname(fileURLToPath(import.meta.url));
const WINCRED_WRITE_SCRIPT = path.join(here, "..", "scripts", "wincred-write.ps1");
const WINCRED_DELETE_SCRIPT = path.join(here, "..", "scripts", "wincred-delete.ps1");

export function normalizeUsername(username) {
  if (typeof username !== "string") return "";
  return username.trim().toLowerCase();
}

export function accountPasswordRef(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return "accounts/invalid";
  return `accounts/${normalized}`;
}

export function accountFingerprint(username) {
  return `acct_${crypto.createHash("sha256").update(normalizeUsername(username), "utf8").digest("hex").slice(0, 16)}`;
}

function scryptAsync(password, salt, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, options.keylen, {
      N: options.N,
      r: options.r,
      p: options.p,
      maxmem: Math.max(64 * 1024 * 1024, 128 * options.N * options.r + 1024),
    }, (error, derived) => error ? reject(error) : resolve(derived));
  });
}

function policyForRecord(record) {
  if (!record || typeof record !== "object" || record.algo !== DEFAULT_PASSWORD_POLICY.algo) return null;
  const values = ["N", "r", "p", "keylen"];
  if (values.some((key) => !Number.isInteger(record[key]) || record[key] <= 0)) return null;
  if (record.N !== DEFAULT_PASSWORD_POLICY.N || record.r !== DEFAULT_PASSWORD_POLICY.r || record.p !== DEFAULT_PASSWORD_POLICY.p || record.keylen !== DEFAULT_PASSWORD_POLICY.keylen) return null;
  const salt = Buffer.from(String(record.salt_b64 ?? ""), "base64");
  const expected = Buffer.from(String(record.hash_b64 ?? ""), "base64");
  if (salt.length !== DEFAULT_PASSWORD_POLICY.saltBytes || expected.length !== DEFAULT_PASSWORD_POLICY.keylen) return null;
  return { policy: { ...DEFAULT_PASSWORD_POLICY, saltBytes: salt.length }, salt, expected };
}

export async function hashPassword(password, overrides = {}) {
  if (typeof password !== "string") throw new Error("password must be a string");
  const policy = { ...DEFAULT_PASSWORD_POLICY, ...overrides };
  if (password.length < policy.minLength) throw new Error(`password must be at least ${policy.minLength} characters`);
  const salt = crypto.randomBytes(policy.saltBytes);
  const derived = await scryptAsync(password, salt, policy);
  return {
    algo: policy.algo,
    N: policy.N,
    r: policy.r,
    p: policy.p,
    keylen: policy.keylen,
    salt_b64: salt.toString("base64"),
    hash_b64: derived.toString("base64"),
  };
}

// Verification deliberately runs scrypt even when the account record is absent or
// malformed. Callers can therefore use one failure response without making unknown
// usernames cheaply distinguishable by timing.
export async function verifyPassword(record, password) {
  const validRecord = policyForRecord(record);
  const parsed = validRecord ?? policyForRecord(DUMMY_RECORD);
  const candidate = await scryptAsync(typeof password === "string" ? password : "", parsed.salt, parsed.policy);
  const matches = candidate.length === parsed.expected.length && crypto.timingSafeEqual(candidate, parsed.expected);
  return Boolean(validRecord && matches);
}

function safeAccountFileName(username) {
  return normalizeUsername(username).replace(/[^a-z0-9._-]/g, "_") || "invalid";
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonFile(file, value) {
  // ATOMICWRITE-1：收敛到统一助手；mode 0o600 由助手透传给临时文件。
  // 原实现在 finally 里删临时文件：助手在**失败**时做同样的清理，
  // 而成功后临时文件已被 rename 掉（再删也是 no-op）⇒ 语义等价。
  await atomicWriteFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function execWincred(target, secret) {
  return new Promise((resolve, reject) => {
    const child = execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINCRED_WRITE_SCRIPT, "-Target", target], { windowsHide: true, timeout: 15000 }, (error) => {
      if (error) reject(new Error(`wincred account password write failed (${error.code ?? error.status ?? "unknown"})`));
      else resolve({ ok: true, target });
    });
    child.stdin.end(secret);
  });
}

function deleteWincred(target) {
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINCRED_DELETE_SCRIPT, "-Target", target], { windowsHide: true, timeout: 15000 }, (error) => {
      if (error) reject(new Error(`wincred account password delete failed (${error.code ?? error.status ?? "unknown"})`));
      else resolve(true);
    });
  });
}

function wincredTarget(secretStore, ref) {
  return typeof secretStore?.targetFor === "function" ? secretStore.targetFor(ref) : sanitizeRef(ref);
}

async function writeWincredSecret(secretStore, ref, value, writer) {
  const target = wincredTarget(secretStore, ref);
  const result = writer ? await writer(target, value, ref) : await execWincred(target, value);
  if (result?.ok === false) throw new Error(`wincred account password write failed (${result.reason ?? "unknown"})`);
  return result ?? { ok: true, target };
}

export function createAccountPasswordStore({ secretStore, wincredWriter = null, wincredDeleter = null } = {}) {
  if (!secretStore) throw new Error("secretStore is required");
  function fileFor(username) {
    if (secretStore.type !== "file") return null;
    return path.join(secretStore.dir, "accounts", `${safeAccountFileName(username)}.scrypt`);
  }
  return {
    async read(username) {
      const normalized = normalizeUsername(username);
      if (!normalized) return null;
      if (secretStore.type === "file") return readJsonFile(fileFor(normalized));
      if (secretStore.type === "wincred") {
        // Account password records are account credentials, not request credentials: they
        // must be re-read on every verify so an out-of-process password reset takes effect
        // immediately. Never cache them (the wincred cache is for request credentials only).
        const raw = await readSecret(secretStore, accountPasswordRef(normalized), { cache: false });
        if (raw === null) return null;
        try { return JSON.parse(raw); } catch { return null; }
      }
      throw new Error(`unsupported secret store type: ${secretStore.type}`);
    },
    async write(username, record) {
      const normalized = normalizeUsername(username);
      if (!normalized) throw new Error("username is required");
      const encoded = `${JSON.stringify(record)}\n`;
      if (secretStore.type === "file") {
        await writeJsonFile(fileFor(normalized), record);
        return { username: normalized, ref: accountPasswordRef(normalized) };
      }
      if (secretStore.type === "wincred") {
        await writeWincredSecret(secretStore, accountPasswordRef(normalized), encoded, wincredWriter);
        return { username: normalized, ref: accountPasswordRef(normalized) };
      }
      throw new Error(`unsupported secret store type: ${secretStore.type}`);
    },
    async remove(username) {
      const normalized = normalizeUsername(username);
      if (!normalized) throw new Error("username is required");
      if (secretStore.type === "file") {
        await fs.rm(fileFor(normalized), { force: true });
        return true;
      }
      if (secretStore.type === "wincred") {
        const ref = accountPasswordRef(normalized);
        const target = wincredTarget(secretStore, ref);
        if (wincredDeleter) await wincredDeleter(target, ref);
        else await deleteWincred(target);
        return true;
      }
      throw new Error(`unsupported secret store type: ${secretStore.type}`);
    },
  };
}
