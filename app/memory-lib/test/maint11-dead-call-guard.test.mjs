// MAINT11：机械守卫 —— "被调用但既没 import 也没定义"的标识符，扫到就红。
//
// 为什么要有它：`buildFrontmatter`（MAINT10）、`getStewardBatch` / `runMaintenance` /
// `listInboxCandidates` / `readInboxCandidate`（MAINT11）都是同一个病 —— D29 删了实现，
// 调用点留着，**一调用就 500**。靠人眼 grep 记不住，所以做成测试。
//
// 判据（与 scripts/maint10-undefined-called-identifiers.mjs 同一个函数，单一真值）：
//   调用点 `name(` 排除成员调用/关键字；若该名字在整份语料里**只出现在调用处**（occurrences ≤ 1），
//   说明它既没被 import、也没被声明 —— 红。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanUndefinedCalledIdentifiers } from "../scripts/maint10-undefined-called-identifiers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeFakeRoot(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-deadcall-"));
  for (const [relative, text] of Object.entries(files)) {
    const abs = path.join(dir, relative);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  }
  return dir;
}

test("当前仓库：src/ 与 mcp/ 里没有『被调用但从未定义』的标识符", async () => {
  const findings = await scanUndefinedCalledIdentifiers({ root });
  assert.deepEqual(findings, [], `dead call sites found: ${JSON.stringify(findings)}`);
});

test("守卫有牙（样本 1）：MAINT10 的 buildFrontmatter 必须被抓住", async () => {
  // 这就是 ec8b9cf 修掉的那一行（线上 400 "buildFrontmatter is not defined"）
  const dir = await makeFakeRoot({
    "src/memory-lib.mjs": [
      'import { atomicWriteFile } from "./atomic-write.mjs";',
      "export async function deprecateShim(item, frontmatter, body) {",
      "  await atomicWriteFile(item.filePath, buildFrontmatter(frontmatter) + body);",
      "}",
    ].join("\n"),
  });
  try {
    const findings = await scanUndefinedCalledIdentifiers({ root: dir });
    assert.equal(findings.length, 1, `expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].name, "buildFrontmatter");
    assert.equal(findings[0].file, "src/memory-lib.mjs");
    assert.equal(findings[0].line, 3, "must point at the exact call line");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("守卫有牙（样本 2）：MAINT11 的四个死调用点也必须被抓住", async () => {
  const dir = await makeFakeRoot({
    "src/localhost-server.mjs": [
      "export async function routes(role, body, dataRoot) {",
      "  const batch = await getStewardBatch();",
      "  const result = await runMaintenance(mode, {});",
      "  const candidates = await listInboxCandidates(dataRoot, {});",
      "  const candidate = await readInboxCandidate(dataRoot, 'x');",
      "  return { batch, result, candidates, candidate };",
      "}",
    ].join("\n"),
  });
  try {
    const findings = await scanUndefinedCalledIdentifiers({ root: dir });
    const names = findings.map((f) => f.name).sort();
    assert.deepEqual(names, ["getStewardBatch", "listInboxCandidates", "readInboxCandidate", "runMaintenance"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("守卫不误报：import 进来的、本地定义的、成员调用、关键字都不算", async () => {
  const dir = await makeFakeRoot({
    "src/legit.mjs": [
      'import { atomicWriteFile } from "./atomic-write.mjs";',
      'import { helperA } from "./helper.mjs";',
      "function localFn(x) { return x; }",
      "const arrow = (y) => y;",
      "export async function run(obj) {",
      "  await atomicWriteFile('p', 'v');",
      "  localFn(1);",
      "  arrow(2);",
      "  helperA();",
      "  obj.method(3);",
      "  if (true) { return 1; }",
      "  for (const item of []) { void item; }",
      "  return typeof obj;",
      "}",
    ].join("\n"),
    "src/helper.mjs": "export function helperA() { return 1; }\n",
  });
  try {
    const findings = await scanUndefinedCalledIdentifiers({ root: dir });
    assert.deepEqual(findings, [], `false positives: ${JSON.stringify(findings)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
