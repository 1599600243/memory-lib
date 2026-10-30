#!/usr/bin/env node
// REFINE-LOOP-2 存量修复：把提炼记忆的**事件日/事件时刻**按 evidence_refs 回填。
//
// 背景：早先的提炼把 `occurred_at`/`valid_from` 写成了**提炼时刻**，且没有写 `calendarDate`，
// 于是问"某一天聊了什么"会把别的日子的事一起端上来（实测 2026-10-19 多返回 652 条）。
//
// 本脚本做且只做三件事（**只改 curated，绝不触碰 evidence**）：
//   calendarDate := 证据的事件日（证据的 calendarDate，否则 capturedAt 换算到本地日）
//   occurred_at  := 证据的事件时刻（capturedAt；缺失时用事件日当天零点）
//   valid_from   := 同上（与 occurred_at 同一事件轴）
// `updated_at` **原样保留**（那是记录轴：这条记忆什么时候被写/被改）。
//
// 可重复跑：已经正确的条目会被计入 `already`，不重写、不改 mtime。
//
// 用法：
//   node refine-backfill-event-dates.mjs                       # dry-run（默认，不写盘）
//   node refine-backfill-event-dates.mjs --apply               # 真写
//   node refine-backfill-event-dates.mjs --data-root <root> --timezone Asia/Shanghai --json
//   node refine-backfill-event-dates.mjs --restore [--apply]    # 回滚：还原成"回填前"的状态（见下）
//
// `--restore` 干什么（REFINE-LOOP-2 裁决第 4 条：迁移没留 per-file 备份，补一条可还原路径）：
//   回填前的三条字段是可以**推导回来**的，不需要逐文件备份：
//     · `updated_at` 当时 = 写入时刻 = `occurred_at` = `valid_from`（写入口用同一个 now() 填三者）；
//       而回填**没有动 `updated_at`**，所以它现在仍是"回填前的 occurred_at"。
//     · 回填**新加了** `calendarDate` 这一行（原文件没有），删掉这一行即还原。
//   ⇒ `--restore`：occurred_at := updated_at，valid_from := updated_at，删掉 calendarDate。
//   ⚠️ 它会把本单修掉的 bug（记忆挂到"提炼时刻"）退回来，**只在回滚时用**，别在生产常态化跑。
//   同样默认 dry-run、同样幂等（已经还原过的条目会计入 already）。
import fs from "node:fs/promises";
import path from "node:path";

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dataRoot = flag("--data-root", "D:\\MemoryLib\\data\\memory");
const timezone = flag("--timezone", "Asia/Shanghai");
const apply = process.argv.includes("--apply");
const restore = process.argv.includes("--restore");
const asJson = process.argv.includes("--json");

const unquote = (v) => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const TZ_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
function localDay(ms) { return TZ_FMT.format(new Date(ms)); }

// 某天在指定时区的零点 → ISO 瞬时（一次性偏移校正；与 refine-worker 的 zonedDayStartIso 同一算法）
function zonedDayStartIso(day) {
  if (!DAY.test(String(day ?? ""))) return null;
  const base = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(base));
  const g = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour === 24 ? 0 : g.hour, g.minute, g.second);
  return new Date(base - (asUtc - base)).toISOString();
}

