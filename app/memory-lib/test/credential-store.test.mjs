// memory-lib — F8 credential store tests.
//
// F8 makes Windows Credential Manager (wincred) the authoritative secret store:
//   * wincred is the standalone server default; the file store is an explicit opt-in;
//   * the file store is only read as a *migration fallback* when it is configured,
//     and doing so emits a one-time notice that never contains the secret;
//   * a wincred backend failure never silently degrades to the file store;
//   * the injectable `{ type: "file", dir }` fixture store keeps working unchanged.
//
// Run directly: node test/credential-store.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSecret, authenticate, sanitizeRef, invalidateSecretCache } from "../src/credential-resolver.mjs";
import { readFlagValue, resolveSecretStoreConfig, resolveAutoReviewConfig, SECRET_STORE_TYPES, DEFAULT_SECRET_STORE } from "../src/server-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-f8-"));
const SECRETS = path.join(TMP, "secrets");

// Distinctive, non-guessable-looking values so substring assertions are meaningful.
const FILE_REF = "memory-lib/f8-file-store";
const FILE_SECRET = "F8fileFallbackSecret000111222333444555666777";
const FILE_REF_2 = "memory-lib/f8-file-store-2";
const FILE_SECRET_2 = "F8secondFallbackSecret999888777666555444333222";
const WINCRED_REF = "memory-lib/f8-wincred-store";
const WINCRED_SECRET = "F8wincredAuthoritativeSecretAAAABBBBCCCCDDDD";
const WINCRED_READ_SCRIPT = path.join(root, "scripts", "wincred-read.ps1");

await fs.mkdir(SECRETS, { recursive: true });
await fs.writeFile(path.join(SECRETS, `${sanitizeRef(FILE_REF)}.secret`), FILE_SECRET, "utf8");
await fs.writeFile(path.join(SECRETS, `${sanitizeRef(FILE_REF_2)}.secret`), `${FILE_SECRET_2}\n`, "utf8");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// ---- helpers ----

// A wincred store whose read backend is injected, so no test depends on this
// machine's real Credential Manager contents.
function wincredStore({ secret = null, status = "ok", reason = null, fileFallback = false, notices = null } = {}) {
  const store = {
    type: "wincred",
    readScript: WINCRED_READ_SCRIPT,
    readWincred: async () => (status === "ok" ? { status, secret } : { status, ...(reason ? { reason } : {}) }),
  };
  if (fileFallback) store.fileFallback = { dir: SECRETS };
  if (notices) store.onFallbackNotice = (message) => notices.push(message);
  return store;
}

function fileStore() {
  return { type: "file", dir: SECRETS };
}

// A notice must never carry the secret in any form.
function assertNoSecretLeak(text, secret) {
  assert.ok(!text.includes(secret), `notice must not contain the secret: ${text}`);
  for (let i = 0; i + 12 <= secret.length; i++) {
    assert.ok(!text.includes(secret.slice(i, i + 12)), `notice must not contain a secret fragment: ${text}`);
  }
}

// ---- 1. file store: injectable fixture behaviour is preserved ----

test("file 存储：{ type: 'file', dir } 仍可注入读取（fixtures 不变）", async () => {
  assert.equal(await readSecret(fileStore(), FILE_REF), FILE_SECRET);
  assert.equal(await readSecret(fileStore(), FILE_REF_2), FILE_SECRET_2, "应容忍文件尾部换行");
  assert.equal(await readSecret(fileStore(), "memory-lib/unknown-ref"), null);
  assert.equal(await readSecret(null, FILE_REF), null, "无 secretStore 时返回 null");
});

