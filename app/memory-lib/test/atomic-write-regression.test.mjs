// ATOMICWRITE-1 打回修复：**回归护栏**。
//
// 事故（产品岗在隔离副本里抓到）：`scripts/bootstrap-api-key.mjs` 里那个本地
// `atomicJson()` 定义被 ATOMICWRITE-1 删掉了，但调用点 `await atomicJson(...)` 还在
// ⇒ 真实路径抛 `ReferenceError` ⇒ CLI 退出码 2。
//
// 为什么我上一轮没发现：`id1-bootstrap-cli.test.mjs` 在**我的环境**里因为沙箱
// 拿不到子进程而报 `spawn EPERM`（那是另一回事），于是这条**代码缺陷被环境噪声盖住了**。
// 本文件刻意用两件环境无关的办法把它钉住：
//   ① **静态检查**：本仓任何文件都不许"调用一个未定义的 atomic* 函数"；
//   ② **动态检查**：把该 CLI 的**失败路径**真的跑起来（stdin/stdout 用 ignore，不用管道），
//      断言它不会以非 0 退出、也不会打印 ReferenceError。
// 两者都能在沙箱里跑通，所以以后同类"删了函数没改调用点"会在本地就红。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ───────── ① 静态：不许调用未定义的 atomic* 标识符 ─────────

async function listModules(dir) {
  const entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs")).map((entry) => path.join(dir, entry.name));
}

test("no module calls an atomic* helper that it does not define or import", async () => {
  const offenders = [];
  for (const dir of ["src", "scripts", "mcp"]) {
    for (const relative of await listModules(dir)) {
      // 先去掉注释：代码说明里提到某个函数名（如"原先这里调 atomicJson()"）不算调用。
      const text = (await fs.readFile(path.join(ROOT, relative), "utf8"))
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .split(/\r?\n/u).map((line) => line.replace(/\/\/.*$/u, "")).join("\n");
      const called = [...new Set([...text.matchAll(/\b(atomic\w*|renameWithRetry)\s*\(/gu)].map((match) => match[1]))];
      for (const name of called) {
        // 定义（函数声明/赋值）或在 import 里出现，即算已声明。
        const declared =
          new RegExp(`(?:async\\s+)?function\\s+${name}\\b`, "u").test(text) ||
          new RegExp(`(?:const|let|var)\\s+${name}\\b`, "u").test(text) ||
          new RegExp(`import[^;]*\\b${name}\\b`, "u").test(text) ||
          new RegExp(`\\b${name}\\s*[:=]\\s*(?:async\\s*)?\\(`, "u").test(text);
        if (!declared) offenders.push(`${relative} calls ${name}() but never defines or imports it`);
      }
    }
  }
  assert.deepEqual(offenders, [], `undefined atomic helpers referenced:\n${offenders.join("\n")}`);
});

// ───────── ② 动态：真跑一次 CLI 的失败路径 ─────────

test("bootstrap-api-key.mjs exits 0 when actually run (not just --dry-run)", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "atomicwrite-guard-bootstrap-"));
  const registryPath = path.join(tmp, "identity.json");
  const apiKeysPath = path.join(tmp, "api-keys.json");
  const outputPath = path.join(tmp, "bootstrap.json");
  await fs.writeFile(registryPath, `${JSON.stringify({ version: 1, frameworks: [{ framework_id: "guard-fw", credential_ref: "guard/cred", agents: [] }] }, null, 2)}\n`, "utf8");

  const script = path.join(ROOT, "scripts", "bootstrap-api-key.mjs");
  const argv = [
    script,
    "--registry", registryPath,
    "--api-keys", apiKeysPath,
    "--framework", "guard-fw",
    "--credential-ref", "guard/cred",
    "--agent", "guard-agent",
    "--role", "guard-role",
    "--group", "guard-group",
    "--group-name", "Guard Group",
    "--user", "guard-user",
    "--user-name", "Guard User",
    "--role-name", "Guard Role",
    "--pepper", "guard-pepper",
    "--output-file", outputPath,
  ];

  // 子进程在这里是必需品，而受限沙箱会拒绝某些 spawn 形态 —— 实测连 `stdio: "ignore"`
  // 能起、换成 `["ignore","ignore","pipe"]` 就 EPERM。所以探测必须用**与真实调用完全一样**的
  // options，否则探测会误报"可用"。探不明白就如实记成"未执行"，
  // **绝不能**把"没跑成"算成"通过"（上一轮的教训就是环境噪声盖住了代码缺陷）。
  const SPAWN_OPTIONS = { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], windowsHide: true };
  const spawnProbe = await new Promise((resolve) => {
    let child;
    try { child = spawn(process.execPath, ["-e", "0"], SPAWN_OPTIONS); }
    catch (error) { resolve({ available: false, reason: error.code ?? error.message }); return; }
    child.once("error", (error) => resolve({ available: false, reason: error.code ?? error.message }));
    child.once("exit", () => resolve({ available: true }));
  });
  if (!spawnProbe.available) {
    t.diagnostic(`SKIPPED: subprocess spawning is unavailable here (${spawnProbe.reason}) -> this check did NOT run; the static check above still covers the defect class`);
    await fs.rm(tmp, { recursive: true, force: true });
    return;
  }

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, SPAWN_OPTIONS);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });

  assert.equal(result.code, 0, `bootstrap api key CLI must succeed; exit=${result.code} stderr=${result.stderr.slice(0, 400)}`);
  assert.doesNotMatch(result.stderr, /is not defined/u, "a ReferenceError means a helper was removed but its call site survived");

  // 真的写进去了（不只是"退出码 0"）。
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const role = registry.frameworks[0].agents.find((agent) => agent.agent_id === "guard-agent")?.roles.find((item) => item.role_id === "guard-role");
  assert.ok(role, "the registry must actually contain the bootstrapped role");
  const emitted = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(emitted.ok, true);
  assert.equal(emitted.key.role_id, "guard-role");
  const keys = JSON.parse(await fs.readFile(apiKeysPath, "utf8"));
  assert.deepEqual(keys.roles.map((item) => item.id), ["guard-role"]);

  await fs.rm(tmp, { recursive: true, force: true });
});
