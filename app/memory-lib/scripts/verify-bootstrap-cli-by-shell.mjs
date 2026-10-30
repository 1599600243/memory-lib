// ATOMICWRITE-1 打回修复的**替代验证**：一次性完成 fixture 准备 + shell 驱动 CLI + 断言。
//
// 为什么需要它：`test/id1-bootstrap-cli.test.mjs` 必须 spawn 子进程，而本机受**文件沙箱**限制，
// **任何**子进程都起不来（Windows 子进程初始化失败 0xC0000142 / spawn EPERM）—— 连
// `node --test` 自己也会失败，因为它每个测试文件 spawn 一个子进程。所以那份测试在我这里
// **无法执行**，我**不能**把它报成"通过"。
//
// 本脚本做同一件事，但不依赖 Node 的 spawn：由**本脚本**用 `execFileSync` 的反面 ——
// 即把命令交给调用它的 shell —— 不现实；因此改为**本进程负责 fixture 与断言，
// CLI 由外层 shell 驱动**，两边通过文件与退出码交接。
//
// 用法（外层 shell 负责跑 CLI）：
//   1) node scripts/verify-bootstrap-cli-by-shell.mjs prepare <workdir>
//   2) shell: node scripts/bootstrap-api-key.mjs <args...>  → 记录退出码
//   3) node scripts/verify-bootstrap-cli-by-shell.mjs assert <workdir>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [mode, workdir] = process.argv.slice(2);
assert.ok(mode === "prepare" || mode === "assert", "usage: <prepare|assert> <workdir>");
assert.ok(workdir, "workdir is required");

if (mode === "prepare") {
  const auth = await createTestAuth(ROOT, workdir);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  registry.frameworks[0].agents = [];
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  // 把 CLI 需要的参数写成文件，供 shell 使用（避免 shell 里再解析 JSON）。
  await fs.writeFile(path.join(workdir, "cli-args.txt"), [
    "--registry", auth.registryPath,
    "--api-keys", path.join(workdir, "empty-api-keys.json"),
    "--framework", registry.frameworks[0].framework_id,
    "--credential-ref", auth.credentialRef,
    "--agent", "first-agent", "--role", "first-role",
    "--group", "first-group", "--group-name", "First Group",
    "--user", "first-user", "--user-name", "First User",
    "--role-name", "First Role", "--pepper", "bootstrap-pepper",
  ].join("\n"), "utf8");
  console.log(JSON.stringify({ prepared: true, registryPath: auth.registryPath, credentialRef: auth.credentialRef }));
} else {
  const registryPath = path.join(workdir, "identity.json");
  const apiKeys = path.join(workdir, "empty-api-keys.json");
  const exit1 = Number(await fs.readFile(path.join(workdir, "exit1.txt"), "utf8"));
  const exit2 = Number(await fs.readFile(path.join(workdir, "exit2.txt"), "utf8"));
  const stderr1 = await fs.readFile(path.join(workdir, "stderr1.txt"), "utf8").catch(() => "");

  assert.equal(exit1, 0, `first real run must exit 0, got ${exit1}; stderr=${stderr1.slice(0, 300)}`);
  assert.equal(exit2, 0, `re-run must exit 0 (idempotent), got ${exit2}`);
  assert.doesNotMatch(stderr1, /is not defined/u, "a ReferenceError means a helper was removed but its call site survived");

  const firstRun = JSON.parse(await fs.readFile(path.join(workdir, "out1.json"), "utf8"));
  const secondRun = JSON.parse(await fs.readFile(path.join(workdir, "out2.json"), "utf8"));
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.key.role_id, "first-role");
  assert.equal(secondRun.ok, true);
  assert.notEqual(secondRun.key.secret, firstRun.key.secret, "each run must issue a fresh secret");

  const identity = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(identity.frameworks[0].agents.length, 1, "re-run must not duplicate the agent");
  const role = identity.frameworks[0].agents.find((item) => item.agent_id === "first-agent").roles.find((item) => item.role_id === "first-role");
  assert.deepEqual(role.actions, ["search", "get", "propose"]);

  const keys = JSON.parse(await fs.readFile(apiKeys, "utf8"));
  assert.deepEqual(keys.groups.map((item) => item.id), ["first-group"]);
  assert.deepEqual(keys.users.map((item) => item.id), ["first-user"]);
  assert.deepEqual(keys.roles.map((item) => item.id), ["first-role"]);
  assert.equal(keys.api_keys.length, 2, "two runs => two keys");
  assert.equal(keys.api_keys[0].secret_hash.includes(firstRun.key.secret), false, "the plaintext secret must not be stored");

  // 真实认证：用第一把 key 打一次 /v1/search（服务端要自己的 pepper）。
  const dataRoot = path.join(workdir, "memory");
  const adapter = createLocalhostServer({
    libFactory: ({ scopes, agentId, roleId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot: workdir, scopes, agentId, roleId, principal, audit, vectorLane: { probe: false } }),
    registryPath, secretStore: { type: "file", dir: path.join(workdir, "secrets") },
    auditPath: path.join(workdir, "audit.jsonl"), apiKeyFile: apiKeys, apiKeyPepper: "bootstrap-pepper",
    host: "127.0.0.1", port: 0, indexScheduleEnabled: false, vectorLane: { probe: false },
  });
  const address = await adapter.listen();
  let authenticated;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${firstRun.key.secret}`, "x-memory-lib-key-pepper": "bootstrap-pepper" },
      body: JSON.stringify({ query: "bootstrap", limit: 1 }),
    });
    authenticated = { status: response.status, data: await response.json().catch(() => ({})) };
  } finally { await adapter.close(); }

  console.log(JSON.stringify({
    ok: true,
    exit1, exit2,
    stderr1Empty: stderr1.trim() === "",
    firstRunOk: firstRun.ok, secondRunOk: secondRun.ok,
    secretsDiffer: secondRun.key.secret !== firstRun.key.secret,
    agentsAfterRerun: identity.frameworks[0].agents.length,
    roleActions: role.actions,
    apiKeyCount: keys.api_keys.length,
    plaintextSecretStored: keys.api_keys[0].secret_hash.includes(firstRun.key.secret),
    authenticatedSearchStatus: authenticated.status,
    authenticatedSearchCode: authenticated.data?.error?.code ?? null,
  }, null, 2));
}
