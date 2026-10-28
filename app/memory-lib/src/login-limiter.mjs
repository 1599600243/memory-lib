// F11 login throttling: bounded in-memory state, keyed independently by account
// fingerprint and loopback peer. It is deliberately independent of HTTP and
// password storage so the failure policy has a small public seam and can be
// tested without a live server.
import { accountFingerprint, normalizeUsername } from "./password-hash.mjs";

export const DEFAULT_LOGIN_LIMITS = Object.freeze({
  maxFailures: 5,
  peerMaxFailures: null,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
});

export function createLoginLimiter(options = {}) {
  const config = { ...DEFAULT_LOGIN_LIMITS, ...options };
  const clock = typeof config.clock === "function" ? config.clock : Date.now;
  const entries = new Map();

  function dimensionsFor(username, peer) {
    const normalized = normalizeUsername(username);
    const accountKey = normalized ? `account:${accountFingerprint(normalized)}` : "account:<missing>";
    const peerKey = `peer:${String(peer || "<missing>").slice(0, 80)}`;
    return [
      { key: accountKey, limit: config.maxFailures },
      { key: peerKey, limit: config.peerMaxFailures },
    ];
  }

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.lockedUntil <= now && now - entry.windowStartedAt > config.windowMs) entries.delete(key);
    }
  }

  function status(username, peer) {
    const now = clock();
    prune(now);
    const locked = dimensionsFor(username, peer)
      .filter(({ limit }) => Number.isFinite(limit) && limit > 0)
      .map(({ key }) => entries.get(key))
      .find((entry) => entry && entry.lockedUntil > now);
    if (locked) return { allowed: false, retryAfterMs: locked.lockedUntil - now };
    return { allowed: true, retryAfterMs: 0 };
  }

  function failure(username, peer) {
    const now = clock();
    let maxRetry = 0;
    let failures = 0;
    let locked = false;
    for (const { key, limit } of dimensionsFor(username, peer)) {
      let entry = entries.get(key);
      if (!entry || now - entry.windowStartedAt >= config.windowMs) entry = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
      entry.failures += 1;
      if (Number.isFinite(limit) && limit > 0 && entry.failures >= limit) entry.lockedUntil = now + config.lockoutMs;
      entries.set(key, entry);
      failures = Math.max(failures, entry.failures);
      if (entry.lockedUntil > now) {
        locked = true;
        maxRetry = Math.max(maxRetry, entry.lockedUntil - now);
      }
    }
    return { locked, retryAfterMs: maxRetry, failures };
  }

  function success(username, peer) {
    for (const { key } of dimensionsFor(username, peer)) entries.delete(key);
  }

  return { status, failure, success, size: () => entries.size };
}
