#!/usr/bin/env node
// DAYRECALL-2 真值对照脚本。
//
// 目的：对任意一天 D，算出两个**互相独立**的集合，然后比对四个数：
//   A = 文件系统真值（本脚本自己走盘、自己解析 frontmatter、自己换算时区）
//   B = 按天查询返回的全部 id（走被测实现，翻页取全并对 total_count）
//   |A| / |B| / A\B（真值有而查询漏）/ B\A（查询多给）
//
// 独立性要求（这是本脚本存在的全部理由）：
//   - 解析 frontmatter：自己用正则切 `---` 段，**不 import** src/frontmatter-util.mjs
//   - 时区换算：自己用 Intl.DateTimeFormat.formatToParts，**不 import** src/time-util.mjs
//   - 走盘：自己 walk，**不 import** 库的 walkFiles
//   ⇒ 如果 B 用库、A 用库，两边同一个 bug 会互相印证成"通过"。这里刻意不共用一行代码。
//
// 用法：
//   node scripts/dayrecall2-truth-diff.mjs --data-root <root> --days 2026-10-10,2026-10-18 --timezone Asia/Shanghai
//   （可选 --json 只输出 JSON）
//   （可选 --truth-basis evidence|evidence+memories，默认 evidence+memories）
//
// 真值口径（REFINE-LOOP-2 产品裁决）：
//   evidence            A = 只有证据（历史口径；"那天有记忆"的日子 B\A 构造上不可能为 0）
//   evidence+memories   A′ = { 证据 | 事件日 == D } ∪ { 记忆 | 事件日 == D }   ← 默认
//                       "问某天，取回那天发生的对话**和**那天定下的事"。
//                       记忆的事件日 = 物化的 calendarDate；没有就按 capturedAt/occurred_at/valid_from
//                       推导，再没有才用 updated_at（并如实记下每条用了哪个依据）。
import fs from "node:fs/promises";
import path from "node:path";

// ---------- 参数 ----------
function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TRUTH_BASIS_VALUES = ["evidence", "evidence+memories"];
const dataRoot = flag("--data-root");
const timezone = flag("--timezone", "Asia/Shanghai");
const days = String(flag("--days", "")).split(",").map((d) => d.trim()).filter(Boolean);
const truthBasis = flag("--truth-basis", "evidence+memories");
const asJson = process.argv.includes("--json");
if (!dataRoot) { console.error("--data-root is required"); process.exit(2); }
if (days.length === 0) { console.error("--days is required (comma separated YYYY-MM-DD)"); process.exit(2); }
if (!TRUTH_BASIS_VALUES.includes(truthBasis)) {
  console.error(`--truth-basis must be one of: ${TRUTH_BASIS_VALUES.join(" | ")} (got ${JSON.stringify(truthBasis)})`);
  process.exit(2);
}

// 记忆层（按天查询会返回的正式记忆/知识文档所在的检索根）
const MEMORY_DIRS = ["curated", "project-state", "tools-memory", "plans", "profile", "evidence/documents"];
const INACTIVE_STATUS = ["deprecated", "deleted", "archived"];

// ---------- A：文件系统真值（自成一套实现） ----------

