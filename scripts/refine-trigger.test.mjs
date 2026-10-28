/**
 * MAINPATH-2 提炼触发器单测。
 *
 * 覆盖的全是「不许破」的那几条：不阻塞、不并发、能关掉、失败不外抛。
 * 一条都不依赖真实模型 / 真实记忆服务 —— 子进程、时钟、spawn 全部注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MIN_INTERVAL_MS,
  GLOBAL_MIN_INTERVAL_MS,
  LOCK_STALE_MS,
  DEFAULT_LIMIT,
  emptyTriggerState,
  loadTriggerState,
  saveTriggerState,
  inspectLock,
  acquireLock,
  releaseLock,
  decideTrigger,
  countPendingFromState,
  countWorkload,
  countFreshEvidence,
  runRefineOnce,
  tailLog,
  maybeRefine,
  defaultPaths,
  parseRefineSwitch,
} from "./refine-trigger.mjs";

async function tmpdir(tag = "refine-trigger-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), tag));
}

/** 假时钟：让我能把 60 秒"按下去"而不用真等。 */
function makeClock(startMs = Date.parse("2026-10-19T02:00:00.000Z")) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/** 假 spawn：记录每次调用，立刻回报给定的退出结果。 */
function makeSpawnStub(results = [{ code: 0, signal: null }]) {
  const calls = [];
  let i = 0;
  const impl = (nodePath, args, options) => {
    calls.push({ nodePath, args, options });
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    const handlers = {};
    const child = {
      on(ev, fn) {
        handlers[ev] = fn;
        if (ev === "exit") {
          // 下一拍回调，模拟子进程随后退出
          setImmediate(() => fn(r.code, r.signal));
        }
        return child;
      },
      kill() {
        return true;
      },
    };
    return child;
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------
// ⑤ 开关：--refine=on|off
// ---------------------------------------------------------------------------

test("开关：--refine=off / =on / 空格形式 / 环境变量 / 缺省", () => {
  assert.equal(parseRefineSwitch(["--refine=off"], {}).value, false);
  assert.equal(parseRefineSwitch(["--refine=on"], {}).value, true);
  assert.equal(parseRefineSwitch(["--refine", "off"], {}).value, false);
  assert.equal(parseRefineSwitch(["--refine", "on"], {}).value, true);
  // 裸 --refine 视作打开
  assert.equal(parseRefineSwitch(["--refine"], {}).value, true);
  // 环境变量
  assert.equal(parseRefineSwitch([], { CAPTURE_PROXY_REFINE: "off" }).value, false);
  assert.equal(parseRefineSwitch([], { CAPTURE_PROXY_REFINE: "ON" }).value, true);
  // 缺省必须是 on（产品口径：默认开启，关掉才退回手动）
  const dflt = parseRefineSwitch([], {});
  assert.equal(dflt.value, true);
  assert.equal(dflt.raw, "default-on");
  // 命令行优先于环境变量
  assert.equal(parseRefineSwitch(["--refine=on"], { CAPTURE_PROXY_REFINE: "off" }).value, true);
});

// ---------------------------------------------------------------------------
// 决策（纯函数）：五个分支逐个钉死
// ---------------------------------------------------------------------------

test("决策：关掉时一律不触发，理由是手动模式", () => {
  const d = decideTrigger(emptyTriggerState(), { now: Date.parse("2026-10-19T02:00:00Z"), conversationId: "c1", enabled: false });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedBy, "disabled");
  assert.match(d.reason, /手动模式/);
});

test("决策：同一会话 60 秒内不重复触发，过了就放行", () => {
  const clock = makeClock();
  const state = emptyTriggerState();
  state.throttleByConversation["c1"] = new Date(clock.now()).toISOString();

  const tooSoon = decideTrigger(state, { now: clock.now() + 59_000, conversationId: "c1" });
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.blockedBy, "throttle-conversation");
  assert.match(tooSoon.reason, /59s 前/);

  const okNow = decideTrigger(state, { now: clock.now() + MIN_INTERVAL_MS, conversationId: "c1" });
  assert.equal(okNow.allowed, true);

  // 另一个会话不受 c1 的节流影响（但也没到全局门槛时可以过）
  const otherConv = decideTrigger(state, { now: clock.now() + 1_000, conversationId: "c2" });
  assert.equal(otherConv.allowed, true);
});

