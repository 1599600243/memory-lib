import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PASSWORD_POLICY,
  hashPassword,
  verifyPassword,
  createAccountPasswordStore,
  accountPasswordRef,
} from "../src/password-hash.mjs";
import { readSecret, sanitizeRef } from "../src/credential-resolver.mjs";

test("password hashes use scrypt policy and verify through a timing-safe result", async () => {
  const record = await hashPassword("correct horse battery staple");
  assert.equal(record.algo, "scrypt");
  assert.equal(record.N, DEFAULT_PASSWORD_POLICY.N);
  assert.equal(record.r, DEFAULT_PASSWORD_POLICY.r);
  assert.equal(record.p, DEFAULT_PASSWORD_POLICY.p);
  assert.equal(Buffer.from(record.salt_b64, "base64").length, 32);
  assert.equal(await verifyPassword(record, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(record, "wrong password"), false);
});

test("each password hash gets a fresh salt", async () => {
  const first = await hashPassword("same password");
  const second = await hashPassword("same password");
  assert.notEqual(first.salt_b64, second.salt_b64);
  assert.notEqual(first.hash_b64, second.hash_b64);
});

test("wincred account password write uses the same target as readSecret and verifies after readback", async () => {
  const credentials = new Map();
  const secretStore = {
    type: "wincred",
    targetFor: sanitizeRef,
    async readWincred(target) {
      return credentials.has(target) ? { status: "ok", secret: credentials.get(target) } : { status: "not-found" };
    },
  };
  const written = [];
  const store = createAccountPasswordStore({
    secretStore,
    wincredWriter: async (target, secret) => {
      written.push({ target, secret });
      credentials.set(target, secret);
      return { ok: true, target };
    },
  });
  const password = "wincred roundtrip password";
  const record = await hashPassword(password);
  await store.write("Admin", record);
  const expectedTarget = sanitizeRef(accountPasswordRef("admin"));
  assert.equal(written[0].target, expectedTarget);
  assert.equal(written[0].secret, `${JSON.stringify(record)}\n`);
  const raw = await readSecret(secretStore, accountPasswordRef("admin"), { cache: false });
  assert.deepEqual(JSON.parse(raw), record);
  assert.equal(await verifyPassword(await store.read("admin"), password), true);
});

test("account password store keeps hashes outside the identity registry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-password-hash-"));
  const store = createAccountPasswordStore({ secretStore: { type: "file", dir } });
  const record = await hashPassword("long enough password");
  await store.write("Admin@Example", record);
  assert.equal(accountPasswordRef("Admin@Example"), "accounts/admin@example");
  const loaded = await store.read("admin@example");
  assert.deepEqual(loaded, record);
  const files = await fs.readdir(path.join(dir, "accounts"));
  assert.equal(files.length, 1);
  assert.match(files[0], /\.scrypt$/u);
  await fs.rm(dir, { recursive: true, force: true });
});
