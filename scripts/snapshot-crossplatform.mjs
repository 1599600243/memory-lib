#!/usr/bin/env node
/**
 * snapshot-crossplatform.mjs —— 每日记忆归档快照（**跨平台**：Windows / Linux 都能跑）
 *
 * 为什么有它：原来的 `snapshot.ps1` 只能在 Windows（计划任务 + PowerShell）跑，
 * 而 2026-10-13 决定"将来可能挂到服务器" ⇒ 归档这一环必须不绑平台。
 * 语义**逐条照搬** PowerShell 版（六条都是踩出来的，一条都不能丢）：
 *   ① 镜像来源，但**排除巨型日志**（runtime/audit、realtime.log）
 *   ② **超限闸**：镜像里出现 >95MB 的单个文件 ⇒ 拒绝推送并写明（否则 GitHub 100MB 上限会静默卡死）
 *   ③ 脱敏配置副本（API Key 绝不原样上云）
 *   ④ **按"待推提交数"推送**（不是"本轮有没有新提交"）——否则一次失败之后积压永远排不掉
 *   ⑤ **失败必响**：任何异常 ⇒ `FATAL …` + `=== snapshot FAILED ===` + 非零退出
 *   ⑥ 成功后写机器可读指纹 `.last-push.json`（**无 BOM**），供新鲜度看门人读
 *
 * 用法：
 *   node snapshot-crossplatform.mjs               # 真跑（镜像 + 提交 + 推送）
 *   node snapshot-crossplatform.mjs --dry-run     # 只算不写：列出会拷/会删什么，不动盘、不推
 *   node snapshot-crossplatform.mjs --config <file>
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const cfgIdx = args.indexOf("--config");
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1)));
const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : path.join(here, "snapshot.config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const LIVE = cfg.live;
const LOG = path.join(LIVE, "snapshot.log");
const STAMP = path.join(LIVE, cfg.stampFile ?? ".last-push.json");

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch {}
  console.log(line);
}
function git(argv, { allowFail = false } = {}) {
  try {
    const out = execFileSync("git", argv, { cwd: LIVE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { code: 0, out };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message);
    if (!allowFail) return { code: typeof e.status === "number" ? e.status : 1, out };
    return { code: typeof e.status === "number" ? e.status : 1, out };
  }
}
const norm = (p) => String(p).replaceAll("\\", "/");

/** 判断相对路径是否被排除（按目录名/相对目录前缀 + 文件名） */
function excluded(rel, spec) {
  const r = norm(rel);
  const parts = r.split("/");
  if (parts.some((seg) => (spec.excludeDirs ?? []).map(norm).includes(seg))) return true;
  for (const d of spec.excludeDirs ?? []) { const dd = norm(d); if (dd.includes("/") && (r === dd || r.startsWith(dd + "/"))) return true; }
  const base = parts[parts.length - 1];
  if ((spec.excludeFiles ?? []).includes(base)) return true;
  return false;
}

function walk(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const dir = path.join(root, rel);
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

/** 镜像一个来源（/MIR 语义：拷新增/改动，删目的地多余；排除项一律不碰） */
function mirror(spec, counters) {
  const src = spec.src;
  const dst = path.join(LIVE, spec.dst);
  if (!fs.existsSync(src)) { log(`SKIP missing source: ${src}`); return; }
  fs.mkdirSync(dst, { recursive: true });

  const srcFiles = walk(src).filter((r) => !excluded(r, spec));
  const srcSet = new Set(srcFiles);

  for (const rel of srcFiles) {
    const s = path.join(src, rel.split("/").join(path.sep));
    const d = path.join(dst, rel.split("/").join(path.sep));
    let need = true;
    try {
      const ds = fs.statSync(d);
      const ss = fs.statSync(s);
      need = ds.size !== ss.size || ss.mtimeMs > ds.mtimeMs + 1000;
    } catch { need = true; }
    if (!need) continue;
    counters.copied++;
    if (DRY) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    try { fs.utimesSync(d, fs.statSync(s).atime, fs.statSync(s).mtime); } catch {}
  }

  // 删除目的地多余文件（/MIR）；排除项与 .git 一律不碰
  for (const rel of walk(dst)) {
    if (srcSet.has(rel)) continue;
    if (excluded(rel, spec)) continue;
    counters.deleted++;
    log(`  DELETE (extra in archive) ${spec.dst}/${rel}`);
    if (!DRY) { try { fs.unlinkSync(path.join(dst, rel.split("/").join(path.sep))); } catch {} }
  }
}

/** ② 超限闸：镜像里不许有 >limit 的单文件（否则 GitHub 会拒收） */
function oversizedCheck() {
  const limit = (cfg.oversizeLimitMB ?? 95) * 1024 * 1024;
  const big = [];
  const stack = [LIVE];
  while (stack.length) {
    const cur = stack.pop();
    let es = [];
    try { es = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.name === ".git") continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { if (fs.statSync(full).size > limit) big.push(full); } catch {} }
    }
  }
  return big;
}

