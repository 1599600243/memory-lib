// IN-PLUGIN-2：「注入回执」测试 —— 代理与插件共用一个文件的那种"只许一边注入"。
//
// 要成立的五件事：
//   ① 空回执 ⇒ 允许（不能因为文件还没建就永远不注入）
//   ② 插件：同一会话窗口内第二次 ⇒ throttle；换了会话 ⇒ 允许
//   ③ 插件看到代理刚注入过 ⇒ peer-window 让位；代理看到插件刚注入过 ⇒ peer-window 让位
//   ④ **两个真进程**同时认领，只有一个 allowed（锁是原子的）
//   ⑤ 写不进去 ⇒ fail-closed（宁愿这轮不注入，也不注入两次）
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_WINDOW_MS,
  SOURCE_PLUGIN,
  SOURCE_PROXY,
  claimReceipt,
  decideClaim,
  emptyReceipt,
  inspectReceipt,
  readReceipt,
  receiptAgeMs,
  resetReceipt,
} from "./inject-receipt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, "inject-receipt.mjs");

async function tmpReceipt(tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `injrcpt-${tag}-`));
  return { dir, file: path.join(dir, "inject-receipt.json") };
}

test("IN-PLUGIN-2 回执：空回执允许注入（文件还没建不算「被占用」）", async () => {
  const { dir, file } = await tmpReceipt("empty");
  try {
    assert.deepEqual(readReceipt(file), emptyReceipt());
    assert.equal(receiptAgeMs(readReceipt(file)), null);
    const r = claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "s1", chars: 640, ids: ["a", "b"] });
    assert.equal(r.allowed, true, "空回执应当允许");
    assert.equal(r.blockedBy, null);
    const after = readReceipt(file);
    assert.equal(after.last.source, SOURCE_PLUGIN);
    assert.equal(after.last.conversationId, "s1");
    assert.equal(after.last.chars, 640);
    assert.deepEqual(after.last.ids, ["a", "b"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-2 回执：插件同一会话第二次被节流，换会话放行", async () => {
  const { dir, file } = await tmpReceipt("throttle");
  try {
    const first = claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "s1", now: Date.now() });
    assert.equal(first.allowed, true);

    const again = claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "s1", now: Date.now() + 5_000 });
    assert.equal(again.allowed, false, "同一会话 5 秒内第二次必须挡下");
    assert.equal(again.blockedBy, "throttle");
    assert.match(again.reason, /同一会话/);

    const other = claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "s2", now: Date.now() + 5_000 });
    assert.equal(other.allowed, true, "别的会话不该被这个窗口挡住");
    assert.equal(readReceipt(file).last.conversationId, "s2");

    const later = claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "s2", now: Date.now() + 5_000 + DEFAULT_WINDOW_MS + 1_000 });
    assert.equal(later.allowed, true, "过了 60 秒窗口就该放行");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-2 回执：代理与插件互相让位（这就是「同一轮只注入一次」的机制）", async () => {
  const { dir, file } = await tmpReceipt("peer");
  try {
    // 插件先认领（真实时序：turn/start 早于请求转发）
    assert.equal(claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "session-dccc44aa" }).allowed, true);
    // 紧接着代理想注入同一轮
    const proxy = claimReceipt(file, { source: SOURCE_PROXY, conversationId: "hash-of-first-message" });
    assert.equal(proxy.allowed, false, "插件刚注入过，代理必须让位");
    assert.equal(proxy.blockedBy, "peer-window");
    assert.match(proxy.reason, /插件/);

    // 反过来：代理先（上一轮），插件这一轮
    const { dir: d2, file: f2 } = await tmpReceipt("peer2");
    try {
      assert.equal(claimReceipt(f2, { source: SOURCE_PROXY, conversationId: "h2" }).allowed, true);
      const plugin = claimReceipt(f2, { source: SOURCE_PLUGIN, conversationId: "session-x" });
      assert.equal(plugin.allowed, false, "代理刚注入过，插件必须让位");
      assert.equal(plugin.blockedBy, "peer-window");
      assert.match(plugin.reason, /代理/);
    } finally {
      await fs.rm(d2, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-2 回执：纯判定函数不碰文件（status 命令用它）", () => {
  const fresh = { version: 1, last: { at: new Date(1_000_000).toISOString(), source: SOURCE_PROXY, conversationId: "h", chars: 10, ids: [] }, updated_at: null };
  const now = 1_000_000 + 10_000;
  assert.equal(decideClaim(fresh, { source: SOURCE_PLUGIN, conversationId: "s", now }).blockedBy, "peer-window");
  assert.equal(decideClaim(fresh, { source: SOURCE_PROXY, conversationId: "h", now }).allow, true, "代理看到自己写的不算让位");
  const stale = { ...fresh, last: { ...fresh.last, at: new Date(now - 61_000).toISOString() } };
  assert.equal(decideClaim(stale, { source: SOURCE_PLUGIN, conversationId: "s", now }).allow, true);
});

