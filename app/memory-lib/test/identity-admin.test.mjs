// memory-lib — identity-admin (framework create + credential rotate) tests.
// Run directly: node test/identity-admin.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createFramework, rotateCredential } from "../src/identity-admin.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-ida-"));
const REGISTRY = path.join(TMP, "identity.json");
const SECRETS = path.join(TMP, "secrets");

await fs.writeFile(REGISTRY, JSON.stringify({ version: 1, frameworks: [] }), "utf8");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

test("createFramework：注册新框架 + 生成 secret + 写文件 + 更新 registry", async () => {
  const r = await createFramework({
    registryPath: REGISTRY, secretsDir: SECRETS,
    frameworkId: "test-fw", credentialRef: "memory-lib/test-fw",
    agentId: "ta-01", roleId: "researcher",
    scopes: [{ layer: "memory", visibility: "shared" }],
    actions: ["search", "get", "propose"],
  });
  assert.equal(r.framework_id, "test-fw");
  assert.match(r.secret, /^[A-Za-z0-9_-]{40,}$/, "应生成 48 字节 base64url secret");
  const sf = await fs.readFile(path.join(SECRETS, "memory-lib_test-fw.secret"), "utf8");
  assert.equal(sf, r.secret, "secret 文件应写入");

  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
  const fw = reg.frameworks.find((f) => f.framework_id === "test-fw");
  assert.ok(fw, "registry 应有新 framework");
  assert.equal(fw.credential_ref, "memory-lib/test-fw");
  assert.ok(fw.agents[0].roles[0].actions.includes("propose"));
  assert.deepEqual(reg.accounts ?? [], [], "machine framework creation must not implicitly create a human password account");
});

test("createFramework：重复注册同 framework 更新 role，不重复加 agent", async () => {
  await createFramework({
    registryPath: REGISTRY, secretsDir: SECRETS,
    frameworkId: "test-fw", credentialRef: "memory-lib/test-fw",
    agentId: "ta-01", roleId: "researcher",
    scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "*" }],
    actions: ["search", "get"],
  });
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
  const fw = reg.frameworks.find((f) => f.framework_id === "test-fw");
  assert.equal(fw.agents.length, 1, "不应重复加 agent");
  assert.equal(fw.agents[0].roles[0].actions.length, 2, "role 应被更新");
});

test("createFramework：credential_ref 冲突 -> 报错", async () => {
  await assert.rejects(
    createFramework({ registryPath: REGISTRY, secretsDir: SECRETS, frameworkId: "test-fw", credentialRef: "memory-lib/other", agentId: "x", roleId: "y", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search"] }),
    /already bound/
  );
});

test("rotateCredential：轮换 secret（不碰 registry）", async () => {
  const before = (await fs.readFile(path.join(SECRETS, "memory-lib_test-fw.secret"), "utf8"));
  const r = await rotateCredential({ secretsDir: SECRETS, credentialRef: "memory-lib/test-fw" });
  assert.match(r.secret, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(r.secret, before, "应生成新 secret");
  const sf = await fs.readFile(path.join(SECRETS, "memory-lib_test-fw.secret"), "utf8");
  assert.equal(sf, r.secret, "secret 文件应更新");
  // registry 不变（credential_ref 不增不减）
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
  assert.equal(reg.frameworks.length, 1);
});

// ---- F8: wincred 写失败必须显式（不再静默双活） ----
// wincred 是权威存储；写失败却继续注册会留下「file 有值、wincred 没有」的静默双活，
// 服务端按 wincred 鉴权时表现为「凭证突然失效」。因此写失败必须报错并保持原状。

test("createFramework：wincred 写成功 -> wincred: true", async () => {
  const r = await createFramework({
    registryPath: REGISTRY, secretsDir: SECRETS,
    frameworkId: "f8-wincred-ok", credentialRef: "memory-lib/f8-wincred-ok",
    agentId: "a", roleId: "r",
    scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search"],
    wincred: true, wincredWriter: () => ({ ok: true, target: "memory-lib_f8-wincred-ok" }),
  });
  assert.equal(r.wincred, true);
});

test("createFramework：未请求 wincred -> wincred: null 且不调用写入器", async () => {
  let called = false;
  const r = await createFramework({
    registryPath: REGISTRY, secretsDir: SECRETS,
    frameworkId: "f8-no-wincred", credentialRef: "memory-lib/f8-no-wincred",
    agentId: "a", roleId: "r",
    scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search"],
    wincredWriter: () => { called = true; return { ok: true, target: "x" }; },
  });
  assert.equal(r.wincred, null);
  assert.equal(called, false, "未请求 wincred 时不得写凭据管理器");
});

test("createFramework：wincred 写失败 -> 明确报错，registry 不半注册，secret 文件不留残留", async () => {
  const REF = "memory-lib/f8-wincred-fail";
  await assert.rejects(
    () => createFramework({
      registryPath: REGISTRY, secretsDir: SECRETS,
      frameworkId: "f8-wincred-fail", credentialRef: REF,
      agentId: "a", roleId: "r",
      scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search"],
      wincred: true, wincredWriter: () => ({ ok: false, target: "memory-lib_f8-wincred-fail", reason: "ENOENT" }),
    }),
    (err) => {
      assert.match(err.message, /wincred write failed/, "错误信息应明确指出 wincred 写失败");
      assert.match(err.message, /ENOENT/, "错误信息应带可分辨原因");
      assert.ok(!/[A-Za-z0-9_-]{40,}/.test(err.message), "错误信息不得含 secret");
      return true;
    }
  );
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
  assert.equal(reg.frameworks.find((f) => f.framework_id === "f8-wincred-fail"), undefined, "不得半注册 framework");
  await assert.rejects(() => fs.readFile(path.join(SECRETS, "memory-lib_f8-wincred-fail.secret"), "utf8"), /ENOENT/, "失败的 secret 文件应回滚");
});

test("rotateCredential：wincred 写失败 -> 明确报错并原样保留旧 secret（不做半套轮换）", async () => {
  const secretFile = path.join(SECRETS, "memory-lib_test-fw.secret");
  const before = await fs.readFile(secretFile, "utf8");
  await assert.rejects(
    () => rotateCredential({
      secretsDir: SECRETS, credentialRef: "memory-lib/test-fw",
      wincred: true, wincredWriter: () => ({ ok: false, target: "memory-lib_test-fw", reason: "exit 1" }),
    }),
    (err) => {
      assert.match(err.message, /wincred write failed/);
      assert.ok(!/[A-Za-z0-9_-]{40,}/.test(err.message), "错误信息不得含 secret");
      return true;
    }
  );
  assert.equal(await fs.readFile(secretFile, "utf8"), before, "旧 secret 必须原样保留（正在运行的实例不受影响）");
});
