// ATOMICWRITE-1：原子写的契约测试。
//
// 背景（产品岗在 DAYRECALL-1 复核里实测）：Windows 上偶发
//   EPERM: operation not permitted, rename '…progress.md.<pid>.<uuid>.tmp' -> '…progress.md'
// 全仓**没有任何重试** ⇒ 一次偶发就变成一次 `400 WRITE_REJECTED`（用户侧"写没成功"）。
//
// 这批测试先写、先跑红（`src/atomic-write.mjs` 尚不存在），把三件事固定住：
//   ① 第一次 rename 抛 EPERM、第二次成功 ⇒ **最终写入成功**；
//   ② 一直抛 EPERM ⇒ **最终仍然失败**（不许吞错、不许假装成功）；
//   ③ 非重试类错误（ENOENT）⇒ **立即失败**，不做无谓重试。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, isRetryableRenameError, renameWithRetry, RENAME_RETRY_DELAYS_MS } from "../src/atomic-write.mjs";

// 测试里把退避压成 0，跑得快；断言的是"重试次数/顺序"，不是"等了多久"。
const NO_DELAY = { retryDelaysMs: [0, 0, 0, 0, 0], jitter: 0 };

function fsError(code, syscall = "rename") {
  return Object.assign(new Error(`${code}: operation not permitted, ${syscall} 'a' -> 'b'`), { code, errno: -4048, syscall, path: "a", dest: "b" });
}

async function tmpDir(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `memory-lib-atomicwrite-${label}-`));
}