test("file 存储：authenticate 走 file store 成功并返回 credential 指纹", async () => {
  const ok = await authenticate(fileStore(), FILE_REF, FILE_SECRET);
  assert.equal(ok.ok, true);
  assert.match(ok.fingerprint, /^cred_[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(ok).includes(FILE_SECRET), "authenticate 结果不得含 secret");
  assert.equal((await authenticate(fileStore(), FILE_REF, "wrong")).reason, "BAD_SECRET");
  assert.equal((await authenticate(fileStore(), "memory-lib/unknown-ref", FILE_SECRET)).reason, "UNKNOWN_CREDENTIAL");
});

test("未知 secret store 类型 -> 明确报错（不静默当 file）", async () => {
  await assert.rejects(() => readSecret({ type: "keychain", dir: SECRETS }, FILE_REF), /unsupported secret store type: keychain/);
});

// ---- 2. wincred is authoritative ----

test("wincred 权威：wincred 命中即使用 wincred，即使同名 file 存在", async () => {
  const notices = [];
  const store = wincredStore({ secret: WINCRED_SECRET, notices });
  assert.equal(await readSecret(store, FILE_REF), WINCRED_SECRET, "file 中的同名 secret 不得覆盖 wincred");
  assert.equal(notices.length, 0, "命中 wincred 时不得产生任何提示");

  const auth = await authenticate(store, WINCRED_REF, WINCRED_SECRET);
  assert.equal(auth.ok, true);
});

// ---- 3. migration file fallback is opt-in only ----

test("wincred 成功读取按 TTL 缓存，可显式失效且 cacheTtlMs=0 保持每次读取", async () => {
  let reads = 0;
  const store = { type: "wincred", cacheTtlMs: 10_000, readWincred: async () => { reads += 1; return { status: "ok", secret: WINCRED_SECRET }; } };
  assert.equal(await readSecret(store, WINCRED_REF), WINCRED_SECRET);
  assert.equal(await readSecret(store, WINCRED_REF), WINCRED_SECRET);
  assert.equal(reads, 1);
  invalidateSecretCache(store, WINCRED_REF);
  assert.equal(await readSecret(store, WINCRED_REF), WINCRED_SECRET);
  assert.equal(reads, 2);
  const uncached = { type: "wincred", cacheTtlMs: 0, readWincred: async () => { reads += 1; return { status: "ok", secret: WINCRED_SECRET }; } };
  await readSecret(uncached, WINCRED_REF);
  await readSecret(uncached, WINCRED_REF);
  assert.equal(reads, 4);
});

test("wincred readSecret({ cache: false }) always re-reads (account password path)", async () => {
  let reads = 0;
  const store = { type: "wincred", cacheTtlMs: 10_000, readWincred: async () => { reads += 1; return { status: "ok", secret: WINCRED_SECRET }; } };
  await readSecret(store, WINCRED_REF);
  await readSecret(store, WINCRED_REF);
  assert.equal(reads, 1, "default readSecret is cached");
  await readSecret(store, WINCRED_REF, { cache: false });
  await readSecret(store, WINCRED_REF, { cache: false });
  assert.equal(reads, 3, "cache:false must bypass the cache on every read");
});

test("wincred missing/error results are never cached", async () => {
  for (const status of ["not-found", "error"]) {
    let reads = 0;
    const store = { type: "wincred", cacheTtlMs: 10_000, readWincred: async () => { reads += 1; return { status }; } };
    assert.equal(await readSecret(store, WINCRED_REF), null);
    assert.equal(await readSecret(store, WINCRED_REF), null);
    assert.equal(reads, 2, `${status} must be retried`);
  }
});

test("迁移兜底默认关闭：wincred 未命中 + file 存在 -> null 且无提示", async () => { 
  const notices = [];
  const store = wincredStore({ status: "not-found", notices });
  assert.equal(await readSecret(store, FILE_REF), null, "未配置兜底时不得读 file");
  assert.equal(notices.length, 0, "未配置兜底时不得产生提示");
  assert.equal((await authenticate(store, FILE_REF, FILE_SECRET)).reason, "UNKNOWN_CREDENTIAL");
});

test("迁移兜底仅在显式配置时生效，且提示只出现一次（每个 credential_ref）", async () => {
  const notices = [];
  const store = wincredStore({ status: "not-found", fileFallback: true, notices });

  assert.equal(await readSecret(store, FILE_REF), FILE_SECRET, "显式配置后可读 file 兜底");
  assert.equal(notices.length, 1, "首次兜底应提示一次");
  assert.equal(await readSecret(store, FILE_REF), FILE_SECRET, "再次读取仍走兜底");
  assert.equal(notices.length, 1, "同一 credential_ref 只提示一次（once-only）");
  assert.equal(await readSecret(store, FILE_REF_2), FILE_SECRET_2, "另一个 ref 同样可兜底");
  assert.equal(notices.length, 2, "不同 credential_ref 各自提示一次");

  // 兜底路径鉴权成功（迁移期不改协议/鉴权语义）
  const auth = await authenticate(store, FILE_REF_2, FILE_SECRET_2);
  assert.equal(auth.ok, true);
  assert.match(auth.fingerprint, /^cred_[0-9a-f]{16}$/);
});

test("兜底提示不含 secret（无泄漏），且指明是迁移兜底", async () => {
  const notices = [];
  const store = wincredStore({ status: "not-found", fileFallback: true, notices });
  await readSecret(store, FILE_REF);
  assert.equal(notices.length, 1);
  const notice = notices[0];
  assertNoSecretLeak(notice, FILE_SECRET);
  assert.match(notice, /file fallback/i, "提示应说明走了 file 兜底");
  assert.match(notice, /migration/i, "提示应说明是迁移期行为");
  assert.ok(notice.includes(sanitizeRef(FILE_REF)), "提示应指明是哪个 credential_ref");
});

// ---- 4. backend failure must not be masked by the fallback ----

test("wincred 后端故障不静默兜底（不掩盖双活）：不返回 file secret，且明确提示原因", async () => {
  const notices = [];
  const store = wincredStore({ status: "error", reason: "1", fileFallback: true, notices });

  assert.equal(await readSecret(store, FILE_REF), null, "后端故障时不得退化成 file 读取");
  assert.equal(notices.length, 1, "后端故障应给出一次明确提示");
  assertNoSecretLeak(notices[0], FILE_SECRET);
  assert.match(notices[0], /wincred/i);
  assert.match(notices[0], /1/, "提示应带可分辨的失败原因");
  assert.match(notices[0], /fallback|degrad/i, "提示应说明未使用兜底");

  await readSecret(store, FILE_REF);
  assert.equal(notices.length, 1, "后端故障提示同样 once-only");

  // 用 file 中的 secret 也不得通过鉴权（否则就是被掩盖的双活）
  assert.equal((await authenticate(store, FILE_REF, FILE_SECRET)).reason, "UNKNOWN_CREDENTIAL");
});

// ---- 5. live wincred helper (Windows only) ----

test("实测 wincred 读取助手：不存在的 target 判定为 not-found（不误判成后端故障）", { skip: process.platform !== "win32" ? "windows only" : false }, async () => {
  const missingRef = `memory-lib/f8-missing-${Date.now()}`;
  const notices = [];
  const store = { type: "wincred", readScript: WINCRED_READ_SCRIPT, onFallbackNotice: (m) => notices.push(m) };
  assert.equal(await readSecret(store, missingRef), null, "不存在的 target 应返回 null");
  assert.equal(notices.length, 0, "not-found 是正常情况，不应报后端故障");

  // 真实助手 + 兜底：不存在的 target 走 file 兜底（target 从未写入凭据管理器，不触碰生产凭据）
  const fallbackNotices = [];
  const withFallback = { ...store, fileFallback: { dir: SECRETS }, onFallbackNotice: (m) => fallbackNotices.push(m) };
  assert.equal(await readSecret(withFallback, FILE_REF), FILE_SECRET);
  assert.equal(fallbackNotices.length, 1);
  assertNoSecretLeak(fallbackNotices[0], FILE_SECRET);
});

// ---- 6. CLI / config validation ----

test("readFlagValue：区分未提供 / 带值 / 缺值 / 后跟另一个参数", () => {
  assert.deepEqual(readFlagValue(["--port", "8787"], "--secret-store"), { present: false, value: null });
  assert.deepEqual(readFlagValue(["--secret-store", "file"], "--secret-store"), { present: true, value: "file" });
  assert.deepEqual(readFlagValue(["--secret-store"], "--secret-store"), { present: true, value: null });
  assert.deepEqual(readFlagValue(["--secret-store", "--port", "8787"], "--secret-store"), { present: true, value: null });
});

test("配置解析：默认 wincred，显式 file，非法值清晰报错", async () => {
  assert.deepEqual(SECRET_STORE_TYPES, ["wincred", "file"]);
  assert.equal(DEFAULT_SECRET_STORE, "wincred");
  const serverSource = await fs.readFile(path.join(root, "server.mjs"), "utf8");
  assert.equal(serverSource.includes('arg("--secret-store"'), false, "server.mjs must have one authoritative secret-store parser");

  // 未传 --secret-store -> 默认 wincred（权威）
  const dflt = resolveSecretStoreConfig({ flag: readFlagValue([], "--secret-store"), secretsDir: SECRETS, wincredReadScript: WINCRED_READ_SCRIPT });
  assert.equal(dflt.type, "wincred");
  assert.equal(dflt.readScript, WINCRED_READ_SCRIPT);
  assert.equal(dflt.fileFallback, undefined, "默认不开迁移兜底");

  // 显式 opt-in file
  const file = resolveSecretStoreConfig({ flag: readFlagValue(["--secret-store", "file"], "--secret-store"), secretsDir: SECRETS, wincredReadScript: WINCRED_READ_SCRIPT });
  assert.equal(file.type, "file");
  assert.equal(file.dir, SECRETS);

  // 非法值 -> 清晰报错（列出合法值，不静默退回默认）
  assert.throws(
    () => resolveSecretStoreConfig({ flag: readFlagValue(["--secret-store", "banana"], "--secret-store"), secretsDir: SECRETS, wincredReadScript: WINCRED_READ_SCRIPT }),
    (err) => /unsupported --secret-store value: "banana"/.test(err.message) && err.message.includes("wincred") && err.message.includes("file")
  );

  // 缺值 -> 清晰报错
  assert.throws(
    () => resolveSecretStoreConfig({ flag: readFlagValue(["--secret-store"], "--secret-store"), secretsDir: SECRETS, wincredReadScript: WINCRED_READ_SCRIPT }),
    /missing value for --secret-store/
  );

  // 兜底只能配 wincred
  const fallback = resolveSecretStoreConfig({ flag: readFlagValue(["--secret-store", "wincred"], "--secret-store"), secretsDir: SECRETS, wincredReadScript: WINCRED_READ_SCRIPT, fileFallback: true });
  assert.deepEqual(fallback.fileFallback, { dir: SECRETS });
  assert.throws(
    () => resolveSecretStoreConfig({ flag: readFlagValue(["--secret-store", "file"], "--secret-store"), secretsDir: SECRETS, wincredReadScript: WINCRED_READ_SCRIPT, fileFallback: true }),
    /--secret-fallback-file requires --secret-store wincred/
  );
});

test("auto-review 配置优先使用 CLI mode 与配置文件，并对坏配置 fail closed", async () => {
  assert.deepEqual(await resolveAutoReviewConfig(), {});
  const config = await resolveAutoReviewConfig({
    modeFlag: readFlagValue(["--auto-review", "dry-run"], "--auto-review"),
    configFlag: readFlagValue(["--auto-review-config", "policy.json"], "--auto-review-config"),
    envMode: "off",
    readFile: async () => JSON.stringify({ rules: [{ id: "fixture-rule", decision: "leave" }], fallback: "leave" }),
  });
  assert.equal(config.mode, "dry-run");
  assert.equal(config.enabled, true);
  assert.equal(config.rules[0].id, "fixture-rule");
  await assert.rejects(
    () => resolveAutoReviewConfig({ configFlag: readFlagValue(["--auto-review-config"], "--auto-review-config"), readFile: async () => "{}" }),
    /missing value for --auto-review-config/
  );
  await assert.rejects(
    () => resolveAutoReviewConfig({ configFlag: readFlagValue(["--auto-review-config", "bad.json"], "--auto-review-config"), readFile: async () => "not-json" }),
    /invalid JSON/
  );
  await assert.rejects(
    () => resolveAutoReviewConfig({ configFlag: readFlagValue(["--auto-review-config", "bad.json"], "--auto-review-config"), readFile: async () => JSON.stringify({ unknown: true }) }),
    /unsupported fields: unknown/
  );
});

test("CLI 实测：非法 --secret-store 以退出码 1 明确失败（不启动服务、也不退回 file）", () => {
  for (const argv of [["--secret-store", "banana"], ["--secret-store", "FILE"], ["--secret-store", "file "]]) {
    const r = spawnSync(process.execPath, [path.join(root, "server.mjs"), ...argv], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 1, `应退出码 1: ${argv.join(" ")} / stderr=${r.stderr}`);
    assert.match(r.stderr, /unsupported --secret-store value/, `应给出清晰错误: ${r.stderr}`);
    assert.ok(!/listening on/.test(r.stdout + r.stderr), "非法配置不得启动服务");
  }

  const missing = spawnSync(process.execPath, [path.join(root, "server.mjs"), "--secret-store"], { cwd: root, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing value for --secret-store/);

  const legacyFallback = spawnSync(process.execPath, [path.join(root, "server.mjs"), "--secret-store", "file", "--secret-fallback-file"], { cwd: root, encoding: "utf8" });
  assert.equal(legacyFallback.status, 1);
  assert.match(legacyFallback.stderr, /--secret-fallback-file requires --secret-store wincred/);
});
