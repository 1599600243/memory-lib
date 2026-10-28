// F11 — hash-only bearer session store.
// The file is derived runtime state: it contains no bearer token, password, or
// secret. Mutations are serialized per store instance and registry resolution is
// deliberately left to the caller so framework/role revocation stays immediate.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { normalizeUsername } from "./password-hash.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RENEWAL_PERSIST_THRESHOLD_MS = 60 * 1000;

const hash = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");
const safeSession = (session) => {
  if (!session) return null;
  const { tokenHash: _tokenHash, ...safe } = session;
  return safe;
};

async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error(`session store schema invalid: ${file}`);
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, sessions: [] };
    throw error;
  }
}

async function persist(file, sessions) {
  // ATOMICWRITE-1：收敛到统一助手；mode 0o600 由助手透传给临时文件。
  await atomicWriteFile(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
}

function validPositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function pruneExpired(sessions, now) {
  return sessions.filter((session) => {
    const idleExpiry = Number(session?.expiresAt);
    const absoluteExpiry = Number(session?.absoluteExpiresAt ?? idleExpiry);
    return Number.isFinite(idleExpiry) && Number.isFinite(absoluteExpiry) && idleExpiry > now && absoluteExpiry > now;
  });
}

export function createSessionStore({
  file,
  ttlMs = DEFAULT_SESSION_TTL_MS,
  absoluteTtlMs = DEFAULT_SESSION_ABSOLUTE_TTL_MS,
  renewalPersistThresholdMs = DEFAULT_RENEWAL_PERSIST_THRESHOLD_MS,
  clock = Date.now,
} = {}) {
  if (!file) throw new Error("session store file is required");
  const ttl = validPositiveNumber(ttlMs, "session ttlMs");
  const absoluteTtl = validPositiveNumber(absoluteTtlMs, "session absoluteTtlMs");
  if (!Number.isFinite(renewalPersistThresholdMs) || renewalPersistThresholdMs < 0) throw new Error("session renewalPersistThresholdMs must be non-negative");
  if (typeof clock !== "function") throw new Error("session clock must be a function");
  let tail = Promise.resolve();

  function enqueue(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  function expiryAt(issuedAt, absoluteExpiresAt, now) {
    return Math.min(now + ttl, absoluteExpiresAt);
  }

  return {
    async create({ frameworkId, credentialRef, credentialVersion = null, accountUsername = null, principal } = {}) {
      return enqueue(async () => {
        const issuedAt = clock();
        const token = crypto.randomBytes(32).toString("base64url");
        const absoluteExpiresAt = issuedAt + absoluteTtl;
        const state = await readState(file);
        const sessions = pruneExpired(state.sessions, issuedAt);
        const session = {
          tokenHash: hash(token),
          frameworkId,
          credentialRef,
          ...(credentialVersion ? { credentialVersion: String(credentialVersion) } : {}),
          ...(accountUsername ? { accountUsername: normalizeUsername(accountUsername) } : {}),
          principal,
          issuedAt,
          lastSeenAt: issuedAt,
          expiresAt: expiryAt(issuedAt, absoluteExpiresAt, issuedAt),
          absoluteExpiresAt,
        };
        sessions.push(session);
        await persist(file, sessions);
        return { token, issuedAt, expiresAt: session.expiresAt, absoluteExpiresAt };
      });
    },

    async resolve(token, { renew = true } = {}) {
      if (typeof token !== "string" || token.length < 32) return null;
      return enqueue(async () => {
        const now = clock();
        const state = await readState(file);
        const sessions = pruneExpired(state.sessions, now);
        const index = sessions.findIndex((session) => session?.tokenHash === hash(token));
        if (index < 0) {
          if (renew && sessions.length !== state.sessions.length) await persist(file, sessions);
          return null;
        }
        const session = sessions[index];
        if (!renew) return safeSession(session);
        const nextExpiry = expiryAt(session.issuedAt, session.absoluteExpiresAt, now);
        const moved = nextExpiry > session.expiresAt;
        const storedExpiry = Number(session.expiresAt);
        const shouldPersistRenewal = moved && (renewalPersistThresholdMs === 0 || nextExpiry - storedExpiry >= renewalPersistThresholdMs);
        if (shouldPersistRenewal) {
          session.lastSeenAt = now;
          session.expiresAt = nextExpiry;
        }
        if (sessions.length !== state.sessions.length || shouldPersistRenewal) await persist(file, sessions);
        return safeSession(session);
      });
    },

    async describe(token) {
      if (typeof token !== "string" || token.length < 32) return null;
      return enqueue(async () => {
        const now = clock();
        const state = await readState(file);
        const session = state.sessions.find((item) => item?.tokenHash === hash(token));
        if (!session) return null;
        const absoluteExpiresAt = Number(session.absoluteExpiresAt ?? session.expiresAt);
        if (Number(session.expiresAt) <= now || absoluteExpiresAt <= now) return null;
        return safeSession(session);
      });
    },

    async revoke(token) {
      return enqueue(async () => {
        const state = await readState(file);
        const before = state.sessions.length;
        const sessions = state.sessions.filter((session) => session?.tokenHash !== hash(String(token ?? "")));
        if (sessions.length !== before) await persist(file, sessions);
        return sessions.length !== before;
      });
    },

    async revokeAllForAccount(username) {
      const normalized = normalizeUsername(username);
      return enqueue(async () => {
        const state = await readState(file);
        const sessions = state.sessions.filter((session) => session?.accountUsername !== normalized);
        const revoked = state.sessions.length - sessions.length;
        if (revoked > 0) await persist(file, sessions);
        return revoked;
      });
    },
  };
}