test("a transient EPERM on rename is retried and the write still succeeds", async () => {
  const dir = await tmpDir("retry-once");
  try {
    const target = path.join(dir, "progress.md");
    let calls = 0;
    const rename = async (from, to) => {
      calls += 1;
      if (calls === 1) throw fsError("EPERM");
      return fs.rename(from, to);
    };
    await atomicWriteFile(target, "hello", { rename, ...NO_DELAY });
    assert.equal(calls, 2, "the first rename failed, the second must have been attempted");
    assert.equal(await fs.readFile(target, "utf8"), "hello", "the write must have actually landed");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a persistent EPERM eventually fails and never pretends to have succeeded", async () => {
  const dir = await tmpDir("retry-exhausted");
  try {
    const target = path.join(dir, "progress.md");
    let calls = 0;
    const rename = async () => { calls += 1; throw fsError("EPERM"); };
    await assert.rejects(
      () => atomicWriteFile(target, "hello", { rename, ...NO_DELAY }),
      (error) => { assert.equal(error.code, "EPERM"); return true; },
      "exhausting the retries must surface the original error",
    );
    assert.equal(calls, 1 + RENAME_RETRY_DELAYS_MS.length, "every attempt must have been made exactly once per delay slot");
    // 关键：不许留下"看起来写成功"的假象。
    await assert.rejects(() => fs.readFile(target, "utf8"), { code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a non-retryable error fails immediately without wasting retries", async () => {
  const dir = await tmpDir("non-retryable");
  try {
    const target = path.join(dir, "progress.md");
    let calls = 0;
    const rename = async () => { calls += 1; throw fsError("ENOENT"); };
    await assert.rejects(() => atomicWriteFile(target, "hello", { rename, ...NO_DELAY }), { code: "ENOENT" });
    assert.equal(calls, 1, "ENOENT is not transient: exactly one attempt");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("retryable and non-retryable codes are classified explicitly", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    assert.equal(isRetryableRenameError({ code }), true, `${code} is a transient Windows rename failure`);
  }
  for (const code of ["ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EROFS", "EEXIST", undefined]) {
    assert.equal(isRetryableRenameError({ code }), false, `${code} must not be retried`);
  }
});

test("the temp file is removed after the retries are exhausted, so no debris is left behind", async () => {
  const dir = await tmpDir("cleanup");
  try {
    const target = path.join(dir, "progress.md");
    const rename = async () => { throw fsError("EPERM"); };
    await assert.rejects(() => atomicWriteFile(target, "hello", { rename, ...NO_DELAY }));
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, [], "a failed atomic write must not leave .tmp debris");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a failing cleanup does not mask the original rename error", async () => {
  const dir = await tmpDir("cleanup-throws");
  try {
    const target = path.join(dir, "progress.md");
    const rename = async () => { throw fsError("EPERM"); };
    const unlink = async () => { throw fsError("EPERM", "unlink"); };
    await assert.rejects(
      () => atomicWriteFile(target, "hello", { rename, unlink, ...NO_DELAY }),
      (error) => { assert.equal(error.code, "EPERM"); assert.equal(error.syscall, "rename"); return true; },
      "the rename failure is the real story; cleanup must not replace it",
    );
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a successful write leaves exactly the target file and no temp file", async () => {
  const dir = await tmpDir("happy");
  try {
    const target = path.join(dir, "nested", "progress.md");
    await atomicWriteFile(target, "body\n");
    assert.equal(await fs.readFile(target, "utf8"), "body\n");
    assert.deepEqual((await fs.readdir(path.join(dir, "nested"))).sort(), ["progress.md"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("the mode option is honoured where the platform can express it", async (t) => {
  // 凭据/会话文件用 mode 0o600 写；helper 必须把这个权限透传给临时文件 —
  // 否则"先写 0644 再 rename"等于把权限放宽了。
  // ⚠️ Windows 上 POSIX 位不可表达（只有只读属性；实测 chmod 0o600 与 writeFile({mode}) 都得到 0666，
  //    只有去掉写位（0o400）才会反映成 0444）⇒ 该平台无法断言 0600，这是平台事实不是缺陷。
  const dir = await tmpDir("mode");
  try {
    const target = path.join(dir, "sessions.json");
    await atomicWriteFile(target, "{}\n", { mode: 0o600 });
    // 无论平台，写入都必须成功且内容正确。
    assert.equal(await fs.readFile(target, "utf8"), "{}\n");
    if (process.platform === "win32") {
      t.diagnostic("win32: POSIX mode bits are not representable; asserting write success only");
      return;
    }
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, 0o600, `expected 0600, got 0${(stat.mode & 0o777).toString(8)}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("the mode option is passed to the temp file open (verified by injection)", async () => {
  // 不依赖文件系统是否落实权限位：直接把 fs.open 换掉，断言 mode 真的传下去了。
  const dir = await tmpDir("mode-injected");
  try {
    const target = path.join(dir, "sessions.json");
    const seen = [];
    const open = async (file, flags, mode) => { seen.push({ file, flags, mode }); return fs.open(file, flags, mode); };
    await atomicWriteFile(target, "x", { mode: 0o600, open });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mode, 0o600, "the restrictive mode must reach the temp file creation");
    assert.equal(seen[0].flags, "w");
    assert.match(seen[0].file, /\.tmp$/u, "the mode applies to the temp file, not the target");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("renameWithRetry retries a transient failure when MOVING an existing file", async () => {
  // 归档那类场景是"把已存在的文件搬到别处"，没有临时文件这一步，但同样怕瞬时 EPERM。
  const dir = await tmpDir("rename-move");
  try {
    const source = path.join(dir, "a.md");
    const target = path.join(dir, "_legacy", "a.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "archived\n", "utf8");
    let calls = 0;
    const rename = async (from, to) => { calls += 1; if (calls === 1) throw fsError("EPERM"); return fs.rename(from, to); };
    await renameWithRetry(source, target, { rename, ...NO_DELAY });
    assert.equal(calls, 2);
    assert.equal(await fs.readFile(target, "utf8"), "archived\n");
    await assert.rejects(() => fs.readFile(source, "utf8"), { code: "ENOENT" }, "the source must be gone after a move");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("renameWithRetry surfaces the original error when the move never succeeds", async () => {
  const dir = await tmpDir("rename-move-fail");
  try {
    const source = path.join(dir, "a.md");
    const target = path.join(dir, "b.md");
    await fs.writeFile(source, "x", "utf8");
    let calls = 0;
    const rename = async () => { calls += 1; throw fsError("EBUSY"); };
    await assert.rejects(() => renameWithRetry(source, target, { rename, ...NO_DELAY }), { code: "EBUSY" });
    assert.equal(calls, 1 + RENAME_RETRY_DELAYS_MS.length);
    // 移动失败 ⇒ 源文件必须还在，不许"看起来搬走了"。
    assert.equal(await fs.readFile(source, "utf8"), "x");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("the retry budget is the documented one: 5 retries at 10/25/50/100/200ms", () => {
  assert.deepEqual(RENAME_RETRY_DELAYS_MS, [10, 25, 50, 100, 200]);
});

test("jitter keeps each delay within its slot and still makes progress", async () => {
  const dir = await tmpDir("jitter");
  try {
    const target = path.join(dir, "progress.md");
    const slept = [];
    let calls = 0;
    const rename = async (from, to) => { calls += 1; if (calls <= 3) throw fsError("EBUSY"); return fs.rename(from, to); };
    await atomicWriteFile(target, "x", { rename, retryDelaysMs: [10, 25, 50], jitter: 0.5, sleep: async (ms) => { slept.push(ms); } });
    assert.equal(calls, 4);
    assert.equal(slept.length, 3, "one sleep per retry");
    for (const [index, ms] of slept.entries()) {
      const base = [10, 25, 50][index];
      assert.ok(ms >= base && ms <= base * 2, `delay ${ms} must stay within [${base}, ${base * 2}]`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("EBUSY and EACCES are retried too, not just EPERM", async () => {
  for (const code of ["EBUSY", "EACCES"]) {
    const dir = await tmpDir(`code-${code}`);
    try {
      const target = path.join(dir, "progress.md");
      let calls = 0;
      const rename = async (from, to) => { calls += 1; if (calls === 1) throw fsError(code); return fs.rename(from, to); };
      await atomicWriteFile(target, "y", { rename, ...NO_DELAY });
      assert.equal(calls, 2, `${code} must be retried`);
      assert.equal(await fs.readFile(target, "utf8"), "y");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});
