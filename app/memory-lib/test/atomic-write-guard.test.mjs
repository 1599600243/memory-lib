// ATOMICWRITE-1 护栏：全仓不允许再出现"裸 rename"。
//
// 为什么要有这条测试：本单修的是一类**散落的**缺陷 —— 20 处左右的原子写各自
// `fs.rename(tmp, target)`，谁都没有重试。逐个改一遍不难，难的是**别再长回来**：
// 新增一个写入口时，最自然的写法就是再抄一遍 rename，于是缺陷重新出现且没人发现。
// 所以这里用一条会失败的测试把边界钉死，而不是靠"记得"。
//
// 判据：除统一助手 `src/atomic-write.mjs` 之外，src/ / scripts/ / mcp/ 下
// **不得**出现 `fs.rename(`；需要 rename 的地方必须走 `atomicWriteFile` 或 `renameWithRetry`。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRS = ["src", "scripts", "mcp"];
// 唯一允许出现 rename 原语的文件（它自己就是那个收敛点）。
const HELPER = path.join("src", "atomic-write.mjs");

async function listModules(dir) {
  const entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs")).map((entry) => path.join(dir, entry.name));
}

test("no module outside the helper calls fs.rename directly", async () => {
  const offenders = [];
  for (const dir of SCANNED_DIRS) {
    for (const relative of await listModules(dir)) {
      if (relative === HELPER) continue;
      const text = await fs.readFile(path.join(ROOT, relative), "utf8");
      text.split(/\r?\n/u).forEach((line, index) => {
        // 只看真实调用，忽略注释里作为说明出现的写法。
        const code = line.replace(/\/\/.*$/u, "").replace(/\/\*[\s\S]*?\*\//gu, "");
        if (/fs\.rename\s*\(/u.test(code)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `bare fs.rename calls found (they must go through atomicWriteFile / renameWithRetry so the EPERM retry applies):\n${offenders.join("\n")}`,
  );
});

test("the helper is the single place that owns the rename primitive", async () => {
  const text = await fs.readFile(path.join(ROOT, HELPER), "utf8");
  assert.match(text, /fs\.rename/u, "the helper must still contain the primitive");
  assert.match(text, /export async function atomicWriteFile/u);
  assert.match(text, /export async function renameWithRetry/u);
  // 重试分类必须集中在这里，不许散落。
  assert.match(text, /EPERM/u);
  assert.match(text, /EACCES/u);
  assert.match(text, /EBUSY/u);
});

test("every module that writes atomically imports the helper", async () => {
  // 反向核对：曾经各自实现原子写的文件，现在必须都依赖同一个助手。
  const expected = [
    "src/conversation-memory.mjs",
    "src/write-memory.mjs",
    "src/evidence-recovery.mjs",
    "src/profile-memory.mjs",
    "src/role-memory.mjs",
    "src/pet-runtime-store.mjs",
    "src/memory-ingest.mjs",
    "src/transcript-importer.mjs",
    "src/admin.mjs",
    "src/memory-lib.mjs",
    "src/learning.mjs",
    "src/maintenance-scheduler.mjs",
    "src/agent-runtime.mjs",
    "src/identity-admin.mjs",
    "src/cold-layer.mjs",
    "src/plans-memory.mjs",
    "src/project-memory.mjs",
    "src/tools-memory.mjs",
    "src/password-hash.mjs",
    "src/sessions.mjs",
    "src/archive-memory.mjs",
    "src/audit-archive.mjs",
    "src/api-key-registry.mjs",
    "scripts/bootstrap-api-key.mjs",
    "scripts/generate-zh-summary.mjs",
    "scripts/backfill-calendar-fields.mjs",
    "scripts/onboard-framework.mjs",
  ];
  const missing = [];
  for (const relative of expected) {
    const text = await fs.readFile(path.join(ROOT, relative), "utf8");
    if (!/atomic-write\.mjs/u.test(text)) missing.push(relative);
  }
  assert.deepEqual(missing, [], `these files no longer route through the shared helper:\n${missing.join("\n")}`);
});
