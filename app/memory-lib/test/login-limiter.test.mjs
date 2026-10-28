import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginLimiter } from "../src/login-limiter.mjs";

test("login limiter locks one account without imposing a peer-wide lock", () => {
  let now = 1000;
  const limiter = createLoginLimiter({ maxFailures: 3, windowMs: 100, lockoutMs: 50, clock: () => now });
  assert.equal(limiter.status("User@example", "127.0.0.1").allowed, true);
  limiter.failure("User@example", "127.0.0.1");
  limiter.failure("User@example", "127.0.0.1");
  const locked = limiter.failure("User@example", "127.0.0.1");
  assert.equal(locked.locked, true);
  assert.equal(limiter.status("user@example", "127.0.0.1").allowed, false);
  assert.equal(limiter.status("admin@example", "127.0.0.1").allowed, true);
  assert.equal(limiter.size(), 2, "peer failures remain observable without becoming a global lock");
  now += 51;
  assert.equal(limiter.status("user@example", "127.0.0.1").allowed, true);
});

test("successful login clears the failure window", () => {
  let now = 1000;
  const limiter = createLoginLimiter({ maxFailures: 3, clock: () => now });
  limiter.failure("user@example", "::1");
  limiter.success("user@example", "::1");
  assert.equal(limiter.status("user@example", "::1").allowed, true);
  assert.equal(limiter.size(), 0);
});