test("IN-PLUGIN-2 回执：两个**独立进程**同时认领，只有一个能拿到", async () => {
  const { dir, file } = await tmpReceipt("race");
  const runner = path.join(dir, "runner.mjs");
  await fs.writeFile(
    runner,
    `import { claimReceipt } from ${JSON.stringify(new URL(`file:///${MODULE.replace(/\\/g, "/")}`).href)};
const r = claimReceipt(${JSON.stringify(file)}, { source: process.argv[2], conversationId: "same" });
process.stdout.write(JSON.stringify({ who: process.argv[2], allowed: r.allowed, blockedBy: r.blockedBy ?? null, reason: r.reason }) + "\\n");
`,
    "utf8",
  );
  const run = async (who, i) => {
    const outFile = path.join(dir, `out-${i}-${who}.txt`);
    const fd = await fs.open(outFile, "w");
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner, who], { stdio: ["ignore", fd.fd, fd.fd], windowsHide: true });
        child.on("error", reject);
        child.on("exit", resolve);
      });
      const out = await fs.readFile(outFile, "utf8");
      if (code !== 0) throw new Error(`runner ${who} 退出 ${code}: ${out}`);
      return JSON.parse(out.trim().split("\n").filter(Boolean).pop());
    } finally {
      await fd.close().catch(() => {});
    }
  };
  try {
    const results = await Promise.all([run(SOURCE_PLUGIN, 1), run(SOURCE_PROXY, 2), run(SOURCE_PLUGIN, 3)]);
    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, 1, `三个进程同时认领只许 1 个成功，实际 ${allowed}：${JSON.stringify(results)}`);
    const winners = results.filter((r) => r.allowed).map((r) => r.who);
    const receipt = readReceipt(file);
    assert.equal(receipt.last.conversationId, "same");
    assert.ok(winners.length === 1, `赢家只能有一个：${winners.join(",")}`);
    // 输家必须给出可读的原因，不能是静默
    for (const r of results.filter((x) => !x.allowed)) {
      assert.ok(["peer-window", "throttle", "receipt-busy"].includes(r.blockedBy), `输家原因不清楚：${JSON.stringify(r)}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-2 回执：写不进去就 fail-closed（宁可这轮不注入）", async () => {
  const { dir, file } = await tmpReceipt("io");
  try {
    // 把回执文件路径指到一个"父路径是文件"的地方 ⇒ mkdir/open 必然失败
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "not a dir", "utf8");
    const bad = path.join(blocker, "inject-receipt.json");
    const r = claimReceipt(bad, { source: SOURCE_PLUGIN, conversationId: "s" });
    assert.equal(r.allowed, false, "写不进去必须 fail-closed");
    assert.equal(r.blockedBy, "receipt-busy", "锁建不出来 ⇒ receipt-busy（宁可这轮不注入）");
    assert.match(r.reason, /不注入|锁/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-2 回执：残留的死锁会被接管，不把注入线永久卡死", async () => {
  const { dir, file } = await tmpReceipt("stale");
  try {
    const lock = `${file}.lock`;
    await fs.writeFile(lock, "99999", "utf8");
    const old = Date.now() - 10_000;
    await fs.utimes(lock, old / 1000, old / 1000);
    const r = claimReceipt(file, { source: SOURCE_PLUGIN, conversationId: "s" });
    assert.equal(r.allowed, true, "超过 2 秒的残留锁必须被接管");
    await assert.rejects(fs.access(lock), /ENOENT/, "认领完要把锁删掉");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("IN-PLUGIN-2 回执：inspectReceipt 只读（给 status.mjs）", async () => {
  const { dir, file } = await tmpReceipt("inspect");
  try {
    const empty = inspectReceipt(file);
    assert.equal(empty.open, true);
    assert.equal(empty.lastSource, null);
    claimReceipt(file, { source: SOURCE_PROXY, conversationId: "h9", chars: 77, ids: ["i1"] });
    const before = await fs.readFile(file, "utf8");
    const info = inspectReceipt(file);
    assert.equal(info.open, false);
    assert.equal(info.lastSource, SOURCE_PROXY);
    assert.equal(info.lastConversation, "h9");
    assert.equal(info.lastChars, 77);
    assert.deepEqual(info.lastIds, ["i1"]);
    assert.equal(await fs.readFile(file, "utf8"), before, "inspect 不许改文件");
    resetReceipt(file);
    assert.equal(inspectReceipt(file).open, true, "reset 后窗口重新打开");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
