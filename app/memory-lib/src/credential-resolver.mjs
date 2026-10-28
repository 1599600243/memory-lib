// memory-lib — credential resolver.
//
// F8: Windows Credential Manager (wincred) is the authoritative secret store.
//   * type "wincred" -> read the Generic credential named sanitizeRef(credential_ref)
//                       (path: scripts/wincred-read.ps1, injectable via readWincred for tests)
//   * type "file"    -> explicit opt-in file store: <dir>/<sanitized-ref>.secret
//                       (still the store used by test fixtures and single-machine setups)
//   * fileFallback   -> MIGRATION ONLY: when wincred reports the credential as *not found*
//                       and a fallback dir is configured, read the file store once per
//                       credential_ref and emit a one-time notice. Never enabled implicitly.
//
// Security: secrets never appear in URLs, logs, audit, notices, or command lines.
// A wincred *backend failure* (helper missing, spawn failure, timeout) is reported,
// never silently downgraded to the file store: masking a broken backend as a valid
// file read is exactly the silent double-active state F8 removes.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const WINCRED_NOT_FOUND = "WINCRED_READ_NOT_FOUND";
const WINCRED_READ_TIMEOUT_MS = 15000;
export const DEFAULT_WINCRED_CACHE_TTL_MS = 1000;

// Once-per-credential notice bookkeeping, keyed by the store object so a process
// with one store notifies each credential_ref (and each notice kind) only once.
let noticeState = new WeakMap();
// WinCred reads are expensive on Windows because the default helper is a new
// PowerShell process. Cache only successful direct WinCred reads, per store and
// credential_ref. Missing/error results are deliberately never cached.
let secretCache = new WeakMap();

function cacheTtl(secretStore) {
  const value = secretStore?.cacheTtlMs;
  if (value === 0) return 0;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WINCRED_CACHE_TTL_MS;
}

function cacheFor(secretStore) {
  let cache = secretCache.get(secretStore);
  if (!cache) {
    cache = new Map();
    secretCache.set(secretStore, cache);
  }
  return cache;
}

export function invalidateSecretCache(secretStore, credentialRef = null) {
  if (!secretStore || typeof secretStore !== "object") return;
  const cache = secretCache.get(secretStore);
  if (!cache) return;
  if (credentialRef === null || credentialRef === undefined) cache.clear();
  else cache.delete(String(credentialRef));
}

export function sanitizeRef(ref) {
  return String(ref).replace(/[^a-zA-Z0-9._-]/g, "_");
}

// credential fingerprint for audit: stable, derived from the ref only (NOT the secret)
export function credentialFingerprint(ref) {
  return `cred_${crypto.createHash("sha256").update(String(ref)).digest("hex").slice(0, 16)}`;
}

// Non-secret version marker used to invalidate sessions after credential rotation.
// It is never the presented secret and is not an audit identity fingerprint.
export function credentialVersion(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}

export function secretFilePath(dir, credentialRef) {
  return path.join(dir, `${sanitizeRef(credentialRef)}.secret`);
}

function emitNoticeOnce(secretStore, key, message) {
  let seen = noticeState.get(secretStore);
  if (!seen) {
    seen = new Set();
    noticeState.set(secretStore, seen);
  }
  if (seen.has(key)) return false;
  seen.add(key);
  const notify = typeof secretStore.onFallbackNotice === "function" ? secretStore.onFallbackNotice : defaultNotice;
  try {
    notify(message);
  } catch {
    // A failing notice sink must never break authentication.
  }
  return true;
}

function defaultNotice(message) {
  process.stderr.write(`${message}\n`);
}

// Both notices are built from the credential_ref and a backend reason only; the
// secret (and any fragment of it) is never part of a notice.
function fileFallbackNotice(credentialRef, filePath) {
  return `[memory-lib] credential "${sanitizeRef(credentialRef)}" was resolved from the FILE fallback (migration mode): WinCred has no such credential. Move it into Windows Credential Manager and delete ${filePath}.`;
}

function wincredBackendErrorNotice(credentialRef, reason) {
  return `[memory-lib] wincred read FAILED for "${sanitizeRef(credentialRef)}" (${reason}): credential rejected, file fallback NOT used so a broken credential backend cannot be masked.`;
}