// --- frontmatter 解析/重写（行级，尽量保住原有顺序与写法） ---
function splitFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
  if (!m) return null;
  return { block: m[1], rest: String(text).slice(m[0].length), eol: /\r\n/.test(m[0]) ? "\r\n" : "\n" };
}
function parseLines(block) {
  return block.split(/\r?\n/).map((line) => {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u);
    return kv ? { key: kv[1], value: kv[2].trim(), line } : { key: null, line };
  });
}
function rewriteFrontmatter(block, eol, updates) {
  const lines = parseLines(block);
  const seen = new Set();
  const out = [];
  for (const entry of lines) {
    if (entry.key && Object.hasOwn(updates, entry.key)) {
      out.push(`${entry.key}: ${JSON.stringify(updates[entry.key])}`);
      seen.add(entry.key);
      continue;
    }
    out.push(entry.line);
    if (entry.key === "valid_to" && Object.hasOwn(updates, "calendarDate") && !seen.has("calendarDate")) {
      out.push(`calendarDate: ${JSON.stringify(updates.calendarDate)}`);
      seen.add("calendarDate");
    }
  }
  // 没有 valid_to 行时，挂在 occurred_at 后面；再不行就追加到末尾
  if (Object.hasOwn(updates, "calendarDate") && !seen.has("calendarDate")) {
    const at = out.findIndex((l) => /^occurred_at\s*:/u.test(l));
    if (at >= 0) out.splice(at + 1, 0, `calendarDate: ${JSON.stringify(updates.calendarDate)}`);
    else out.push(`calendarDate: ${JSON.stringify(updates.calendarDate)}`);
  }
  return out.join(eol);
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

// --- 证据索引（eventId 与文件 id 双键，与巡检同一口径） ---
const evDir = path.join(dataRoot, "evidence", "conversations");const byRef = new Map();
for (const name of (await fs.readdir(evDir).catch(() => [])).filter((n) => n.endsWith(".md"))) {
  const text = await fs.readFile(path.join(evDir, name), "utf8");
  const parts = splitFrontmatter(text);
  if (!parts) continue;
  const fm = Object.fromEntries(parseLines(parts.block).filter((e) => e.key).map((e) => [e.key, unquote(e.value)]));
  const id = fm.id || path.basename(name, ".md");
  const capturedAt = fm.capturedAt || fm.captured_at || "";
  const calendarDate = DAY.test(fm.calendarDate || "") ? fm.calendarDate : (Number.isFinite(Date.parse(capturedAt)) ? localDay(Date.parse(capturedAt)) : null);
  const instantMs = Date.parse(capturedAt);
  const eventInstant = Number.isFinite(instantMs) ? new Date(instantMs).toISOString() : zonedDayStartIso(calendarDate);
  const rec = { id, calendarDate, eventInstant, evidenceFile: name };
  byRef.set(id, rec);
  if (fm.eventId) byRef.set(fm.eventId, rec);
}

// --- 逐条记忆比对 ---
const stats = { evidenceIndexed: byRef.size, scanned: 0, refined: 0, resolved: 0, unresolved: 0, already: 0, changed: 0, wouldChange: 0, failed: 0 };
const changes = [];
const unresolved = [];
const curatedDir = path.join(dataRoot, "curated");

// ===== 回滚模式（--restore）：把回填改过的三条字段还原成"回填前" =====
// updated_at 在回填中从未被改，所以它仍然是"回填前的 occurred_at/valid_from"；
// calendarDate 是回填新加的行，删掉即还原。
if (restore) {
  const removed = [];
  const restoreStats = { scanned: 0, refined: 0, already: 0, changed: 0, wouldChange: 0, failed: 0 };
  for (const file of await walk(curatedDir)) {
    restoreStats.scanned += 1;
    const raw = await fs.readFile(file, "utf8");
    const parts = splitFrontmatter(raw);
    if (!parts) continue;
    const fm = Object.fromEntries(parseLines(parts.block).filter((e) => e.key).map((e) => [e.key, unquote(e.value)]));
    if (!String(fm.tags ?? "").includes("refined")) continue;
    restoreStats.refined += 1;
    const stamp = unquote(fm.updated_at);
    if (!Number.isFinite(Date.parse(stamp))) { restoreStats.failed += 1; continue; }
    const alreadyRestored = unquote(fm.occurred_at) === stamp && unquote(fm.valid_from) === stamp && !fm.calendarDate;
    if (alreadyRestored) { restoreStats.already += 1; continue; }
    if (!apply) { restoreStats.wouldChange += 1; if (removed.length < 5) removed.push({ file: path.relative(dataRoot, file), set: { occurred_at: stamp, valid_from: stamp, calendarDate: null } }); continue; }
    const restoredBlock = parseLines(parts.block)
      .filter((e) => e.key !== "calendarDate")                        // 删掉回填新加的那一行
      .map((e) => (e.key === "occurred_at" || e.key === "valid_from") ? `${e.key}: ${JSON.stringify(stamp)}` : e.line)
      .join(parts.eol);
    const next = `---${parts.eol}${restoredBlock}${parts.eol}---${parts.eol}${parts.rest}`;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, next, "utf8");
      await fs.rename(tmp, file);
      restoreStats.changed += 1;
      if (removed.length < 5) removed.push({ file: path.relative(dataRoot, file), set: { occurred_at: stamp, valid_from: stamp, calendarDate: null } });
    } catch (error) {
      restoreStats.failed += 1;
      await fs.rm(tmp, { force: true }).catch(() => {});
      unresolved.push({ file: path.relative(dataRoot, file), error: error.message });
    }
  }
  const out = { dataRoot, timezone, mode: apply ? "restore-apply" : "restore-dry-run", ...restoreStats, samples: removed, unresolved: unresolved.slice(0, 5) };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`dataRoot: ${dataRoot}   模式: ${out.mode}   （把 occurred_at/valid_from 还原为 updated_at，并删除 calendarDate）`);
    console.log(`  扫到记忆 ${restoreStats.scanned} 条，其中提炼记忆 ${restoreStats.refined} 条`);
    console.log(`  已经处于"回填前"形态: ${restoreStats.already}`);
    console.log(`  ${apply ? "已还原" : "将被还原（dry-run 未写盘）"}: ${apply ? restoreStats.changed : restoreStats.wouldChange}    失败: ${restoreStats.failed}`);
    for (const s of removed) console.log(`  样例: ${s.file} → ${JSON.stringify(s.set)}`);
    if (unresolved.length) for (const u of unresolved) console.log(`  失败/未处理: ${u.file} ${u.error ?? ""}`);
  }
  process.exitCode = restoreStats.failed > 0 ? 1 : 0;
  process.exit(process.exitCode ?? 0);
}

