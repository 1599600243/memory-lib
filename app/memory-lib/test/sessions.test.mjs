import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionStore, DEFAULT_SESSION_ABSOLUTE_TTL_MS } from "../src/sessions.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-f11-session-"));
const file = path.join(tmp, "runtime", "sessions.json");
let now = 1_000;
const store = createSessionStore({ file, ttlMs: 100, absoluteTtlMs: 250, renewalPersistThresholdMs: 0, clock: () => now });

test("session store issues hash-only bearer sessions and slides TTL", async () => {
  const created = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "user@example", principal: { agent_id: "a", role_id: "reader" } });
  assert.match(created.token, /^[A-Za-z0-9_-]{32,}$/u);
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes(created.token), false);
  assert.match(raw, /tokenHash/);
  assert.equal(JSON.parse(raw).sessions[0].accountUsername, "user@example");
  now = 1_050;
  const resolved = await store.resolve(created.token);
  assert.equal(resolved.principal.role_id, "reader");
  assert.equal(resolved.expiresAt, 1_150);
  assert.equal(resolved.absoluteExpiresAt, 1_250);
});

test("absolute session cap prevents infinite sliding renewal", async () => {
  now = 1_000;
  const created = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "cap@example", principal: { agent_id: "a", role_id: "reader" } });
  now = 1_090;
  assert.ok(await store.resolve(created.token));
  now = 1_180;
  const resolved = await store.resolve(created.token);
  assert.equal(resolved.expiresAt, 1_250);
  now = 1_251;
  assert.equal(await store.resolve(created.token), null);
});

test("whoami-style describe does not renew or write the session file", async () => {
  const created = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "describe@example", principal: { agent_id: "a", role_id: "reader" } });
  const before = await fs.readFile(file, "utf8");
  now = 1_210;
  const described = await store.describe(created.token);
  assert.equal(described.accountUsername, "describe@example");
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("expired and revoked sessions fail closed", async () => {
  const created = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "expire@example", principal: { agent_id: "a", role_id: "reader" } });
  now = 1_351;
  assert.equal(await store.resolve(created.token), null);
  const another = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "revoke@example", principal: { agent_id: "a", role_id: "reader" } });
  assert.equal(await store.revoke(another.token), true);
  assert.equal(await store.resolve(another.token), null);
});

test("revoking all sessions for an account leaves other accounts alone", async () => {
  const first = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "same@example", principal: { agent_id: "a", role_id: "reader" } });
  const second = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "same@example", principal: { agent_id: "a", role_id: "reader" } });
  const other = await store.create({ frameworkId: "fw", credentialRef: "credential", accountUsername: "other@example", principal: { agent_id: "a", role_id: "reader" } });
  assert.equal(await store.revokeAllForAccount("same@example"), 2);
  assert.equal(await store.resolve(first.token), null);
  assert.equal(await store.resolve(second.token), null);
  assert.ok(await store.resolve(other.token));
});

assert.ok(DEFAULT_SESSION_ABSOLUTE_TTL_MS > 0);

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