async function readFileSecret(dir, credentialRef) {
  try {
    const raw = await fs.readFile(secretFilePath(dir, credentialRef), "utf8");
    return raw.replace(/\r?\n$/, ""); // tolerate trailing newline
  } catch {
    return null; // unknown credential_ref -> no secret
  }
}

function normalizeWincredResult(result, target) {
  if (!result || typeof result !== "object") return { status: "not-found", target };
  const secret = typeof result.secret === "string" && result.secret.length ? result.secret : null;
  let status = result.status;
  if (status !== "ok" && status !== "not-found" && status !== "error") status = secret ? "ok" : "not-found";
  if (status === "ok" && !secret) status = "not-found"; // an empty read is "no credential"
  return { status, target, ...(secret && status === "ok" ? { secret } : {}), ...(result.reason ? { reason: String(result.reason) } : {}) };
}

// Read one credential from Windows Credential Manager.
// status: "ok" (secret present) | "not-found" (backend fine, no such credential) | "error" (backend failed)
export async function wincredRead(secretStore, credentialRef) {
  const target = typeof secretStore.targetFor === "function" ? secretStore.targetFor(credentialRef) : sanitizeRef(credentialRef);
  if (typeof secretStore.readWincred === "function") {
    // Test seam: assert authority / fallback / backend-failure behaviour without a real Credential Manager.
    return normalizeWincredResult(await secretStore.readWincred(target, credentialRef), target);
  }
  const helper = secretStore.readScript;
  if (!helper) throw new Error("wincred secret store requires readScript path");
  return await new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Target", target], { encoding: "utf8", windowsHide: true, timeout: WINCRED_READ_TIMEOUT_MS }, (err, stdout) => {
      const out = String(stdout ?? "").trim();
      // The helper prints WINCRED_READ_NOT_FOUND for a missing credential (and exits non-zero);
      // anything else non-zero is a backend failure, not a missing credential.
      if (out.startsWith(WINCRED_NOT_FOUND)) return resolve({ status: "not-found", target });
      if (err) return resolve({ status: "error", target, reason: err?.code !== undefined && err?.code !== null ? String(err.code) : `exit ${err?.status ?? "unknown"}` });
      resolve(out ? { status: "ok", target, secret: out } : { status: "not-found", target });
    });
  });
}

export async function readSecret(secretStore, credentialRef, { cache = true } = {}) {
  if (!secretStore) return null;
  if (secretStore.type === "wincred") {
    const key = String(credentialRef);
    const ttl = cache ? cacheTtl(secretStore) : 0;
    const cacheState = cache ? cacheFor(secretStore) : null;
    if (cacheState && ttl > 0) {
      const cached = cacheState.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.secret;
      if (cached) cacheState.delete(key);
    }
    const result = await wincredRead(secretStore, credentialRef);
    if (result.status === "ok") {
      if (cacheState && ttl > 0) cacheState.set(key, { secret: result.secret, expiresAt: Date.now() + ttl });
      return result.secret;
    }
    if (result.status === "error") {
      emitNoticeOnce(secretStore, `error:${credentialRef}`, wincredBackendErrorNotice(credentialRef, result.reason ?? "unknown"));
      return null;
    }
    const fallback = secretStore.fileFallback;
    if (!fallback || !fallback.dir) return null; // unknown credential_ref -> no secret
    const secret = await readFileSecret(fallback.dir, credentialRef);
    if (secret === null) return null;
    emitNoticeOnce(secretStore, `fallback:${credentialRef}`, fileFallbackNotice(credentialRef, secretFilePath(fallback.dir, credentialRef)));
    return secret;
  }
  if (secretStore.type !== "file") {
    throw new Error(`unsupported secret store type: ${secretStore.type}`);
  }
  return readFileSecret(secretStore.dir, credentialRef);
}

export async function authenticate(secretStore, credentialRef, presentedSecret) {
  const expected = await readSecret(secretStore, credentialRef);
  if (expected === null) return { ok: false, reason: "UNKNOWN_CREDENTIAL" };
  if (typeof presentedSecret !== "string" || presentedSecret.length === 0) return { ok: false, reason: "MISSING_SECRET" };
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presentedSecret, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true, fingerprint: credentialFingerprint(credentialRef) } : { ok: false, reason: "BAD_SECRET" };
}