test("决策：全局 60 秒门槛对任何会话都生效", () => {
  const clock = makeClock();
  const state = emptyTriggerState();
  state.lastTriggerAt = new Date(clock.now()).toISOString();

  const d = decideTrigger(state, { now: clock.now() + 30_000, conversationId: "c9" });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedBy, "throttle-global");
  assert.match(d.reason, /30s 前/);

  const later = decideTrigger(state, { now: clock.now() + GLOBAL_MIN_INTERVAL_MS, conversationId: "c9" });
  assert.equal(later.allowed, true);
});

test("决策：锁被占着就不触发；锁过期（残留）则不再挡路", () => {
  const now = Date.parse("2026-10-19T02:00:00Z");
  const held = decideTrigger(emptyTriggerState(), { now, lock: { exists: true, stale: false, ageMs: 5_000 } });
  assert.equal(held.allowed, false);
  assert.equal(held.blockedBy, "lock");

  const stale = decideTrigger(emptyTriggerState(), { now, lock: { exists: true, stale: true, ageMs: LOCK_STALE_MS + 1 } });
  assert.equal(stale.allowed, true);
});

test("决策：没有待提炼的活就不该白起进程", () => {
  const d = decideTrigger(emptyTriggerState(), { now: Date.now(), pendingCount: 0 });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedBy, "no-pending");
  // pendingCount 未知（null）时不能误判成"没事干"
  assert.equal(decideTrigger(emptyTriggerState(), { now: Date.now(), pendingCount: null }).allowed, true);
});

// ---------------------------------------------------------------------------
// 锁：同一时刻最多 1 个提炼进程
// ---------------------------------------------------------------------------