for (const file of await walk(curatedDir)) {
  stats.scanned += 1;
  const raw = await fs.readFile(file, "utf8");
  const parts = splitFrontmatter(raw);
  if (!parts) continue;
  const entries = parseLines(parts.block).filter((e) => e.key);
  const fm = Object.fromEntries(entries.map((e) => [e.key, unquote(e.value)]));
  if (!String(fm.tags ?? "").includes("refined")) continue;
  stats.refined += 1;

  let refs = [];
  try { const p = JSON.parse(String(fm.evidence_refs ?? "")); refs = Array.isArray(p) ? p.map(unquote) : []; } catch { refs = []; }
  const ev = refs.map((r) => byRef.get(r)).find(Boolean);
  if (!ev || !ev.calendarDate || !ev.eventInstant) {
    stats.unresolved += 1;
    unresolved.push({ file: path.relative(dataRoot, file), refs: refs.slice(0, 2) });
    continue;
  }
  stats.resolved += 1;

  const want = { calendarDate: ev.calendarDate, occurred_at: ev.eventInstant, valid_from: ev.eventInstant };
  const need = {};
  for (const [key, value] of Object.entries(want)) {
    const cur = key === "calendarDate" ? fm.calendarDate : unquote(fm[key]);
    if (cur !== value) need[key] = value;
  }
  if (Object.keys(need).length === 0) { stats.already += 1; continue; }

  if (apply) {
    const block = rewriteFrontmatter(parts.block, parts.eol, need);
    const next = `---${parts.eol}${block}${parts.eol}---${parts.eol}${parts.rest}`;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, next, "utf8");
      await fs.rename(tmp, file);
      stats.changed += 1;
      changes.push({ file: path.relative(dataRoot, file), set: need });
    } catch (error) {
      stats.failed += 1;
      await fs.rm(tmp, { force: true }).catch(() => {});
      unresolved.push({ file: path.relative(dataRoot, file), error: error.message });
    }
  } else {
    stats.wouldChange += 1;
    changes.push({ file: path.relative(dataRoot, file), set: need });
  }
}

// --- 自检：after 状态下还有多少条"事件日对不上"（apply 后应为 0） ---
let remainingWrong = null;
if (apply) {
  remainingWrong = 0;
  for (const file of await walk(curatedDir)) {
    const raw = await fs.readFile(file, "utf8");
    const parts = splitFrontmatter(raw);
    if (!parts) continue;
    const fm = Object.fromEntries(parseLines(parts.block).filter((e) => e.key).map((e) => [e.key, unquote(e.value)]));
    if (!String(fm.tags ?? "").includes("refined")) continue;
    let refs = [];
    try { const p = JSON.parse(String(fm.evidence_refs ?? "")); refs = Array.isArray(p) ? p.map(unquote) : []; } catch { refs = []; }
    const ev = refs.map((r) => byRef.get(r)).find(Boolean);
    if (!ev) continue;
    if (fm.calendarDate !== ev.calendarDate || unquote(fm.occurred_at) !== ev.eventInstant || unquote(fm.valid_from) !== ev.eventInstant) remainingWrong += 1;
  }
}

const report = { dataRoot, timezone, mode: apply ? "apply" : "dry-run", ...stats, remainingWrong, changes: changes.slice(0, 5), unresolved: unresolved.slice(0, 5) };
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`dataRoot: ${dataRoot}   时区: ${timezone}   模式: ${report.mode}`);
  console.log(`证据索引 ${stats.evidenceIndexed} 个标识（id + eventId 双键）`);
  console.log(`扫到记忆 ${stats.scanned} 条，其中提炼记忆 ${stats.refined} 条`);
  console.log(`  能按 evidence_refs 定位证据: ${stats.resolved}    定位不到: ${stats.unresolved}`);
  console.log(`  已经正确（跳过）: ${stats.already}`);
  console.log(`  ${apply ? "已回填" : "需要回填（dry-run 未写盘）"}: ${apply ? stats.changed : stats.wouldChange}`);
  if (apply) console.log(`  失败: ${stats.failed}    回填后仍不一致: ${remainingWrong}`);
  if (changes.length) {
    console.log("\n样例：");
    for (const c of changes) console.log(`  ${c.file} → ${JSON.stringify(c.set)}`);
  }
  if (unresolved.length) {
    console.log("\n定位不到证据的（未处理）：");
    for (const u of unresolved) console.log(`  ${u.file}  refs=${JSON.stringify(u.refs ?? null)} ${u.error ?? ""}`);
  }
}
process.exitCode = stats.failed > 0 ? 1 : 0;