// ---------------------------------------------------------------- 主流程
log(`=== snapshot start${DRY ? " (dry-run)" : ""} ===`);
try {
  const backlog = git(["rev-list", "--count", "@{u}..HEAD"], { allowFail: true });
  log(`local backlog before run: ${backlog.code === 0 ? backlog.out : "(unable to compute: " + backlog.out.slice(0, 60) + ")"}`);

  const counters = { copied: 0, deleted: 0 };
  for (const spec of cfg.sources ?? []) mirror(spec, counters);
  log(`mirror done: copied=${counters.copied} deleted=${counters.deleted}${DRY ? " (dry-run: nothing written)" : ""}`);

  const big = oversizedCheck();
  if (big.length) {
    for (const f of big) log(`OVERSIZED ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  ${f}`);
    throw new Error(`oversized file(s) present in the archive; refusing to push (${big.length} file(s) over ${cfg.oversizeLimitMB} MB)`);
  }
  log(`oversize check: ok (limit ${cfg.oversizeLimitMB} MB)`);

  if (DRY) { log("=== snapshot done (dry-run) ==="); process.exit(0); }

  // ③ 脱敏
  const redact = path.join(LIVE, cfg.redactScript ?? "redact-openclaw.mjs");
  if (fs.existsSync(redact)) {
    try {
      const out = execFileSync(process.execPath, [redact], { cwd: LIVE, encoding: "utf8" });
      for (const l of out.trim().split(/\r?\n/u)) if (l.trim()) log(`  redact: ${l.trim()}`);
      log("  redact: exit=0");
    } catch (e) {
      log(`  redact: ${String(e.stdout ?? "").trim()}${String(e.stderr ?? "").trim()}`);
      throw new Error(`redaction self-check failed: ${String(e.message).slice(0, 120)}`);
    }
  } else {
    log(`  redact: SKIPPED (script not found: ${redact})`);
  }

  // ④ 提交（若有变化）+ 按积压推送
  const add = git(["add", "-A"], { allowFail: true });
  log(`  git add: exit=${add.code}`);
  const staged = git(["status", "--porcelain"]).out;
  if (staged) {
    const c = git(["-c", "user.name=memory-archive", "-c", "user.email=memory-archive@local", "commit", "-q", "-m", `daily snapshot ${new Date().toISOString().slice(0, 16).replace("T", " ")}`], { allowFail: true });
    log(`  git commit: exit=${c.code}${c.code !== 0 ? " :: " + c.out.slice(0, 160) : ""}`);
    if (c.code !== 0) throw new Error(`git commit failed exit=${c.code}`);
  } else {
    log("  no new changes to commit");
  }

  const pending = git(["rev-list", "--count", "@{u}..HEAD"], { allowFail: true });
  const pendingN = pending.code === 0 ? pending.out : "?";
  log(`commits pending push: ${pendingN}`);
  if (pendingN === "0") { log("nothing to push"); log("=== snapshot done (no-op) ==="); process.exit(0); }

  let pushCode = 1, pushOut = "";
  const attempts = cfg.maxPushAttempts ?? 2;
  for (let i = 1; i <= attempts; i++) {
    const p = git(["push", "origin", "HEAD"], { allowFail: true });
    pushCode = p.code; pushOut = p.out;
    for (const l of pushOut.split(/\r?\n/u)) if (l.trim()) log(`  git push (attempt ${i}): ${l.trim()}`);
    log(`  git push (attempt ${i}): exit=${pushCode}`);
    if (pushCode === 0) break;
    if (i < attempts) { log(`push attempt ${i} failed; retrying in ${Math.round((cfg.pushRetryDelayMs ?? 15000) / 1000)}s`); await new Promise((r) => setTimeout(r, cfg.pushRetryDelayMs ?? 15000)); }
  }
  // ⑤ 失败必响
  if (pushCode !== 0) throw new Error(`git push failed after ${attempts} attempts, exit=${pushCode}`);

  const sha = git(["rev-parse", "--short", "HEAD"]).out;
  log(`pushed ${sha}`);

  // ⑥ 指纹（无 BOM）
  const stamp = {
    at: new Date().toISOString(),
    sha,
    remote: git(["remote", "get-url", "origin"], { allowFail: true }).out,
    pending_before: backlog.code === 0 ? backlog.out : null,
    pending_after: git(["rev-list", "--count", "@{u}..HEAD"], { allowFail: true }).out,
    runner: "snapshot-crossplatform.mjs",
  };
  fs.writeFileSync(STAMP, JSON.stringify(stamp, null, 2) + "\n", { encoding: "utf8" }); // Node 不写 BOM
  log(`stamp written: ${STAMP}`);
  log("=== snapshot done ===");
  process.exit(0);
} catch (e) {
  log(`FATAL ${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 400)}`);
  log("=== snapshot FAILED ===");
  process.exit(1);
}
