import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "backfill-calendar-fields.mjs");

// 用 stdio: "inherit" + 文件重定向来驱动子进程，而不是管道。
// 在受限沙箱下，管道形式的 `spawnSync(..., { encoding })` 会以 `spawn EPERM` 失败
// （命名管道不可用），那是环境限制、不是交付物缺陷；inherit 形式在本机与沙箱下都成立。
// 因此本测试采集的是**子进程真实产物**：临时文件里的 stdout、去重后的 stderr 文件、退出码。
async function runCli(args, cwd) {
  const outFile = path.join(cwd, `cli-${Math.random().toString(36).slice(2)}.out`);
  const errFile = `${outFile}.err`;
  const handle = await fs.open(outFile, "w");
  const errHandle = await fs.open(errFile, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, stdio: ["ignore", handle.fd, errHandle.fd] });
  } finally {
    await handle.close();
    await errHandle.close();
  }
  const [stdout, stderr] = await Promise.all([fs.readFile(outFile, "utf8"), fs.readFile(errFile, "utf8")]);
  await fs.rm(outFile, { force: true });
  await fs.rm(errFile, { force: true });
  assert.equal(result.error, undefined, `cli spawn failed: ${result.error?.message}`);
  return { status: result.status, stdout, stderr };
}

async function fixture(label, files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `memory-lib-dayrecall-${label}-`));
  const dir = path.join(tmp, "evidence", "conversations");
  await fs.mkdir(dir, { recursive: true });
  const written = [];
  for (const [name, content] of files) {
    const file = path.join(dir, name);
    await fs.writeFile(file, content, "utf8");
    written.push(file);
  }
  return { tmp, files: written };
}

const LEGACY = "---\nid: legacy\ncapturedAt: 2026-10-10T23:30:00.000Z\n---\n\nConversation body only\n";

test("calendar backfill is dry-run by default and leaves the file byte-identical", async () => {
  const { tmp, files } = await fixture("backfill-dry", [["legacy.md", LEGACY]]);
  try {
    const before = await fs.readFile(files[0], "utf8");
    const dry = await runCli([tmp, "--timezone=America/Los_Angeles"], tmp);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).apply, false);
    assert.equal(JSON.parse(dry.stdout).changed, 1);
    assert.deepEqual(JSON.parse(dry.stdout).backups, []);
    assert.equal(await fs.readFile(files[0], "utf8"), before, "dry run must not write");
    await assert.rejects(() => fs.readFile(`${files[0]}.dayrecall-backup`, "utf8"), "dry run must not back up");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("calendar backfill --apply backs up, derives the local day, and keeps the body byte-identical", async () => {
  const { tmp, files } = await fixture("backfill-apply", [["legacy.md", LEGACY]]);
  try {
    const before = await fs.readFile(files[0], "utf8");
    const apply = await runCli([tmp, "--timezone=America/Los_Angeles", "--apply"], tmp);
    assert.equal(apply.status, 0, apply.stderr);
    const summary = JSON.parse(apply.stdout);
    assert.equal(summary.apply, true);
    assert.equal(summary.changed, 1);
    assert.deepEqual(summary.backups, [`${files[0]}.dayrecall-backup`]);

    const updated = await fs.readFile(files[0], "utf8");
    // 23:30Z on 10-10 is still 10-10 in Los Angeles (UTC-7) -- the derived day, not the UTC day.
    assert.match(updated, /^capturedAt: 2026-10-10T23:30:00\.000Z$/mu);
    assert.match(updated, /^calendarDate: 2026-10-10$/mu);
    assert.match(updated, /^calendarTimezone: "America\/Los_Angeles"$/mu);
    // The backup is the exact pre-apply bytes.
    assert.equal(await fs.readFile(`${files[0]}.dayrecall-backup`, "utf8"), before);
    // The conversation body is untouched -- dates must never enter the body.
    assert.equal(updated.slice(updated.indexOf("# ")), before.slice(before.indexOf("# ")));
    // No date variant leaked into the body text.
    assert.doesNotMatch(updated.slice(updated.indexOf("---", 3)), /calendarDate|calendarTimezone/u);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("calendar backfill is idempotent and derives the day from the zone, not from UTC", async () => {
  const { tmp, files } = await fixture("backfill-idempotent", [
    ["utc.md", LEGACY],
    ["sh.md", "---\nid: sh\ncapturedAt: 2026-10-09T23:30:00.000Z\n---\n\nSecond body\n"],
  ]);
  try {
    const first = await runCli([tmp, "--timezone=Asia/Shanghai", "--apply"], tmp);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).changed, 2);
    const afterFirst = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));

    // Running again must not rewrite, must not re-backup, and must not grow the file.
    const second = await runCli([tmp, "--timezone=Asia/Shanghai", "--apply"], tmp);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).changed, 0, "second apply must be a no-op");
    assert.deepEqual(JSON.parse(second.stdout).backups, []);
    const afterSecond = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
    assert.deepEqual(afterSecond, afterFirst);

    // 2026-10-09T23:30Z is 2026-10-10 07:30 in Asia/Shanghai.
    const sh = afterFirst[1];
    assert.match(sh, /^calendarDate: 2026-10-10$/mu);
    assert.match(sh, /^calendarTimezone: "Asia\/Shanghai"$/mu);
    // The UTC-but-materialized-as-UTC file gets corrected to the same query-timezone day.
    const utcFile = afterFirst[0];
    assert.match(utcFile, /^calendarDate: 2026-10-11$/mu, "2026-10-10T23:30Z is 2026-10-11 in Asia/Shanghai");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("an invalid timezone fails cleanly with exit 2 and writes nothing", async () => {
  const { tmp, files } = await fixture("backfill-bad-tz", [["legacy.md", LEGACY]]);
  try {
    const before = await fs.readFile(files[0], "utf8");
    const result = await runCli([tmp, "--timezone=Not/AZone", "--apply"], tmp);
    assert.equal(result.status, 2, `expected clean exit 2, got ${result.status}; stderr: ${result.stderr}`);
    assert.match(result.stderr, /invalid IANA timezone/u);
    assert.doesNotMatch(result.stderr, /RangeError/u, "must not crash with an unhandled RangeError");
    assert.equal(await fs.readFile(files[0], "utf8"), before);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("calendar backfill refuses to run without a data root", async () => {
  const { tmp } = await fixture("backfill-no-root", []);
  try {
    const result = await runCli([], tmp);
    assert.equal(result.status, 2, `expected clean exit 2, got ${result.status}`);
    assert.match(result.stderr, /usage:/u);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