// 独立 frontmatter 解析：只取 --- 之间的 key: value 行。
async function readFrontmatter(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const out = {};
  for (const line of block.split(/\r?\n/u)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// 独立时区换算：把瞬时换算成指定时区下的日历日 YYYY-MM-DD。
const TZ_FMT = new Map();
function localDay(instantMs, zone) {
  let fmt = TZ_FMT.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    TZ_FMT.set(zone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(instantMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function walkMarkdown(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
    }
  }
  return out;
}

// A 的定义（写死在这里，与工单第三节字面一致）：
//   有 calendarDate ⇒ 用 calendarDate；
//   否则用 capturedAt 换算到 timezone 的日历日。
async function truthSet(day, { basis = "evidence" } = {}) {
  const root = path.join(dataRoot, "evidence", "conversations");
  const files = await walkMarkdown(root);
  const ids = new Set();
  const rows = [];
  let noTime = 0;
  for (const filePath of files) {
    const fm = await readFrontmatter(filePath);
    const id = fm.id || path.basename(filePath, ".md");
    let dayOfItem;
    if (fm.calendarDate) {
      dayOfItem = fm.calendarDate;
    } else {
      const ms = Date.parse(String(fm.capturedAt ?? fm.captured_at ?? ""));
      if (!Number.isFinite(ms)) { noTime += 1; continue; }
      dayOfItem = localDay(ms, timezone);
    }
    if (dayOfItem === day) { ids.add(id); rows.push({ id, file: path.basename(filePath), basis: fm.calendarDate ? "calendarDate" : "capturedAt", kind: "evidence" }); }
  }
  let memoriesScanned = 0;
  if (basis === "evidence+memories") {
    // A′：再加上"事件日 == D"的记忆（正式记忆 + 知识文档）。
    // 事件日口径（写死，独立于库实现）：
    //   ① 物化的 calendarDate（提炼/写入时按事件日物化，最直接）
    //   ② capturedAt → occurred_at → valid_from 换算到 timezone
    //   ③ 都没有才退回 updated_at（并单独计数，便于验收看出有多少条靠兜底）
    for (const dir of MEMORY_DIRS) {
      for (const filePath of await walkMarkdown(path.join(dataRoot, dir))) {
        const fm = await readFrontmatter(filePath);
        const status = String(fm.status ?? "active").trim().toLowerCase();
        if (INACTIVE_STATUS.includes(status)) continue;
        memoriesScanned += 1;
        const id = fm.id || path.basename(filePath, ".md");
        let dayOfItem = null;
        let why = null;
        if (fm.calendarDate && /^\d{4}-\d{2}-\d{2}$/.test(String(fm.calendarDate))) {
          dayOfItem = String(fm.calendarDate); why = "calendarDate";
        } else {
          for (const field of ["capturedAt", "captured_at", "occurred_at", "occurredAt", "valid_from", "validFrom"]) {
            const ms = Date.parse(String(fm[field] ?? ""));
            if (Number.isFinite(ms)) { dayOfItem = localDay(ms, timezone); why = field; break; }
          }
          if (dayOfItem === null) {
            for (const field of ["updated_at", "updatedAt"]) {
              const ms = Date.parse(String(fm[field] ?? ""));
              if (Number.isFinite(ms)) { dayOfItem = localDay(ms, timezone); why = `${field}(fallback)`; break; }
            }
          }
        }
        if (dayOfItem === day) { ids.add(id); rows.push({ id, file: path.relative(dataRoot, filePath), basis: why, kind: "memory" }); }
      }
    }
  }
  return { ids, rows, noTime, scanned: files.length, memoriesScanned };
}

// ---------- B：按天查询（走被测实现，翻页取全） ----------
async function querySet(day) {
  const { createMemoryLib } = await import("../src/memory-lib.mjs");
  // scopes: null = 不限制检索根（parity 模式）；不给 principal ⇒ 不做 principal 级过滤。
  // 数据根里**只有** evidence/conversations，所以 A 与 B 的宇宙是同一批文件。
  const lib = createMemoryLib({
    dataRoot,
    workspaceRoot: path.dirname(dataRoot),
    scopes: null,
    calendarTimezone: timezone,
    vectorLane: { probe: false },
  });
  const ids = new Set();
  const rows = [];
  let cursor = null;
  let total = null;
  let pages = 0;
  let requested = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await lib.timeline({ limit: 100, cursor, calendarDate: day, calendarTimezone: timezone });
    pages += 1;
    if (total === null) total = page.total_count;
    for (const item of page.results ?? []) { ids.add(String(item.id)); rows.push({ id: String(item.id), capturedAt: item.capturedAt, calendarDate: item.calendarDate ?? null }); }
    requested += (page.results ?? []).length;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { ids, rows, total, requested, pages };
}

// ---------- 比对 ----------
function diff(a, b) { return [...a].filter((x) => !b.has(x)).sort(); }

const report = { dataRoot, timezone, days: [] };
for (const day of days) {
  const A = await truthSet(day, { basis: truthBasis });
  const B = await querySet(day);
  const aMinusB = diff(A.ids, B.ids);
  const bMinusA = diff(B.ids, A.ids);
  report.days.push({
    day,
    "|A|": A.ids.size,
    "|B|": B.ids.size,
    total_count: B.total,
    pages: B.pages,
    "paged==total": B.requested === B.total,
    "A\\B": aMinusB.length,
    "B\\A": bMinusA.length,
    aMinusB,
    bMinusA,
    scannedFiles: A.scanned,
    filesWithoutTime: A.noTime,
    truthBasis,
    aBasis: Object.entries(A.rows.reduce((acc, r) => { const k = `${r.kind}:${r.basis}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {})).sort().reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
    aEvidence: A.rows.filter((r) => r.kind === "evidence").length,
    aMemories: A.rows.filter((r) => r.kind === "memory").length,
    memoriesScanned: A.memoriesScanned,
  });
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`dataRoot: ${report.dataRoot}`);
  console.log(`timezone: ${report.timezone}`);
  console.log(`truth-basis: ${truthBasis}${truthBasis === "evidence+memories" ? "	(A′ = 证据 + 事件日在当天的记忆)" : "	(A = 只有证据)"}`);
  for (const d of report.days) {
    console.log("");
    console.log(`=== ${d.day} ===`);
    console.log(`  |A${truthBasis === "evidence+memories" ? "′" : ""}| = ${d["|A|"]}   (证据 ${d.aEvidence} + 记忆 ${d.aMemories}；证据文件扫描 ${d.scannedFiles} 个、无时间戳 ${d.filesWithoutTime}、记忆文件扫描 ${d.memoriesScanned} 个)`);
    console.log(`       真值依据分布: ${JSON.stringify(d.aBasis)}`);
    console.log(`  |B| = ${d["|B|"]}   (total_count=${d.total_count}，翻 ${d.pages} 页，翻页取全=${d["paged==total"]})`);
    console.log(`  A\\B = ${d["A\\B"]}${d.aMinusB.length ? `  → ${d.aMinusB.join(", ")}` : ""}`);
    console.log(`  B\\A = ${d["B\\A"]}${d.bMinusA.length ? `  → ${d.bMinusA.join(", ")}` : ""}`);
    console.log(`  差集为空: ${d["A\\B"] === 0 && d["B\\A"] === 0 && d["|A|"] === d["|B|"] ? "YES" : "NO"}`);
  }
}

const allOk = report.days.every((d) => d["|A|"] === d["|B|"] && d["A\\B"] === 0 && d["B\\A"] === 0 && d["paged==total"]);
process.exitCode = allOk ? 0 : 1;