test("锁：先到先得，第二个抢不到；放锁后可以再抢", async () => {
  const dir = await tmpdir();
  const lockFile = path.join(dir, "r.lock");
  try {
    const first = await acquireLock(lockFile, { now: 1000, pid: 111 });
    assert.equal(first.acquired, true);

    const second = await acquireLock(lockFile, { now: 2000, pid: 222 });
    assert.equal(second.acquired, false);
    assert.match(second.reason, /还在跑/);

    // 锁里记的是先到的那个 pid
    const seen = await inspectLock(lockFile, { now: 2000 });
    assert.equal(seen.exists, true);
    assert.equal(seen.pid, 111);
    assert.equal(seen.stale, false);

    await releaseLock(lockFile);
    const third = await acquireLock(lockFile, { now: 3000, pid: 333 });
    assert.equal(third.acquired, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("锁：进程被杀留下的过期锁会被强占，不会把线永久卡死", async () => {
  const dir = await tmpdir();
  const lockFile = path.join(dir, "r.lock");
  try {
    await fs.writeFile(lockFile, "999", "utf8");
    const old = new Date(Date.now() - (LOCK_STALE_MS + 60_000));
    await fs.utimes(lockFile, old, old);

    const seen = await inspectLock(lockFile, { now: Date.now() });
    assert.equal(seen.exists, true);
    assert.equal(seen.stale, true);

    const grabbed = await acquireLock(lockFile, { now: Date.now(), pid: 1000 });
    assert.equal(grabbed.acquired, true);
    assert.match(grabbed.reason, /过期锁/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 待提炼口径：必须和 refine-worker --status 一致
// ---------------------------------------------------------------------------

test("待提炼：缺 state 时 known=false（不能当成没事干），否则按状态分档", async () => {
  const dir = await tmpdir();
  try {
    const missing = await countPendingFromState(path.join(dir, "nope.json"));
    assert.equal(missing.known, false);
    assert.equal(missing.pending, null);

    const stateFile = path.join(dir, "refine-state.json");
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        evidence: {
          a: { status: "done" },
          b: { status: "skipped", reason: "skip-short(<120字)" },
          c: { status: "pending" },
          d: { status: "failed", reason: "boom" },
          e: { status: "dead", reason: "boom" },
        },
        last_success_at: "2026-10-19T01:00:00.000Z",
      }),
      "utf8",
    );
    const counts = await countPendingFromState(stateFile);
    assert.equal(counts.known, true);
    assert.equal(counts.done, 1);
    assert.equal(counts.skipped, 1);
    assert.equal(counts.failed, 1);
    assert.equal(counts.dead, 1);
    // 待办 = 还没 done 且不是明确跳过的：pending + failed + dead
    assert.equal(counts.pending, 3);
    assert.equal(counts.total, 5);
    assert.equal(counts.last_success_at, "2026-10-19T01:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("待提炼：证据目录里的新文件也能被数出来", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir, "old.md"), "x", "utf8");
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(path.join(dir, "old.md"), old, old);
    await fs.writeFile(path.join(dir, "new.md"), "y", "utf8");
    await fs.writeFile(path.join(dir, "ignore.txt"), "z", "utf8");

    assert.equal(await countFreshEvidence(dir, { sinceMs: 0 }), 2, "不设窗口时数全部 .md，不算 .txt");
    assert.equal(await countFreshEvidence(dir, { sinceMs: 600_000 }), 1, "十分钟窗口内只有 new.md");
    assert.equal(await countFreshEvidence(path.join(dir, "missing"), { sinceMs: 600_000 }), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 子进程运行器：真起进程（不是 stub），验证退出码 / 超时 / 日志落盘
// ---------------------------------------------------------------------------

test("运行器：退出码 0 = ok，非 0 = 失败，且都带回耗时", async () => {
  const dir = await tmpdir();
  try {
    const okWorker = path.join(dir, "ok.mjs");
    await fs.writeFile(okWorker, "process.stdout.write('done\\n');\n", "utf8");
    const logFile = path.join(dir, "ok.log");
    const ok = await runRefineOnce({ workerPath: okWorker, logFile, timeoutMs: 15_000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.code, 0);
    assert.equal(ok.timedOut, false);
    assert.equal(typeof ok.durationMs, "number");
    // 子进程 stdout 经文件描述符落进日志（不走管道）
    assert.match(await fs.readFile(logFile, "utf8"), /done/);

    const badWorker = path.join(dir, "bad.mjs");
    await fs.writeFile(badWorker, "process.stderr.write('bad key\\n'); process.exitCode = 7;\n", "utf8");
    const badLog = path.join(dir, "bad.log");
    const bad = await runRefineOnce({ workerPath: badWorker, logFile: badLog, timeoutMs: 15_000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 7);
    assert.match(bad.error, /退出码 7/);
    assert.match(await fs.readFile(badLog, "utf8"), /bad key/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("运行器：超时会被杀掉并如实报告，不会一直挂着", async () => {
  const dir = await tmpdir();
  try {
    const slow = path.join(dir, "slow.mjs");
    await fs.writeFile(slow, "setTimeout(() => {}, 30_000);\n", "utf8");
    const t0 = Date.now();
    const r = await runRefineOnce({ workerPath: slow, logFile: path.join(dir, "slow.log"), timeoutMs: 400 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.match(r.error, /超时/);
    assert.ok(elapsed < 10_000, `应当很快返回，实测 ${elapsed}ms`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("运行器：worker 路径不存在也不抛，只回报失败（fail-open 的底座）", async () => {
  const dir = await tmpdir();
  try {
    const r = await runRefineOnce({ workerPath: path.join(dir, "no-such-worker.mjs"), timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    // 子进程能起来但立刻以非 0 退出；关键是"不抛"
    assert.equal(typeof r.error, "string");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("运行器：worker 因自己的锁被占而跳过时，必须被识别成「没干活」而不是成功", async () => {
  const dir = await tmpdir();
  try {
    // 复刻 refine-worker 抢不到锁时的真实行为：打印那句话 + exit 0
    const lockedWorker = path.join(dir, "locked.mjs");
    await fs.writeFile(
      lockedWorker,
      "process.stdout.write('refine-worker: 上一轮还在跑（锁 2s 前建立），本轮跳过\\n');\nprocess.exit(0);\n",
      "utf8",
    );
    const logFile = path.join(dir, "locked.log");
    const r = await runRefineOnce({ workerPath: lockedWorker, logFile, timeoutMs: 15_000 });
    assert.equal(r.ok, true, "退出码确实是 0");
    assert.equal(r.skippedBecauseLocked, true, "但必须被标记成被锁跳过");

    // 反证：正常跑完的进程不许被误判成"被锁跳过"
    const normalWorker = path.join(dir, "normal.mjs");
    await fs.writeFile(normalWorker, "process.stdout.write('完成：处理 1 条证据\\n');\n", "utf8");
    const normalLog = path.join(dir, "normal.log");
    // 日志里预置一句历史锁提示，证明只看"本次新增"的片段
    await fs.writeFile(normalLog, "refine-worker: 上一轮还在跑（锁 9s 前建立），本轮跳过\n", "utf8");
    const r2 = await runRefineOnce({ workerPath: normalWorker, logFile: normalLog, timeoutMs: 15_000 });
    assert.equal(r2.ok, true);
    assert.equal(r2.skippedBecauseLocked, false, "历史日志里的旧提示不能影响本次判定");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：worker 被锁跳过时，状态里不许记成功", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");

    // 桩子进程：像真的 refine-worker 那样，把"上一轮还在跑"写进日志后 exit 0
    const spawnThatWritesLockNotice = () => {
      appendFileSync(h.paths.workerLogFile, "refine-worker: 上一轮还在跑（锁 2s 前建立），本轮跳过\n", "utf8");
      const handlers = {};
      const child = {
        on(ev, fn) {
          handlers[ev] = fn;
          if (ev === "exit") setImmediate(() => fn(0, null));
          return child;
        },
        kill() {
          return true;
        },
      };
      return child;
    };

    const r = await maybeRefine({ ...h.base, conversationId: "c1", spawnImpl: spawnThatWritesLockNotice });
    assert.equal(r.triggered, true);
    assert.equal(r.skippedBecauseLocked, true);
    assert.equal(r.ok, false, "被锁跳过不算成功");

    const saved = await loadTriggerState(h.paths.stateFile);
    assert.equal(saved.succeeded, 0, "不许记成功");
    assert.equal(saved.skippedByWorkerLock, 1);
    assert.equal(saved.lastSuccessAt, null, "更不许刷新 lastSuccessAt");
    assert.match(String(saved.lastReason), /跳过/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tailLog：取日志尾巴，文件不存在时返回空串", async () => {
  const dir = await tmpdir();
  try {
    const f = path.join(dir, "w.log");
    await fs.writeFile(f, Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n") + "\n", "utf8");
    const tail = await tailLog(f, { lines: 3 });
    assert.equal(tail, "line27\nline28\nline29");
    assert.equal(await tailLog(path.join(dir, "nope.log")), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 编排：这是代理真正会调的那一个
// ---------------------------------------------------------------------------

function makeHarness(dir, { clock, spawnResults, pendingCount = 3 } = {}) {
  const paths = {
    stateFile: path.join(dir, "refine-trigger-state.json"),
    lockFile: path.join(dir, "refine-trigger.lock"),
    workerLogFile: path.join(dir, "refine-worker.out.log"),
    logFile: path.join(dir, "refine-trigger.log"),
    refineStateFile: path.join(dir, "refine-state.json"),
  };
  const spawnStub = makeSpawnStub(spawnResults);
  const logs = [];

  // 预置一份 refine-state：pendingCount 条 pending
  const evidence = {};
  for (let i = 0; i < pendingCount; i += 1) evidence[`ev-${i}`] = { status: "pending" };

  const base = {
    ...paths,
    workerPath: path.join(dir, "worker-not-used.mjs"),
    limit: DEFAULT_LIMIT,
    now: clock.now,
    spawnImpl: spawnStub.impl,
    log: (rec) => logs.push(rec),
    timeoutMs: 10_000,
  };
  return { paths, spawnStub, logs, base, evidence };
}

test("编排：第一次有新证据 → 真的起进程，且带上 --limit", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");

    const r = await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(r.triggered, true);
    assert.equal(r.ok, true);
    assert.equal(h.spawnStub.calls.length, 1);
    const args = h.spawnStub.calls[0].args;
    assert.ok(args.includes("--limit"), "必须带 --limit");
    assert.equal(args[args.indexOf("--limit") + 1], String(DEFAULT_LIMIT));
    // --state 必须和"数待办用的那个文件"是同一个：否则会出现"在副本上跑、进度记进生产"
    assert.ok(args.includes("--state"), "必须带 --state");
    assert.equal(args[args.indexOf("--state") + 1], h.paths.refineStateFile, "--state 必须等于 refineStateFile");    // stdio 必须是"不用管道"的形态（沙箱下管道会 EPERM）
    assert.notEqual(h.spawnStub.calls[0].options.stdio, "pipe");
    assert.equal(h.spawnStub.calls[0].options.stdio[0], "ignore");

    const saved = await loadTriggerState(h.paths.stateFile);
    assert.equal(saved.triggered, 1);
    assert.equal(saved.succeeded, 1);
    assert.ok(saved.lastSuccessAt);
    assert.equal(saved.lastConversationId, "c1");
    // 锁必须已释放
    assert.equal((await inspectLock(h.paths.lockFile)).exists, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：--evidence 也必须按代理自己的证据目录传下去（否则会去读生产的证据）", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    const evidenceDir = path.join(dir, "evidence", "conversations");
    await fs.mkdir(evidenceDir, { recursive: true });
    // 证据目录与 state 的 id 必须对得上（真实世界里 state 的 key 就是证据 eventId）。
    // 这里磁盘只有 1 条、state 里没有它的记录 ⇒ 待办 = 1 - 0 = 1。
    await fs.writeFile(path.join(evidenceDir, "a.md"), "x", "utf8");
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: {} }), "utf8");

    const r = await maybeRefine({ ...h.base, conversationId: "c1", evidenceDir });
    assert.equal(r.triggered, true);
    const args = h.spawnStub.calls[0].args;
    assert.ok(args.includes("--evidence"), "必须带 --evidence");
    assert.equal(args[args.indexOf("--evidence") + 1], evidenceDir, "--evidence 必须等于传进来的证据目录");
    assert.equal(r.pending, 1, "待办口径 = 磁盘总数 - done - skipped - dead");

    // 反证：state 里若没有这条、又没传证据目录，就不该凭空知道有活
    const withoutDir = await maybeRefine({ ...h.base, conversationId: "c9" });
    assert.equal(withoutDir.triggered, false, "没有证据目录时退回 state 口径（此时 state 是空的）");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：全都提炼完了、也没有新证据时，不许每次对话都白起一次进程", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock, pendingCount: 0 });
    const evidenceDir = path.join(dir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    // 磁盘上 1 条 old.md、state 里它已经是 done ⇒ 待办 = 1 - 1 = 0
    // （state 的 key 必须与证据 id 对应，真实世界里就是 eventId）
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: { old: { status: "done" } } }), "utf8");
    const oldMd = path.join(evidenceDir, "old.md");
    await fs.writeFile(oldMd, "x", "utf8");
    const oldAt = new Date(clock.now() - 7_200_000); // 假时钟的两小时前
    await fs.utimes(oldMd, oldAt, oldAt);

    // 第一下：确认此刻没有活 ⇒ 不该起进程（这正是"别每次对话都白起一次"）
    const first = await maybeRefine({ ...h.base, conversationId: "c1", evidenceDir });
    assert.equal(first.blockedBy, "no-pending", `实际 ${first.blockedBy}`);
    assert.equal(h.spawnStub.calls.length, 0, "没有待办就不许起进程");

    // 真的来了一份新证据 ⇒ 立刻该触发
    clock.advance(61_000);
    const freshMd = path.join(evidenceDir, "fresh.md");
    await fs.writeFile(freshMd, "y", "utf8");
    const freshAt = new Date(clock.now() - 1_000);
    await fs.utimes(freshMd, freshAt, freshAt);
    const second = await maybeRefine({ ...h.base, conversationId: "c2", evidenceDir });
    assert.equal(second.triggered, true, "有新证据就必须触发");
    assert.equal(second.pending, 1, "待办 = 磁盘 2 - done 1");
    assert.equal(h.spawnStub.calls.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：60 秒内第二次不再触发（节流生效），过了 60 秒才再触发", async () => {  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");

    await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(h.spawnStub.calls.length, 1);

    clock.advance(30_000);
    const second = await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(second.triggered, false);
    assert.equal(second.blockedBy, "throttle-conversation");
    assert.equal(h.spawnStub.calls.length, 1, "节流期内不许再起进程");

    clock.advance(31_000); // 累计 61s
    const third = await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(third.triggered, true);
    assert.equal(h.spawnStub.calls.length, 2);

    const saved = await loadTriggerState(h.paths.stateFile);
    assert.ok(saved.skippedByThrottle >= 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：锁被别的进程占着时不重复起，且如实记账", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");
    await fs.writeFile(h.paths.lockFile, "4242", "utf8");

    const r = await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(r.triggered, false);
    assert.equal(r.blockedBy, "lock");
    assert.equal(h.spawnStub.calls.length, 0, "锁在别人手里就不许起进程");

    const saved = await loadTriggerState(h.paths.stateFile);
    assert.equal(saved.skippedByLock, 1);
    // 别人的锁不许被我删掉
    assert.equal((await inspectLock(h.paths.lockFile)).exists, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：没有待提炼时不白起进程", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock, pendingCount: 0 });
    await fs.writeFile(
      h.paths.refineStateFile,
      JSON.stringify({ evidence: { a: { status: "done" }, b: { status: "skipped" } } }),
      "utf8",
    );
    const r = await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(r.triggered, false);
    assert.equal(r.blockedBy, "no-pending");
    assert.equal(h.spawnStub.calls.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：提炼失败绝不外抛，只落日志与状态（对话侧无感）", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock, spawnResults: [{ code: 1, signal: null }] });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");
    await fs.writeFile(h.paths.workerLogFile, "refine-worker 失败：拿不到 DEEPSEEK_API_KEY\n", "utf8");

    const r = await maybeRefine({ ...h.base, conversationId: "c1" });
    assert.equal(r.triggered, true);
    assert.equal(r.ok, false);

    const saved = await loadTriggerState(h.paths.stateFile);
    assert.equal(saved.failed, 1);
    assert.equal(saved.succeeded, 0);
    assert.match(saved.lastError, /退出码 1/);
    assert.ok(saved.lastFailureAt);

    const failLog = h.logs.find((l) => l.event === "refine_failed");
    assert.ok(failLog, "失败必须落一条 refine_failed 日志");
    assert.match(String(failLog.workerLogTail), /DEEPSEEK_API_KEY/);

    // 失败也要放锁，否则一次异常把后续全堵死
    assert.equal((await inspectLock(h.paths.lockFile)).exists, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：spawn 本身抛错也不能外抛（fail-open 的最后一道）", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");

    const throwingSpawn = () => {
      const err = new Error("spawn EPERM");
      err.code = "EPERM";
      throw err;
    };
    const r = await maybeRefine({ ...h.base, conversationId: "c1", spawnImpl: throwingSpawn });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /EPERM|spawn 失败/);
    const saved = await loadTriggerState(h.paths.stateFile);
    assert.equal(saved.failed, 1);
    assert.equal((await inspectLock(h.paths.lockFile)).exists, false, "抛错路径也必须放锁");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：--refine=off 时连锁文件都不碰，状态记成手动模式", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");

    const r = await maybeRefine({ ...h.base, conversationId: "c1", enabled: false });
    assert.equal(r.triggered, false);
    assert.equal(r.blockedBy, "disabled");
    assert.equal(h.spawnStub.calls.length, 0);
    assert.equal((await inspectLock(h.paths.lockFile)).exists, false);

    const saved = await loadTriggerState(h.paths.stateFile);
    assert.equal(saved.enabled, false);
    assert.equal(saved.skippedByDisabled, 1);
    assert.equal(saved.triggered, 0);

    // 关掉以后即使有新证据、即使过了很久也不再触发
    clock.advance(3600_000);
    const again = await maybeRefine({ ...h.base, conversationId: "c1", enabled: false });
    assert.equal(again.triggered, false);
    assert.equal(h.spawnStub.calls.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("编排：并发 5 个请求只会产生 1 个提炼进程", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock });
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: h.evidence }), "utf8");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => maybeRefine({ ...h.base, conversationId: "c1" })),
    );
    assert.equal(h.spawnStub.calls.length, 1, "5 个并发请求只能起 1 个进程");
    assert.equal(results.filter((r) => r.triggered).length, 1);
    const nonTriggered = results.filter((r) => !r.triggered);
    assert.equal(nonTriggered.length, 4);
    for (const r of nonTriggered) {
      assert.ok(
        ["lock", "throttle-conversation", "throttle-global"].includes(r.blockedBy),
        `未触发的原因应当是锁/节流之一，实际 ${r.blockedBy}`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("defaultPaths：状态、锁、日志都落在同一处，状态命令与代理不会算两个地方", () => {
  const p = defaultPaths({ logDir: "D:\\x\\logs", stateFile: "D:\\x\\state\\refine-state.json" });
  assert.equal(p.triggerStateFile, path.join("D:\\x\\logs", "refine-trigger-state.json"));
  assert.equal(p.lockFile, path.join("D:\\x\\logs", "refine-trigger.lock"));
  assert.equal(p.workerLogFile, path.join("D:\\x\\logs", "refine-worker.out.log"));
  assert.equal(p.refineStateFile, "D:\\x\\state\\refine-state.json");
});

test("状态文件：坏了也不崩，损坏即回到空状态", async () => {
  const dir = await tmpdir();
  try {
    const f = path.join(dir, "s.json");
    await fs.writeFile(f, "{ not json", "utf8");
    const s = await loadTriggerState(f);
    assert.equal(s.triggered, 0);
    assert.deepEqual(s.throttleByConversation, {});

    await saveTriggerState(f, { ...s, triggered: 9 });
    const back = await loadTriggerState(f);
    assert.equal(back.triggered, 9);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("REFINE-LOOP-3 待办口径：磁盘上有、但 state 从没见过的证据也必须算待办", async () => {
  const dir = await tmpdir();
  try {
    const evidenceDir = path.join(dir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    // state 只知道其中 2 条（1 done + 1 skipped），另外 3 条从没进过 state
    for (let i = 0; i < 5; i += 1) await fs.writeFile(path.join(evidenceDir, `e${i}.md`), "x", "utf8");
    const stateFile = path.join(dir, "refine-state.json");
    await fs.writeFile(stateFile, JSON.stringify({ evidence: { e0: { status: "done" }, e1: { status: "skipped" } } }), "utf8");

    // 旧口径只看 state ⇒ 认为 0 条待办（错）
    const naive = await countPendingFromState(stateFile);
    assert.equal(naive.pending, 0, "这是旧口径的错读数，正是要修的");

    // 正确口径：磁盘 5 条 - 已 done 1 - 已 skipped 1 = 3 条待办
    const w = await countWorkload({ stateFile, evidenceDir });
    assert.equal(w.total, 5);
    assert.equal(w.pending, 3, `待办必须是 3，实际 ${w.pending}`);

    // failed 要算待办（还会重试）；dead 不算（已放弃）
    await fs.writeFile(
      stateFile,
      JSON.stringify({ evidence: { e0: { status: "done" }, e1: { status: "failed" }, e2: { status: "dead" } } }),
      "utf8",
    );
    const w2 = await countWorkload({ stateFile, evidenceDir });
    assert.equal(w2.pending, 3, "5 - done(1) - dead(1) = 3（其中含 1 条 failed 要重试）");

    // 没有 evidenceDir 时退回 state 口径（不能崩）。注意这个兜底口径会把 dead 也算进来
    // （countPendingFromState 的老口径 = pending + failed + dead），所以这里读数是 2 而不是 1。
    // 它只用于"拿不到证据目录"的降级场景；正常路径都用 countWorkload 的磁盘口径。
    const w3 = await countWorkload({ stateFile, evidenceDir: null });
    assert.equal(w3.known, true);
    assert.equal(w3.pending, 2, "state 兜底口径 = pending(0) + failed(1) + dead(1)");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("REFINE-LOOP-3 编排：state 里没有记录、但磁盘上有积压时，必须照样触发提炼", async () => {
  const dir = await tmpdir();
  try {
    const clock = makeClock();
    const h = makeHarness(dir, { clock, pendingCount: 0 });
    const evidenceDir = path.join(dir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    // 磁盘 4 条，state 只认识其中 1 条 done ⇒ 真实待办 3 条
    for (let i = 0; i < 4; i += 1) await fs.writeFile(path.join(evidenceDir, `e${i}.md`), "x", "utf8");
    await fs.writeFile(h.paths.refineStateFile, JSON.stringify({ evidence: { e0: { status: "done" } } }), "utf8");

    const r = await maybeRefine({ ...h.base, conversationId: "c1", evidenceDir });
    assert.equal(r.triggered, true, "有 3 条积压就必须触发，不许因为 state 里没有记录就说没活干");
    assert.ok(r.pending >= 3, `待办读数应当 >= 3，实际 ${r.pending}`);
    assert.equal(h.spawnStub.calls.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
